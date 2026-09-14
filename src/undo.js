/**
 * Applying an undo.
 *
 * The ordering below is the whole safety story, and it is deliberate:
 *
 *   1. **Preflight.** Every object the plan needs is read-checked *before* the
 *      first write. A missing or corrupt object turns into a refusal and the
 *      tree is left exactly as it was — an undo that stops halfway is worse than
 *      no undo, because now there are two broken states to reason about.
 *   2. **Snapshot the present.** The state being replaced is captured first, so
 *      the undo is itself undoable. This is the property that makes the tool
 *      safe to reach for in a panic.
 *   3. **Delete, then create.** Removals happen deepest-first and are never
 *      recursive; creations happen shallowest-first.
 *   4. **Write atomically.** Content lands in a sibling temp file and is renamed
 *      into place, so an interrupted undo never leaves a half-written file where
 *      a real one used to be.
 */
import { chmod, mkdir, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { planUndo } from "./plan.js";
import { recordExistingManifest } from "./snapshot.js";
import { scanTree } from "./scan.js";
import { randomSuffix } from "./util.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./types.js").Manifest} Manifest */
/** @typedef {import("./types.js").Snapshot} Snapshot */
/** @typedef {import("./plan.js").UndoPlan} UndoPlan */
/** @typedef {import("./plan.js").Step} Step */

/**
 * @typedef {object} ApplyResult
 * @property {number} deleted
 * @property {number} restored
 * @property {number} dirsCreated
 * @property {number} dirsRemoved
 * @property {string[]} keptDirs  directories left in place because they were not empty
 * @property {{ path: string, why: string }[]} failures
 */

/**
 * Write a file so that it either exists completely or not at all.
 *
 * @param {string} abs
 * @param {Buffer} buf
 * @param {number} mode
 */
