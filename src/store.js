/**
 * The store: content-addressed objects, manifests, and an append-only log.
 *
 * Layout under `<root>/.rewind/`:
 *
 *   meta.json              what root this store belongs to
 *   log.jsonl              one line per snapshot, oldest first
 *   objects/<ab>/<sha256>  file contents, sharded two hex characters deep
 *   manifests/<sha256>     one canonical JSON tree per distinct tree state
 *
 * Two properties fall out of content addressing, and both matter:
 *
 *   1. Snapshots are cheap. Unchanged files are not copied, and two snapshots
 *      of an unchanged tree share one manifest object, so the log line is the
 *      only cost.
 *   2. Restores are verifiable. The name of an object is the hash of its
 *      contents, so a restore re-hashes what it read and refuses to write a
 *      corrupted object over a real file.
 *
 * Nothing here ever overwrites an existing object: `wx` makes the write
 * exclusive, so a concurrent snapshot cannot race one into a half-written file.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256, shortHash } from "./util.js";

/** @typedef {import("./types.js").Manifest} Manifest */
/** @typedef {import("./types.js").Snapshot} Snapshot */

export const STORE_VERSION = 1;

export class StoreError extends Error {}

export class Store {
  /**
   * @param {string} dir absolute path to the store directory
   */
  constructor(dir) {
    this.dir = dir;
    this.objectsDir = path.join(dir, "objects");
    this.manifestsDir = path.join(dir, "manifests");
    this.logPath = path.join(dir, "log.jsonl");
    this.metaPath = path.join(dir, "meta.json");
    this.statPath = path.join(dir, "stat.json");
  }

