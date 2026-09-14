/**
 * Human output. Every function here returns a string; nothing writes to a
 * stream, so the CLI decides where it goes and tests can assert on exact text.
 *
 * The guiding rule for `undo` output is that the plan is shown *before* it is
 * applied, always — with or without `--yes`. An undo the user did not get to
 * read is an undo they cannot trust.
 */
import { formatBytes } from "./util.js";

/** @typedef {import("./types.js").Entry} Entry */
/** @typedef {import("./types.js").Snapshot} Snapshot */
/** @typedef {import("./plan.js").UndoPlan} UndoPlan */
/** @typedef {import("./plan.js").Change} Change */
/** @typedef {import("./undo.js").ApplyResult} ApplyResult */
/** @typedef {import("./undo.js").RewindResult} RewindResult */

/**
 * @typedef {object} Style
 * @property {(s: string) => string} bold
 * @property {(s: string) => string} dim
 * @property {(s: string) => string} red
 * @property {(s: string) => string} green
 * @property {(s: string) => string} yellow
 * @property {(s: string) => string} cyan
 */

const identity = (/** @type {string} */ s) => s;

/**
 * Colour only when a human is watching. `NO_COLOR` is honoured, and a pipe gets
 * plain text so that `rewind log | grep` is not full of escape codes.
 *
 * @param {{ isTTY?: boolean }} [stream]
 * @returns {Style}
 */
export function makeStyle(stream) {
  if (process.env.NO_COLOR || process.env.TERM === "dumb" || stream?.isTTY !== true) {
    return {
      bold: identity,
      dim: identity,
      red: identity,
      green: identity,
      yellow: identity,
      cyan: identity,
    };
  }
  const wrap = (/** @type {string} */ code) => (/** @type {string} */ s) => `\u001b[${code}m${s}\u001b[0m`;
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    cyan: wrap("36"),
  };
}

/**
 * @param {Entry | undefined} entry
 * @returns {string}
 */
export function describeEntry(entry) {
  if (entry === undefined) return "absent";
  switch (entry.t) {
    case "f":
      return formatBytes(entry.s);
    case "d":
      return "directory";
    case "l":
      return `→ ${entry.to}`;
    default:
      return `not captured (${entry.why}${entry.s === undefined ? "" : `, ${formatBytes(entry.s)}`})`;
  }
}

/**
 * @param {number} mode
 * @returns {string} three octal digits, the way `chmod` and `ls` show them
 */
const octalMode = (mode) => (mode & 0o777).toString(8).padStart(3, "0");

/**
 * @param {Change} change
 * @returns {string}
 */
function describeChange(change) {
  if (change.change === "add") return `added    ${describeEntry(change.to)}`;
  if (change.change === "remove") return `removed  ${describeEntry(change.from)}`;

  const from = change.from;
  const to = change.to;
  if (from?.t === "f" && to?.t === "f") {
    // Three different things can differ about a file, and saying which one it is
    // is the difference between a useful line and "25 B → 25 B".
    if (from.h !== to.h) {
      return from.s === to.s
        ? `${formatBytes(to.s)} (content changed)`
        : `${formatBytes(from.s)} → ${formatBytes(to.s)}`;
    }
    if (from.mode !== to.mode) {
      return `${formatBytes(to.s)} (mode ${octalMode(from.mode)} → ${octalMode(to.mode)})`;
    }
  }
  return `${describeEntry(from)} → ${describeEntry(to)}`;
}

/**
 * @param {Change[]} changes
 * @param {number} width
 * @returns {string}
 */
export function renderChanges(changes, width = 0) {
  const lines = [];
  for (const change of changes) {
    const pad = " ".repeat(Math.max(0, width - change.path.length));
    lines.push(`  ${change.path}${pad}  ${describeChange(change)}`);
  }
  return lines.join("\n");
}

/**
 * @param {Snapshot} record
 * @param {string} relative
 * @param {Style} style
 * @returns {string}
 */
export function renderSnapshotHead(record, relative, style) {
  const label = record.label ? `  ${style.cyan(record.label)}` : "";
  return `${style.bold(record.id)}  ${style.dim(relative)}  ${style.dim(record.kind)}${label}`;
}

/**
 * @param {Snapshot[]} records oldest first
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {Date} [opts.now]
 * @param {Style} [opts.style]
 * @returns {string}
 */
export function renderLog(records, opts = {}) {
  const style = opts.style ?? makeStyle();
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 20;
  if (records.length === 0) {
    return "no snapshots yet — `rewind snap` takes one, `rewind watch` takes them for you\n";
  }
  const shown = records.slice(Math.max(0, records.length - limit)).reverse();
  const width = Math.max(...shown.map((r) => r.id.length));
  const lines = shown.map((r) => {
    const id = r.id.padEnd(width);
    const bits = [
      `${id}  ${String(relative(r, now)).padStart(8)}`,
      r.unchanged ? style.dim("unchanged") : style.yellow(`${countChanges(r)} changed`),
      r.kind,
      r.label,
    ];
    return `  ${bits.filter(Boolean).join("  ")}`;
  });
  const head =
    `${records.length} snapshot${records.length === 1 ? "" : "s"}` +
    `${shown.length < records.length ? `, showing the last ${shown.length}` : ""}\n\n`;
  return `${head}${lines.join("\n")}\n`;
}

/**
 * @param {Snapshot} record
 * @returns {string}
 */
function countChanges(record) {
  const c = record.counts;
  return `${c.files} file${c.files === 1 ? "" : "s"}`;
}