async function writeAtomic(abs, buf, mode) {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.rewind-tmp-${randomSuffix()}`);
  // writeFile's mode is filtered through the umask, so the chmod is not
  // redundant: it is what actually preserves the executable bit.
  await writeFile(tmp, buf, { mode });
  try {
    await chmod(tmp, mode);
    await rename(tmp, abs);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * @param {Config} cfg
 * @param {Store} store
 * @param {UndoPlan} plan
 * @returns {Promise<ApplyResult>}
 */
export async function applyPlan(cfg, store, plan) {
  /** @type {ApplyResult} */
  const result = {
    deleted: 0,
    restored: 0,
    dirsCreated: 0,
    dirsRemoved: 0,
    keptDirs: [],
    failures: [],
  };

  if (plan.refusals.length > 0) {
    // The caller decided to override. Nothing here re-checks --force: the plan
    // is the contract, and an empty `refusals` is what "approved" means.
    return result;
  }

  for (const step of plan.steps) {
    const abs = path.join(cfg.root, step.path);
    try {
      switch (step.action) {
        case "delete-file":
        case "delete-link": {
          await unlink(abs);
          result.deleted += 1;
          break;
        }
        case "rmdir": {
          try {
            await rmdir(abs);
            result.dirsRemoved += 1;
          } catch (err) {
            const code = /** @type {NodeJS.ErrnoException} */ (err).code;
            // ENOTEMPTY is the expected, safe outcome: the directory still holds
            // something that was never captured. It stays. That is the point.
            if (code === "ENOTEMPTY" || code === "EEXIST") result.keptDirs.push(step.path);
            else if (code !== "ENOENT") throw err;
          }
          break;
        }
        case "mkdir": {
          await mkdir(abs, { recursive: true });
          result.dirsCreated += 1;
          break;
        }
        case "write": {
          const entry = step.target;
          if (entry === undefined || entry.t !== "f") throw new Error("write step without a file");
          const buf = await store.readObject(entry.h);
          await writeAtomic(abs, buf, entry.mode === 0 ? 0o644 : entry.mode);
          result.restored += 1;
          break;
        }
        case "symlink": {
          const entry = step.target;
          if (entry === undefined || entry.t !== "l") throw new Error("symlink step without a link");
          await mkdir(path.dirname(abs), { recursive: true });
          await unlink(abs).catch(() => {});
          await symlink(entry.to, abs);
          result.restored += 1;
          break;
        }
        default: {
          throw new Error(`unknown step action`);
        }
      }
    } catch (err) {
      // Keep going: a partial restore the user can see beats an abort they have
      // to diagnose. Every failure is reported and the exit code is non-zero.
      result.failures.push({ path: step.path, why: /** @type {Error} */ (err).message });
    }
  }

  return result;
}

/**
 * @typedef {object} RewindOptions
 * @property {boolean} [dryRun]
 * @property {boolean} [yes]
 * @property {boolean} [force]
 */

/**
 * @typedef {object} RewindResult
 * @property {"planned" | "refused" | "noop" | "applied"} outcome
 * @property {UndoPlan} plan
 * @property {Snapshot | null} target
 * @property {Snapshot | null} safety          the snapshot taken before applying
 * @property {Snapshot | null} after
 * @property {ApplyResult | null} applied
 * @property {Manifest} live
 */

/**
 * Scan, plan, and — only when `opts.yes` is set and this is not a dry run —
 * apply.
 *
 * @param {Config} cfg
 * @param {Store} store
 * @param {Snapshot} target
 * @param {RewindOptions} [opts]
 * @returns {Promise<RewindResult>}
 */
export async function rewindTo(cfg, store, target, opts = {}) {
  // A dry run must not write anything, not even into the store. A real undo must
  // capture the present state in full — including files created since the last
  // snapshot — or the safety snapshot could not actually restore it, and the
  // undo would not be undoable. That is the difference the `writeObjects` flag
  // makes here.
  const live = await scanTree(cfg, {
    store,
    cache: await store.loadStatCache(),
    writeObjects: opts.dryRun !== true,
  });
  const plan = planUndo(cfg, live.entries, await store.readManifest(target.manifest), {
    force: opts.force ?? false,
  });

  /** @type {RewindResult} */
  const result = {
    outcome: "planned",
    plan,
    target,
    safety: null,
    after: null,
    applied: null,
    live: live.entries,
  };

  // A missing or corrupt object is a refusal, not a partial restore.
  for (const step of plan.steps) {
    if (step.action !== "write") continue;
    const entry = step.target;
    if (entry === undefined || entry.t !== "f") continue;
    if (!(await store.hasObject(entry.h))) {
      plan.refusals.push({
        path: step.path,
        why: "its content is missing from the store, so it cannot be restored",
      });
    }
  }

  if (plan.refusals.length > 0) {
    result.outcome = "refused";
    return result;
  }
  if (plan.steps.length === 0) {
    result.outcome = "noop";
    return result;
  }
  // `planned` is the outcome for anything short of an approved apply. The plan
  // returned here is the exact object that would be applied — the caller prints
  // it and decides, so what a person reads is what would run, with no rescan in
  // between that could quietly disagree.
  if (opts.dryRun === true || opts.yes !== true) return result;

  // Everything from here on changes the tree.
  const safety = await recordExistingManifest(store, {
    kind: "undo",
    label: `pre-undo (before restoring ${target.id})`,
    manifest: await store.putManifest(live.entries),
    counts: live.stats,
  });
  result.safety = safety;

  result.applied = await applyPlan(cfg, store, plan);

  // The cache described the tree as it was *before* the undo. Entries for paths
  // the undo touched now carry stale mtimes, so they are dropped rather than
  // guessed at — the next scan re-reads exactly those files and nothing else.
  const touched = new Set(plan.steps.map((step) => step.path));
  /** @type {import("./types.js").StatCache} */
  const refreshed = {};
  for (const [rel, statEntry] of Object.entries(live.cache)) {
    if (!touched.has(rel)) refreshed[rel] = statEntry;
  }
  await store.saveStatCache(refreshed);

  result.after = await recordExistingManifest(store, {
    kind: "undo",
    label: `undo → ${target.id}${target.label ? ` (${target.label})` : ""}`,
    manifest: target.manifest,
    counts: target.counts,
  });
  result.outcome = "applied";
  return result;
}

/**
 * Read one file as it was at a snapshot.
 *
 * @param {Store} store
 * @param {Snapshot} snapshot
 * @param {string} rel
 * @returns {Promise<Buffer>}
 */
export async function readAt(store, snapshot, rel) {
  const manifest = await store.readManifest(snapshot.manifest);
  const entry = manifest[rel];
  if (entry === undefined) throw new Error(`${rel} did not exist at ${snapshot.id}`);
  if (entry.t === "l") throw new Error(`${rel} was a symlink to ${entry.to} at ${snapshot.id}`);
  if (entry.t === "d") throw new Error(`${rel} was a directory at ${snapshot.id}`);
  if (entry.t === "x") throw new Error(`${rel} was not captured at ${snapshot.id} (${entry.why})`);
  return store.readObject(entry.h);
}