  /**
   * The scan-speed cache: path → {size, mtimeMs, hash} for files seen last time.
   *
   * This is the only place a timestamp is stored, and it is deliberately
   * outside the manifest. A snapshot's identity is its content; a cache that
   * goes stale costs a re-read, never a wrong answer. If it is corrupt or
   * missing, scanning still works — it is just slower.
   *
   * @returns {Promise<import("./types.js").StatCache>}
   */
  async loadStatCache() {
    try {
      const parsed = JSON.parse(await readFile(this.statPath, "utf8"));
      return parsed !== null && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * @param {import("./types.js").StatCache} cache
   * @returns {Promise<void>}
   */
  async saveStatCache(cache) {
    const tmp = `${this.statPath}.tmp`;
    await writeFile(tmp, JSON.stringify(cache));
    await rename(tmp, this.statPath);
  }

  /**
   * Create the store if it does not exist yet. Idempotent: every command that
   * needs a store calls this, so there is no separate mandatory `init`.
   *
   * The capture policy is written into `meta.json` here and read back by
   * `loadConfig` on every later run. A store that forgot how it was told to
   * capture would let a later command — one using different `--max-file-size`
   * or `--exclude` flags — compute a different view of the tree than its own
   * snapshots did, and those two views disagree about what is "new", which is
   * exactly the disagreement that turns an undo into a deletion.
   *
   * @param {string} dir absolute path to the store directory
   * @param {string} root canonical absolute path of the directory being tracked
   * @param {import("./config.js").Policy} [policy]
   * @returns {Promise<Store>}
   */
  static async open(dir, root, policy) {
    const store = new Store(dir);
    // The store holds plaintext copies of everything captured, including .env
    // files and keys. It is created owner-only so that another user on the same
    // machine cannot read the contents of yours. mkdir's mode is filtered
    // through the umask, so the chmod is what actually enforces it.
    await mkdir(store.objectsDir, { recursive: true, mode: 0o700 });
    await mkdir(store.manifestsDir, { recursive: true, mode: 0o700 });
    await chmod(store.dir, 0o700).catch(() => {});

    /** @type {Record<string, unknown> | null} */
    let meta = null;
    if (existsSync(store.metaPath)) {
      try {
        meta = JSON.parse(readFileSync(store.metaPath, "utf8"));
      } catch {
        // A corrupt meta.json is surfaced by `rewind doctor`; overwriting it
        // silently would destroy the record of which root this store belongs to.
        meta = null;
      }
    }

    if (meta === null) {
      /** @type {Record<string, unknown>} */
      const fresh = { v: STORE_VERSION, root, created: new Date().toISOString(), tool: "dsh-rewind" };
      if (policy !== undefined) fresh.policy = policy;
      await writeFile(store.metaPath, `${JSON.stringify(fresh, null, 2)}\n`, { flag: "wx" }).catch(
        (err) => {
          if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
        },
      );
    } else if (policy !== undefined && JSON.stringify(meta.policy ?? null) !== JSON.stringify(policy)) {
      // An explicit flag changed the policy: record the change rather than
      // letting the store and the command line disagree from here on.
      meta.policy = policy;
      const tmp = `${store.metaPath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`);
      await rename(tmp, store.metaPath);
    }
    return store;
  }

  /**
   * The root this store was created for. A store copied next to a different tree
   * would otherwise silently restore the wrong files.
   *
   * @returns {{ v: number, root: string, created: string, tool: string, policy?: import("./config.js").Policy } | null}
   */
  readMeta() {
    try {
      return JSON.parse(readFileSync(this.metaPath, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * @param {string} hash
   * @returns {string} absolute path of the object
   */
  objectPath(hash) {
    return path.join(this.objectsDir, hash.slice(0, 2), hash);
  }

  /**
   * @param {string} hash
   * @returns {Promise<boolean>}
   */
  async hasObject(hash) {
    try {
      await stat(this.objectPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write content under its own hash. Skipped when it is already there, which is
   * the common case: a file edited once and snapshotted ten times is stored once.
   *
   * @param {Buffer} buf
   * @param {string} [knownHash] avoids re-hashing content the caller already hashed
   * @returns {Promise<string>} the content hash
   */
  async putObject(buf, knownHash) {
    const hash = knownHash ?? sha256(buf);
    const target = this.objectPath(hash);
    if (existsSync(target)) return hash;
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, buf, { flag: "wx" });
    } catch (err) {
      // Lost a race with a concurrent snapshot; the object is there, which is
      // all that matters.
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
    }
    return hash;
  }

  /**
   * @param {string} hash
   * @returns {Promise<Buffer>}
   */
  async readObject(hash) {
    const buf = await readFile(this.objectPath(hash));
    // The name is the hash, so verify it. A truncated or edited object must not
    // be written over a real file as if it were the snapshot's content.
    const actual = sha256(buf);
    if (actual !== hash) {
      throw new StoreError(
        `object ${shortHash(hash)} is corrupt: contents hash to ${shortHash(actual)}`,
      );
    }
    return buf;
  }

  /**
   * Manifests are canonicalised (keys sorted, no insignificant whitespace) so
   * that two identical trees always produce the same hash. Without this, the
   * same tree snapshotted twice would look like a change.
   *
   * @param {Manifest} entries
   * @returns {Promise<string>}
   */
  async putManifest(entries) {
    const sorted = /** @type {Manifest} */ ({});
    for (const key of Object.keys(entries).sort()) {
      const entry = entries[key];
      if (entry !== undefined) sorted[key] = entry;
    }
    const text = JSON.stringify(sorted);
    const hash = createHash("sha256").update(text).digest("hex");
    const target = path.join(this.manifestsDir, hash);
    if (!existsSync(target)) {
      await mkdir(this.manifestsDir, { recursive: true });
      try {
        await writeFile(target, text, { flag: "wx" });
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
      }
    }
    return hash;
  }

  /**
   * @param {string} hash
   * @returns {Promise<Manifest>}
   */
  async readManifest(hash) {
    try {
      return JSON.parse(await readFile(path.join(this.manifestsDir, hash), "utf8"));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
        throw new StoreError(`manifest ${shortHash(hash)} is missing from the store`);
      }
      throw err;
    }
  }

  /**
   * @returns {Promise<Snapshot[]>} every snapshot, oldest first
   */
  async readLog() {
    let text;
    try {
      text = await readFile(this.logPath, "utf8");
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return [];
      throw err;
    }
    /** @type {Snapshot[]} */
    const out = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = (lines[i] ?? "").trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // A partially written final line is the expected outcome of a process
        // killed mid-append: the earlier records are intact and must still be
        // readable. Any other bad line is corruption worth naming.
        if (i === lines.length - 1) break;
        throw new StoreError(`log.jsonl line ${i + 1} is not valid JSON`);
      }
    }
    return out;
  }

  /**
   * @param {Snapshot} record
   * @returns {Promise<void>}
   */
  async appendRecord(record) {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.logPath, `${JSON.stringify(record)}\n`);
  }

  /**
   * @returns {Promise<Snapshot | null>} the most recent snapshot
   */
  async latest() {
    const log = await this.readLog();
    return log.length ? (log[log.length - 1] ?? null) : null;
  }

  /**
   * How much is actually on disk, and how much the deduplication saved.
   *
   * `stored` counts what is there; `logical` sums the size of every file across
   * the latest manifest's ancestry, which is what the store would cost without
   * content addressing.
   *
   * @returns {Promise<{ objects: number, manifests: number, bytes: number, snapshots: number }>}
   */
  async stat() {
    let objects = 0;
    let bytes = 0;
    let manifests = 0;
    try {
      for (const shard of await readdir(this.objectsDir)) {
        const shardDir = path.join(this.objectsDir, shard);
        let names;
        try {
          names = await readdir(shardDir);
        } catch {
          continue;
        }
        for (const name of names) {
          const st = await stat(path.join(shardDir, name)).catch(() => null);
          if (!st?.isFile()) continue;
          objects += 1;
          bytes += st.size;
        }
      }
    } catch {
      // No objects yet.
    }
    try {
      manifests = (await readdir(this.manifestsDir)).length;
    } catch {
      // No manifests yet.
    }
    const snapshots = (await this.readLog()).length;
    return { objects, manifests, bytes, snapshots };
  }
}

/**
 * A tiny helper so callers do not import `mkdirSync` just to make the store's
 * parent exist before `Store.open` runs.
 *
 * @param {string} dir
 */
export function ensureDirSync(dir) {
  mkdirSync(dir, { recursive: true });
}
