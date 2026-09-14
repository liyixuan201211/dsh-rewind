/**
 * Comparing two manifests, and turning "go back to that one" into an explicit,
 * inspectable list of filesystem steps.
 *
 * This module does no I/O on the tree. It decides what *would* happen, so the
 * same plan can be printed for a human, refused for a reason, or applied. Every
 * dangerous decision lives here where it can be read in one sitting.
 *
 * The two rules that matter:
 *
 *   * **Nothing is removed recursively.** A deletion step names one file, or
 *     names a directory that is only removed if it is already empty. A
 *     `node_modules/` inside a directory that a snapshot never captured survives
 *     the rewind, because the plan never contained a step that could remove it.
 *   * **A path whose bytes were never captured is protected.** If a file was too
 *     large or unreadable at snapshot time it is recorded as an `x` entry, and
 *     removing it during an undo is refused — the store cannot put it back.
 */
import { isExcluded, unsafePath } from "./config.js";
import { sameEntry } from "./scan.js";
import { depth } from "./util.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./types.js").Entry} Entry */
/** @typedef {import("./types.js").Manifest} Manifest */

/**
 * @typedef {object} Change
 * @property {string} path
 * @property {"add" | "remove" | "modify"} change
 * @property {Entry} [from] entry in the base manifest
 * @property {Entry} [to]   entry in the target manifest
 */

/**
 * @typedef {object} Step
 * @property {string} path
 * @property {"delete-file" | "delete-link" | "rmdir" | "mkdir" | "write" | "symlink"} action
 * @property {Entry} [live]
 * @property {Entry} [target]
 */

/**
 * @typedef {object} Refusal
 * @property {string} path
 * @property {string} why
 */

/**
 * @typedef {object} PlanSummary
 * @property {number} restore
 * @property {number} remove
 * @property {number} mkdir
 * @property {number} rmdir
 * @property {number} unchanged
 */

/**
 * @typedef {object} UndoPlan
 * @property {Step[]} steps          in apply order
 * @property {Refusal[]} refusals    non-empty means nothing may be applied
 * @property {{ path: string, why: string }[]} unrestorable
 * @property {PlanSummary} summary
 */

/**
 * Every path present in one manifest or the other, described as a change.
 *
 * @param {Manifest} base
 * @param {Manifest} target
 * @returns {Change[]}
 */
export function compareEntries(base, target) {
  /** @type {Change[]} */
  const changes = [];
  const paths = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const p of [...paths].sort()) {
    const a = base[p];
    const b = target[p];
    if (a !== undefined && b === undefined) changes.push({ path: p, change: "remove", from: a });
    else if (a === undefined && b !== undefined) changes.push({ path: p, change: "add", to: b });
    else if (a !== undefined && b !== undefined && !sameEntry(a, b)) {
      changes.push({ path: p, change: "modify", from: a, to: b });
    }
  }
  return changes;
}

/**
 * Sanity-check a manifest read from the store before acting on it.
 *
 * A manifest is JSON in a directory that anything could have edited, and it
 * makes exactly one structural promise: a path's ancestors are all recorded, and
 * all of them are directories. A scan always satisfies this. Anything else is
 * malformed, and the two ways it matters are both refusals rather than repairs:
 *
 *   * `a` as a file and `a/b` as a file — applying it fails half-way with
 *     ENOTDIR, leaving the tree in neither state.
 *   * `a/b` with no `a` at all — no directory step is planned, so the write has
 *     nowhere to land; and if `a` happens to be a symlink in the live tree,
 *     "nowhere to land" is the only reason nothing escapes the root. A missing
 *     parent is refused rather than created on the fly, so that the guarantee
 *     does not depend on that accident.
 *
 * Refusing up front is what keeps an undo atomic in the sense that matters: all
 * of it, or none of it.
 *
 * @param {Manifest} manifest
 * @returns {Refusal[]}
 */
export function checkManifest(manifest) {
  /** @type {Refusal[]} */
  const problems = [];
  const paths = Object.keys(manifest).sort();

  for (const p of paths) {
    const entry = manifest[p];
    if (entry === undefined) continue;

    const unsafe = unsafePath(p);
    if (unsafe !== null) {
      problems.push({ path: p, why: `unsafe path: ${unsafe}` });
      continue;
    }

    const segments = p.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      const parent = segments.slice(0, i).join("/");
      const parentEntry = manifest[parent];
      if (parentEntry === undefined) {
        problems.push({ path: p, why: `"${parent}" is missing from the manifest` });
        break;
      }
      if (parentEntry.t !== "d") {
        problems.push({
          path: p,
          why:
            parentEntry.t === "l"
              ? `"${parent}" is a symlink but is also a parent directory`
              : `"${parent}" is a file but is also a parent directory`,
        });
        break;
      }
    }
  }

  return problems;
}

