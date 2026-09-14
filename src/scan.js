/**
 * Walk the root and describe it as a flat manifest.
 *
 * Two decisions make this safe rather than merely convenient:
 *
 *   * Symlinks are recorded as link targets and never followed. Following them
 *     would let a link inside the root read or write anywhere on the machine,
 *     and a link cycle would never terminate.
 *   * A path that cannot be captured is still *recorded*, as an `x` entry with
 *     the reason. That is what lets `undo` distinguish "this did not exist
 *     before" (delete it) from "this existed and I could not save it" (refuse to
 *     delete it). Silently skipping such a path would turn an undo into data
 *     loss — the exact failure this tool exists to prevent.
 */
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";

import { isExcluded } from "./config.js";
import { sha256 } from "./util.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./types.js").Entry} Entry */
/** @typedef {import("./types.js").Manifest} Manifest */
/** @typedef {import("./types.js").ScanStats} ScanStats */

/**
 * @typedef {object} SkippedPath
 * @property {string} path
 * @property {string} why
 * @property {number} [size]
 */

/**
 * @typedef {object} ScanResult
 * @property {Manifest} entries
 * @property {SkippedPath[]} skipped
 * @property {ScanStats} stats
 * @property {import("./types.js").StatCache} cache  what to reuse next time
 */

/**
 * @param {Config} cfg
 * @param {object} [opts]
 * @param {Store | null} [opts.store]       where to write object contents
 * @param {import("./types.js").StatCache | null} [opts.cache] scan-speed cache
 * @param {boolean} [opts.writeObjects]     defaults to true when a store is given
 * @param {boolean} [opts.rehash]           ignore the size+mtime shortcut
 * @returns {Promise<ScanResult>}
 */
export async function scanTree(cfg, opts = {}) {
  const store = opts.store ?? null;
  const cache = opts.cache ?? null;
  const writeObjects = opts.writeObjects ?? store !== null;
  const rehash = opts.rehash ?? false;

  /** @type {Manifest} */
  const entries = {};
  /** @type {import("./types.js").StatCache} */
  const nextCache = {};
  /** @type {SkippedPath[]} */
  const skipped = [];
  /** @type {ScanStats} */
  const stats = { files: 0, dirs: 0, links: 0, skipped: 0, bytes: 0, reused: 0, excluded: 0 };

  /** Breadth-first would need a queue; a stack is fine and keeps memory flat. */
  const stack = [""];

  while (stack.length > 0) {
    const rel = stack.pop();
    if (rel === undefined) break;
    const abs = rel === "" ? cfg.root : path.join(cfg.root, rel);

    /** @type {import("node:fs").Dirent[]} */
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      // The root failing is fatal — there is nothing to snapshot. A subdirectory
      // failing is recorded as an empty directory plus a note, so undo will not
      // claim those files either way.
      if (rel === "") throw err;
      entries[rel] = { t: "d" };
      stats.dirs += 1;
      skipped.push({ path: rel, why: "unreadable-directory" });
      stats.skipped += 1;
      continue;
    }

    // Deterministic order. The manifest is canonicalised anyway, but a stable
    // walk makes reports and test expectations stable too.
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const dirent of dirents) {
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      const isDir = dirent.isDirectory();

      if (isExcluded(cfg, childRel, isDir)) {
        stats.excluded += 1;
        continue;
      }

      const childAbs = path.join(cfg.root, childRel);

      if (dirent.isSymbolicLink()) {
        try {
          entries[childRel] = { t: "l", to: await readlink(childAbs) };
          stats.links += 1;
        } catch {
          entries[childRel] = { t: "x", why: "unreadable-symlink" };
          stats.skipped += 1;
          skipped.push({ path: childRel, why: "unreadable-symlink" });
        }
        continue;
      }

      if (isDir) {
        entries[childRel] = { t: "d" };
        stats.dirs += 1;
        stack.push(childRel);
        continue;
      }

      if (!dirent.isFile()) {
        entries[childRel] = { t: "x", why: "not-a-regular-file" };
        stats.skipped += 1;
        skipped.push({ path: childRel, why: "not-a-regular-file" });
        continue;
      }

      const st = await stat(childAbs).catch(() => null);
      if (st === null) {
        entries[childRel] = { t: "x", why: "unreadable" };
        stats.skipped += 1;
        skipped.push({ path: childRel, why: "unreadable" });
        continue;
      }

      if (st.size > cfg.maxFileSize) {
        entries[childRel] = { t: "x", why: "too-large", s: st.size };
        stats.skipped += 1;
        skipped.push({ path: childRel, why: "too-large", size: st.size });
        continue;
      }

      const cached = cache?.[childRel];
      let hash;
      if (!rehash && cached !== undefined && cached.s === st.size && cached.m === st.mtimeMs) {
        hash = cached.h;
        stats.reused += 1;
      } else {
        let buf;
        try {
          buf = await readFile(childAbs);
        } catch {
          entries[childRel] = { t: "x", why: "unreadable" };
          stats.skipped += 1;
          skipped.push({ path: childRel, why: "unreadable" });
          continue;
        }
        hash = sha256(buf);
        if (store !== null && writeObjects) await store.putObject(buf, hash);
      }

      entries[childRel] = { t: "f", h: hash, s: st.size, mode: st.mode & 0o777 };
      nextCache[childRel] = { s: st.size, m: st.mtimeMs, h: hash };
      stats.files += 1;
      stats.bytes += st.size;
    }
  }

  return { entries, skipped, stats, cache: nextCache };
}

/**
 * Are two entries the same thing?
 *
 * For a file this means the same bytes *and* the same permission bits. Content
 * alone is not enough: an agent that runs `chmod -x build.sh` has changed the
 * tree, and a rewind that ignored the mode would leave the script broken while
 * reporting success.
 *
 * @param {Entry} a
 * @param {Entry} b
 * @returns {boolean}
 */
export function sameEntry(a, b) {
  if (a.t !== b.t) return false;
  if (a.t === "f" && b.t === "f") return a.h === b.h && a.mode === b.mode;
  if (a.t === "l" && b.t === "l") return a.to === b.to;
  // Directories and "could not capture" entries carry no content to compare.
  // An `x` entry is compared by its reason so that a file that became too large
  // still reads as a change.
  if (a.t === "x" && b.t === "x") return a.why === b.why;
  return true;
}
