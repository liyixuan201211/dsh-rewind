/**
 * `rewind prune` — reclaim space by forgetting old snapshots.
 *
 * Two halves, and only the first one is obvious:
 *
 *   1. Drop old log entries.
 *   2. Garbage-collect. Because content is addressed by hash and shared between
 *      snapshots, dropping a log line does not make its files unreachable —
 *      anything a surviving snapshot also references stays. Mark-and-sweep is
 *      therefore not an optimisation here; it is the only correct way to know
 *      what is safe to delete.
 *
 * The newest snapshot is never dropped, whatever the flags say. A prune that
 * left nothing behind would turn "reclaim some space" into "delete the only
 * thing standing between you and a bad afternoon".
 */
import { readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseDuration } from "./util.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./types.js").Snapshot} Snapshot */

/**
 * @typedef {object} PruneOptions
 * @property {number} [keep]          how many of the newest snapshots to keep
 * @property {string} [olderThan]     duration string, e.g. "7d"
 * @property {boolean} [dryRun]
 */

/**
 * @typedef {object} PruneResult
 * @property {Snapshot[]} dropped
 * @property {number} kept
 * @property {number} manifestsRemoved
 * @property {number} objectsRemoved
 * @property {number} bytesReclaimed
 * @property {boolean} applied
 */

/**
 * @param {Config} cfg
 * @param {Store} store
 * @param {PruneOptions} [opts]
 * @returns {Promise<PruneResult>}
 */
export async function pruneStore(cfg, store, opts = {}) {
  const keep = Math.max(1, opts.keep ?? 20);
  const log = await store.readLog();
  if (log.length === 0) {
    return {
      dropped: [],
      kept: 0,
      manifestsRemoved: 0,
      objectsRemoved: 0,
      bytesReclaimed: 0,
      applied: false,
    };
  }

  const newest = /** @type {Snapshot} */ (log[log.length - 1]);
  let survivors = log.slice(Math.max(0, log.length - keep));

  if (opts.olderThan !== undefined) {
    const cutoff = Date.now() - parseDuration(opts.olderThan);
    survivors = survivors.filter((r) => new Date(r.time).getTime() >= cutoff);
  }

  // Whatever happens, the present state is not up for deletion.
  if (!survivors.includes(newest)) survivors = [newest, ...survivors];
  survivors.sort((a, b) => a.seq - b.seq);

  const keepIds = new Set(survivors.map((r) => r.id));
  const dropped = log.filter((r) => !keepIds.has(r.id));

  const result = /** @type {PruneResult} */ ({
    dropped,
    kept: survivors.length,
    manifestsRemoved: 0,
    objectsRemoved: 0,
    bytesReclaimed: 0,
    applied: false,
  });
  if (dropped.length === 0) return result;
  if (opts.dryRun === true) return result;

  // Mark: every manifest a survivor points at, and every object those manifests
  // reference. Anything else is unreachable.
  const liveManifests = new Set(survivors.map((r) => r.manifest));
  const liveObjects = new Set();
  for (const manifestHash of liveManifests) {
    const entries = await store.readManifest(manifestHash);
    for (const entry of Object.values(entries)) {
      if (entry.t === "f") liveObjects.add(entry.h);
    }
  }

  // Rewrite the log first, atomically. If this fails, nothing was deleted and
  // the store is still consistent.
  const rewritten = survivors.map((r) => {
    const copy = { ...r };
    if (copy.parent !== null && !keepIds.has(copy.parent)) copy.parent = null;
    return JSON.stringify(copy);
  });
  const tmp = `${store.logPath}.tmp`;
  await writeFile(tmp, `${rewritten.join("\n")}\n`);
  await rename(tmp, store.logPath);

  // Sweep.
  for (const shard of await readdir(store.objectsDir).catch(() => [])) {
    const shardDir = path.join(store.objectsDir, shard);
    for (const name of await readdir(shardDir).catch(() => [])) {
      if (liveObjects.has(name)) continue;
      const file = path.join(shardDir, name);
      const st = await stat(file).catch(() => null);
      if (st === null) continue;
      await unlink(file).catch(() => {});
      result.objectsRemoved += 1;
      result.bytesReclaimed += st.size;
    }
  }
  for (const name of await readdir(store.manifestsDir).catch(() => [])) {
    if (liveManifests.has(name)) continue;
    const file = path.join(store.manifestsDir, name);
    const st = await stat(file).catch(() => null);
    if (st === null) continue;
    await unlink(file).catch(() => {});
    result.manifestsRemoved += 1;
    result.bytesReclaimed += st.size;
  }

  result.applied = true;
  return result;
}
