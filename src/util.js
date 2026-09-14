/**
 * Small, dependency-free helpers. Nothing here knows what a snapshot is.
 */
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * @param {Buffer | string} data
 * @returns {string} lowercase hex sha-256
 */
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Byte counts in the units a person reads. Binary units, because this measures
 * disk usage.
 *
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * @param {string} h
 * @returns {string}
 */
export const shortHash = (h) => h.slice(0, 12);

/**
 * Resolve a path to its physical form.
 *
 * macOS reports `/var/folders/...` for a temp directory while `realpath` says
 * `/private/var/folders/...`. Comparing the two strings makes every file look
 * like it lies outside the root — so every path that crosses the boundary is
 * canonicalised first, and the root is stored canonicalised.
 *
 * @param {string} p
 * @returns {string}
 */
export function canonical(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * A sortable UTC stamp: `20260914T033739Z`. Sortable as a string, readable at a
 * glance, safe in a filename, and the trailing `Z` says plainly that the log is
 * in UTC — the ids are compared as strings and printed for humans to copy.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function stamp(date = new Date()) {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/**
 * Distinguishes two snapshots taken in the same second.
 *
 * @returns {string} 4 hex characters
 */
export const randomSuffix = () => randomBytes(2).toString("hex");

/**
 * Heuristic binary detection, used only to decide whether to print a unified
 * diff or say "binary". A NUL byte in the first 8 KiB is the same rule git uses,
 * and being wrong here costs a readable diff, never correctness.
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/**
 * Durations like `7d`, `12h`, `30m`, `45s` — for `prune --older-than`.
 *
 * @param {string} text
 * @returns {number} milliseconds
 */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(text.trim());
  if (!m) throw new Error(`not a duration: ${text} (try 30m, 12h, 7d)`);
  const n = Number(m[1]);
  const unit = m[2] ?? "";
  /** @type {Record<string, number>} */
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const factor = scale[unit];
  if (factor === undefined) throw new Error(`not a duration unit: ${unit}`);
  return n * factor;
}

/**
 * Split `a/b/c` into `["a", "a/b", "a/b/c"]`, so a caller can walk up a path.
 *
 * @param {string} rel
 * @returns {string[]}
 */
export function ancestors(rel) {
  const parts = rel.split("/");
  /** @type {string[]} */
  const out = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push(acc);
  }
  return out;
}

/**
 * How deep a path is; `a/b` is 2. Used to delete deepest-first and create
 * shallowest-first.
 *
 * @param {string} rel
 * @returns {number}
 */
export const depth = (rel) => rel.split("/").length;
