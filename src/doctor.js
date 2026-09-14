/**
 * `rewind doctor` — check that the store can still do what it promises.
 *
 * A snapshot store is only worth trusting if its failure modes are visible
 * before you need it. The three that matter:
 *
 *   * A manifest is missing, so `undo` to that snapshot is impossible even
 *     though the log says it happened.
 *   * An object is missing, so one file inside an otherwise restorable snapshot
 *     would come back as an error halfway through.
 *   * An object is corrupt — its bytes no longer hash to its name — so a restore
 *     would write the wrong content over a real file. This is the one worth
 *     paying for, and `--verify` pays it.
 *
 * A store whose root has moved is reported too: restoring is relative to the
 * root, so a store copied next to a different tree would write the right
 * relative paths into the wrong directory.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { shortHash } from "./util.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./store.js").Store} Store */

/**
 * @typedef {object} Problem
 * @property {string} what
 * @property {string} why
 */

/**
 * @typedef {object} DoctorResult
 * @property {Problem[]} problems
 * @property {number} snapshots
 * @property {number} manifests
 * @property {number} objects
 * @property {number} unreferencedObjects
 * @property {number} verified
 * @property {boolean} rootMismatch
 */

/**
 * @param {Config} cfg
 * @param {Store} store
 * @param {{ verify?: boolean }} [opts]
 * @returns {Promise<DoctorResult>}
 */
export async function doctorStore(cfg, store, opts = {}) {
  /** @type {Problem[]} */
  const problems = [];
  const result = /** @type {DoctorResult} */ ({
    problems,
    snapshots: 0,
    manifests: 0,
    objects: 0,
    unreferencedObjects: 0,
    verified: 0,
    rootMismatch: false,
  });

  const meta = store.readMeta();
  if (meta === null) {
    problems.push({ what: "meta.json", why: "missing or unreadable" });
  } else if (meta.root !== cfg.root) {
    result.rootMismatch = true;
    problems.push({
      what: "meta.json",
      why: `this store was created for ${meta.root}, but it is being used for ${cfg.root}`,
    });
  }

  const log = await store.readLog();
  result.snapshots = log.length;

  const seenIds = new Set();
  const referencedManifests = new Set();
  const referencedObjects = new Set();

  for (const record of log) {
    if (seenIds.has(record.id)) {
      problems.push({ what: record.id, why: "duplicate snapshot id in the log" });
    }
    seenIds.add(record.id);

    referencedManifests.add(record.manifest);
    let entries;
    try {
      entries = await store.readManifest(record.manifest);
    } catch (err) {
      problems.push({ what: record.id, why: /** @type {Error} */ (err).message });
      continue;
    }
    for (const [rel, entry] of Object.entries(entries)) {
      if (entry.t !== "f") continue;
      referencedObjects.add(entry.h);
      const file = store.objectPath(entry.h);
      const st = await stat(file).catch(() => null);
      if (st === null) {
        problems.push({ what: rel, why: `content ${shortHash(entry.h)} is missing` });
        continue;
      }
      if (opts.verify === true) {
        const buf = await readFile(file);
        const actual = createHash("sha256").update(buf).digest("hex");
        if (actual !== entry.h) {
          problems.push({ what: rel, why: `content ${shortHash(entry.h)} is corrupt` });
        } else {
          result.verified += 1;
        }
      }
    }
  }

  result.manifests = (await readdir(store.manifestsDir).catch(() => [])).length;

  let objects = 0;
  for (const shard of await readdir(store.objectsDir).catch(() => [])) {
    for (const name of await readdir(path.join(store.objectsDir, shard)).catch(() => [])) {
      objects += 1;
      if (!referencedObjects.has(name)) result.unreferencedObjects += 1;
    }
  }
  result.objects = objects;

  const missingManifests = result.manifests < referencedManifests.size;
  if (missingManifests) {
    problems.push({
      what: "manifests/",
      why: `${referencedManifests.size} manifests are referenced but only ${result.manifests} exist`,
    });
  }

  return result;
}