/**
 * Build the step list that turns `live` into `target`.
 *
 * @param {Config} cfg
 * @param {Manifest} live   the tree as it is on disk right now
 * @param {Manifest} target the manifest of the snapshot being restored
 * @param {object} [opts]
 * @param {boolean} [opts.force] allow removing paths whose contents were never captured
 * @returns {UndoPlan}
 */
export function planUndo(cfg, live, target, opts = {}) {
  const force = opts.force ?? false;

  /** @type {Step[]} */
  const deletes = [];
  /** @type {Step[]} */
  const mkdirs = [];
  /** @type {Step[]} */
  const writes = [];
  /** @type {Refusal[]} */
  const refusals = checkManifest(target);
  /** @type {{ path: string, why: string }[]} */
  const unrestorable = [];
  const summary = { restore: 0, remove: 0, mkdir: 0, rmdir: 0, unchanged: 0 };

  // Live paths that the target does not have, or has as something else.
  for (const [p, entry] of Object.entries(live)) {
    if (isExcluded(cfg, p, entry.t === "d")) continue;
    const wanted = target[p];
    if (wanted !== undefined && sameEntry(entry, wanted)) {
      summary.unchanged += 1;
      continue;
    }

    // The snapshot says "something was here and I did not save it". What is
    // there now may be that very file. Deleting it would destroy the only copy
    // of something the store cannot put back, so the whole undo is refused —
    // which is also why the store persists its capture policy (see config.js):
    // this branch should be rare, and it must never be reached by accident.
    if (wanted !== undefined && wanted.t === "x" && !force) {
      refusals.push({
        path: p,
        why:
          `the snapshot recorded this path but never captured its contents (${wanted.why}),` +
          ` so what is there now cannot be restored if it is removed — pass --force to remove it`,
      });
      continue;
    }

    // The same kind of thing at the same path is a *modification*, and the
    // restore step below handles it. Deleting it first would destroy the file
    // whenever that restore then failed — a corrupt object, a permission error —
    // which is the single outcome an undo must never produce. It also keeps the
    // plan honest: "modified" is not "removed and recreated".
    if (wanted !== undefined && wanted.t === entry.t) continue;

    // Present now, absent (or a different kind) in the target: it goes.
    if (entry.t === "d") {
      deletes.push({ path: p, action: "rmdir", live: entry });
      summary.rmdir += 1;
      continue;
    }
    if (entry.t === "x" && !force) {
      refusals.push({
        path: p,
        why:
          `contents were never captured (${entry.why}), so removing it could not be undone` +
          ` — pass --force to remove it anyway`,
      });
      continue;
    }
    if (entry.t === "l") {
      deletes.push({ path: p, action: "delete-link", live: entry });
    } else {
      deletes.push({ path: p, action: "delete-file", live: entry });
    }
    summary.remove += 1;
  }

  // Everything the target wants to exist.
  for (const [p, entry] of Object.entries(target)) {
    const isDir = entry.t === "d";
    if (isExcluded(cfg, p, isDir)) continue;
    const now = live[p];
    if (now !== undefined && sameEntry(now, entry)) continue;

    if (entry.t === "x") {
      unrestorable.push({
        path: p,
        why: `not in the store (${entry.why}${entry.s === undefined ? "" : `, ${entry.s} bytes`})`,
      });
      continue;
    }
    if (entry.t === "d") {
      mkdirs.push({ path: p, action: "mkdir", target: entry });
      summary.mkdir += 1;
      continue;
    }
    writes.push({ path: p, action: entry.t === "l" ? "symlink" : "write", target: entry });
    summary.restore += 1;
  }

  // Deepest first when removing, so a directory is empty by the time its own
  // rmdir is attempted; shallowest first when creating, so a parent exists.
  deletes.sort((a, b) => depth(b.path) - depth(a.path) || (a.path < b.path ? 1 : -1));
  mkdirs.sort((a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : 1));
  writes.sort((a, b) => (a.path < b.path ? -1 : 1));

  return {
    steps: [...deletes, ...mkdirs, ...writes],
    refusals,
    unrestorable,
    summary,
  };
}

/**
 * Is there anything to do at all?
 *
 * @param {UndoPlan} plan
 * @returns {boolean}
 */
export function isNoop(plan) {
  return plan.steps.length === 0;
}