/**
 * @param {Snapshot} record
 * @param {Date} [now]
 * @returns {string}
 */
function relative(record, now = new Date()) {
  const ms = now.getTime() - new Date(record.time).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * @typedef {object} StatusInput
 * @property {Snapshot | null} record
 * @property {Change[]} changes
 * @property {string} ref
 * @property {Date} [now]
 * @property {Style} [style]
 */

/**
 * @param {StatusInput} input
 * @returns {string}
 */
export function renderStatus(input) {
  const style = input.style ?? makeStyle();
  const { record, changes } = input;
  if (record === null) {
    return "no snapshots yet — nothing to compare against. `rewind snap` takes one.\n";
  }
  if (changes.length === 0) {
    return `${style.green("clean")} — the tree matches ${style.bold(record.id)} (${relative(record, input.now)})\n`;
  }
  const width = Math.max(...changes.map((c) => c.path.length));
  const noun = changes.length === 1 ? "path differs" : "paths differ";
  const head =
    `${style.yellow(`${changes.length} ${noun}`)} ` +
    `from ${style.bold(record.id)} (${relative(record, input.now)})\n\n`;
  const foot =
    `\n  ${style.dim("rewind diff")}   see what changed\n` +
    `  ${style.dim("rewind undo")}   go back to ${record.id}\n` +
    `  ${style.dim("rewind snap")}   accept the current state and move on\n`;
  return `${head}${renderChanges(changes, width)}\n${foot}`;
}

/**
 * @param {UndoPlan} plan
 * @param {string} targetId
 * @param {Style} [style]
 * @returns {string}
 */
export function renderPlan(plan, targetId, style = makeStyle()) {
  const lines = [];
  const width = Math.max(
    0,
    ...plan.steps.map((s) => s.path.length),
    ...plan.unrestorable.map((u) => u.path.length),
    ...plan.refusals.map((r) => r.path.length),
  );

  for (const step of plan.steps) {
    const pad = " ".repeat(Math.max(0, width - step.path.length));
    if (step.action === "delete-file" || step.action === "delete-link") {
      lines.push(`  ${style.red("remove ")}  ${step.path}${pad}  ${describeEntry(step.live)}`);
    } else if (step.action === "rmdir") {
      lines.push(`  ${style.red("rmdir  ")}  ${step.path}${pad}  ${style.dim("only if empty")}`);
    } else if (step.action === "mkdir") {
      lines.push(`  ${style.green("mkdir  ")}  ${step.path}${pad}`);
    } else if (step.action === "symlink") {
      lines.push(
        `  ${style.green("link   ")}  ${step.path}${pad}  → ${step.target?.t === "l" ? step.target.to : ""}`,
      );
    } else {
      lines.push(`  ${style.green("restore")}  ${step.path}${pad}  ${describeEntry(step.target)}`);
    }
  }

  for (const u of plan.unrestorable) {
    const pad = " ".repeat(Math.max(0, width - u.path.length));
    lines.push(`  ${style.yellow("can't  ")}  ${u.path}${pad}  ${u.why}`);
  }
  for (const r of plan.refusals) {
    const pad = " ".repeat(Math.max(0, width - r.path.length));
    lines.push(`  ${style.red("refuse ")}  ${r.path}${pad}  ${r.why}`);
  }

  const { restore, remove, mkdir, rmdir } = plan.summary;
  const summary = [
    restore > 0 ? `${restore} restored` : "",
    remove > 0 ? `${remove} removed` : "",
    mkdir > 0 ? `${mkdir} created` : "",
    rmdir > 0 ? `${rmdir} dirs removed if empty` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const head = `Restoring ${style.bold(targetId)}: ${summary || "nothing to do"}\n\n`;
  return `${head}${lines.join("\n")}\n`;
}

/**
 * @param {RewindResult} result
 * @param {Style} [style]
 * @returns {string}
 */
export function renderApplyResult(result, style = makeStyle()) {
  const applied = result.applied;
  if (applied === null) return "";
  const bits = [
    `${applied.restored} restored`,
    `${applied.deleted} removed`,
    applied.dirsCreated > 0 ? `${applied.dirsCreated} dirs created` : "",
    applied.dirsRemoved > 0 ? `${applied.dirsRemoved} dirs removed` : "",
  ].filter(Boolean);
  let out = `${style.green("undo complete")} — ${bits.join(", ")}\n`;
  if (applied.keptDirs.length > 0) {
    out +=
      `\n  ${style.yellow("kept")} ${applied.keptDirs.length} director${applied.keptDirs.length === 1 ? "y" : "ies"}` +
      ` that still hold files this snapshot never captured:\n`;
    for (const dir of applied.keptDirs.slice(0, 10)) out += `    ${dir}\n`;
    if (applied.keptDirs.length > 10) out += `    … and ${applied.keptDirs.length - 10} more\n`;
  }
  if (applied.failures.length > 0) {
    out += `\n  ${style.red("failed")} ${applied.failures.length}:\n`;
    for (const f of applied.failures.slice(0, 10)) out += `    ${f.path}: ${f.why}\n`;
  }
  if (result.safety !== null) {
    out +=
      `\n  the state you just replaced is ${style.bold(result.safety.id)}\n` +
      `  ${style.dim(`rewind undo ${result.safety.id}`)} puts it back\n`;
  }
  return out;
}

/**
 * @param {number} n
 * @returns {string}
 */
export const bigNumber = (n) => n.toLocaleString("en-US");
