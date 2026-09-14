/**
 * Taking a snapshot: scan, store the manifest, append one line to the log.
 *
 * A snapshot that changed nothing is not silent — it is recorded, and marked
 * `unchanged`, because "I checked and nothing moved" is information. The one
 * exception is `watch`, which fires on a timer; recording every idle tick would
 * bury the interesting entries.
 */
import { randomSuffix, stamp } from "./util.js";
import { scanTree } from "./scan.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./types.js").Manifest} Manifest */
/** @typedef {import("./types.js").Snapshot} Snapshot */
/** @typedef {import("./types.js").CommandInfo} CommandInfo */
/** @typedef {import("./types.js").ScanStats} ScanStats */

/**
 * @typedef {object} SnapshotOptions
 * @property {"snap" | "watch" | "exec" | "undo"} [kind]
 * @property {string} [label]
 * @property {string} [note]
 * @property {CommandInfo} [command]
 * @property {boolean} [rehash]
 */

/**
 * @typedef {object} SnapshotResult
 * @property {Snapshot} record
 * @property {boolean} unchanged
 * @property {boolean} recorded  false when a no-op watch tick was suppressed
 * @property {ScanStats} stats
 * @property {{ path: string, why: string, size?: number }[]} skipped
 */

/**
 * @param {Config} cfg
 * @param {Store} store
 * @param {SnapshotOptions} [opts]
 * @returns {Promise<SnapshotResult>}
 */
export async function takeSnapshot(cfg, store, opts = {}) {
  const kind = opts.kind ?? "snap";
  const log = await store.readLog();
  const parent = log.length > 0 ? (log[log.length - 1] ?? null) : null;
  const parentManifest = parent === null ? null : parent.manifest;

  const scan = await scanTree(cfg, {
    store,
    cache: await store.loadStatCache(),
    ...(opts.rehash === undefined ? {} : { rehash: opts.rehash }),
  });
  const manifest = await store.putManifest(scan.entries);
  const unchanged = parentManifest !== null && parentManifest === manifest;
  // The cache is advisory: writing it is what makes the next scan cheap, and
  // failing to write it costs a re-read rather than correctness.
  await store.saveStatCache(scan.cache);

  const at = new Date();
  /** @type {Snapshot} */
  const record = {
    v: 1,
    id: `${stamp(at)}-${randomSuffix()}`,
    seq: log.length + 1,
    time: at.toISOString(),
    kind,
    label: opts.label ?? "",
    manifest,
    parent: parent === null ? null : parent.id,
    parentManifest,
    counts: scan.stats,
    unchanged,
  };
  if (opts.note !== undefined) record.note = opts.note;
  if (opts.command !== undefined) record.command = opts.command;

  // A watch tick that saw no change is noise; anything explicit is a fact worth
  // keeping.
  if (kind === "watch" && unchanged) {
    return { record, unchanged, recorded: false, stats: scan.stats, skipped: scan.skipped };
  }

  await store.appendRecord(record);
  return { record, unchanged, recorded: true, stats: scan.stats, skipped: scan.skipped };
}

/**
 * Record a state that is already known, without re-walking the tree.
 *
 * Two callers need this: a completed `undo`, whose result is exactly the target
 * manifest by construction, and the pre-undo safety snapshot, whose result is
 * exactly the manifest that was just scanned. Re-scanning would be slower and —
 * worse — could disagree with what was actually written.
 *
 * @param {Store} store
 * @param {object} opts
 * @param {"snap" | "watch" | "exec" | "undo" | "prune"} opts.kind
 * @param {string} opts.label
 * @param {string} opts.manifest
 * @param {ScanStats} opts.counts
 * @param {string} [opts.note]
 * @returns {Promise<Snapshot>}
 */
export async function recordExistingManifest(store, opts) {
  const log = await store.readLog();
  const parent = log.length > 0 ? (log[log.length - 1] ?? null) : null;
  const parentManifest = parent === null ? null : parent.manifest;
  const at = new Date();

  /** @type {Snapshot} */
  const record = {
    v: 1,
    id: `${stamp(at)}-${randomSuffix()}`,
    seq: log.length + 1,
    time: at.toISOString(),
    kind: opts.kind,
    label: opts.label,
    manifest: opts.manifest,
    parent: parent === null ? null : parent.id,
    parentManifest,
    counts: opts.counts,
    unchanged: parentManifest === opts.manifest,
  };
  if (opts.note !== undefined) record.note = opts.note;

  await store.appendRecord(record);
  return record;
}
