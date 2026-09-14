/**
 * What gets captured, and what is deliberately left out.
 *
 * Excluding is not an optimisation detail — it is what makes the store honest.
 * A snapshot is a promise that "this is what the tree looked like". Every path
 * left out is a path `undo` must not touch: if `node_modules/` was never
 * captured, an undo that deleted it anyway would be destroying data it never
 * saved. `scan` prunes these paths and `undo` re-checks them, so the two cannot
 * disagree.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ancestors, canonical } from "./util.js";

export const DEFAULT_STORE_DIR = ".rewind";

/**
 * 8 MiB. Large enough for every source file anyone edits, small enough that a
 * directory of videos does not silently consume the disk twice.
 */
export const DEFAULT_MAX_FILE_SIZE = 8 * 1024 * 1024;

/**
 * Directory names pruned wherever they appear, and files ignored by name.
 *
 * This list is deliberately short and boring: only things that are (a) not
 * authored by hand, (b) rebuildable, and (c) potentially enormous. Anything
 * arguable — `.env`, `dist/`, a data file — is captured, because the entire
 * point is to be able to get it back.
 */
export const DEFAULT_EXCLUDED_NAMES = [
  // version control and this tool's own store
  ".git",
  ".hg",
  ".svn",
  ".rewind",
  // dependencies
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
  // caches
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".turbo",
  ".parcel-cache",
  ".next",
  ".nuxt",
  // build output
  "dist",
  "build",
  "target",
];

/**
 * A compiled `.rewindignore` line.
 *
 * @typedef {object} Rule
 * @property {boolean} negated
 * @property {boolean} dirOnly
 * @property {RegExp} re
 */

/**
 * @typedef {object} Policy
 * @property {number} maxFileSize
 * @property {string[]} exclude   user-added names/paths, never the built-in defaults
 * @property {string | null} ignoreText  the .rewindignore text in force
 */

/**
 * @typedef {object} Config
 * @property {string} root                canonical absolute path
 * @property {string} storeDir            canonical absolute path of the store
 * @property {string | null} storeRel     store path relative to root, if inside
 * @property {number} maxFileSize
 * @property {Set<string>} excludedNames
 * @property {Set<string>} excludedPaths  exact or prefix matches, for --exclude with "/"
 * @property {Rule[]} rules
 * @property {Policy} policy              what to write back into the store
 */

/**
 * The capture policy a store was created with, if it has one.
 *
 * This exists because a mismatch between "what a snapshot captured" and "what a
 * later command believes it would capture" is not a cosmetic difference — it
 * changes what `undo` decides to delete. A store created with
 * `--max-file-size 10` had recorded a 46-byte file as *not captured*; a later
 * run using the default 8 MiB sees an ordinary file, and the two views disagree
 * about whether it is "new". Reading the policy back is what keeps them
 * agreeing.
 *
 * @param {string} storeDir
 * @returns {Promise<Policy | null>}
 */
async function readStoredPolicy(storeDir) {
  try {
    const meta = JSON.parse(await readFile(path.join(storeDir, "meta.json"), "utf8"));
    if (meta === null || typeof meta !== "object") return null;
    const policy = meta.policy;
    if (policy === null || typeof policy !== "object") return null;
    const rawExclude = /** @type {unknown[]} */ (Array.isArray(policy.exclude) ? policy.exclude : []);
    return {
      maxFileSize: typeof policy.maxFileSize === "number" ? policy.maxFileSize : DEFAULT_MAX_FILE_SIZE,
      exclude: /** @type {string[]} */ (rawExclude.filter((entry) => typeof entry === "string")),
      ignoreText: typeof policy.ignoreText === "string" ? policy.ignoreText : null,
    };
  } catch {
    // No store, no meta.json, or unreadable JSON: fall back to defaults. A
    // corrupt meta.json is reported by `rewind doctor`, not guessed at here.
    return null;
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.root]           defaults to the working directory
 * @param {string} [opts.store]          store location; defaults to `<root>/.rewind`
 * @param {number} [opts.maxFileSize]
 * @param {string[]} [opts.exclude]      extra names, or root-relative prefixes
 * @param {string} [opts.ignoreFile]     defaults to `<root>/.rewindignore`
 * @returns {Promise<Config>}
 */
export async function loadConfig(opts = {}) {
  const root = canonical(opts.root ?? process.cwd());
  const storeDir = canonical(opts.store ?? path.join(root, DEFAULT_STORE_DIR));

  const rel = path.relative(root, storeDir);
  const storeRel =
    rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : null;

  const stored = await readStoredPolicy(storeDir);

  // An explicit flag wins; otherwise the store's own policy is adopted, so every
  // command that touches a store sees the same world its snapshots were taken in.
  const maxFileSize = opts.maxFileSize ?? stored?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  if (!Number.isFinite(maxFileSize) || maxFileSize < 0) {
    throw new Error(`--max-file-size must be a non-negative number of bytes`);
  }

  const excludedNames = new Set(DEFAULT_EXCLUDED_NAMES);
  const excludedPaths = new Set();
  const extras = [];
  // The union is deliberate, and it only ever grows: a name that any version of
  // the policy excluded stays protected, so deleting an exclusion rule can never
  // turn into an `undo` that removes files the store has no copy of.
  for (const entry of [...(stored?.exclude ?? []), ...(opts.exclude ?? [])]) {
    const cleaned = entry.trim().replace(/^\.\//, "").replace(/\/+$/, "");
    if (!cleaned) continue;
    extras.push(cleaned);
    if (cleaned.includes("/")) excludedPaths.add(cleaned);
    else excludedNames.add(cleaned);
  }

  const ignoreFile = opts.ignoreFile ?? path.join(root, ".rewindignore");
  let ignoreText = null;
  try {
    ignoreText = await readFile(ignoreFile, "utf8");
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== "ENOENT") throw err;
  }
  // A .rewindignore on disk is live configuration and wins; otherwise the text
  // the store was created with is what those snapshots were taken under.
  if (ignoreText === null && stored?.ignoreText != null) ignoreText = stored.ignoreText;

  return {
    root,
    storeDir,
    storeRel,
    maxFileSize,
    excludedNames,
    excludedPaths,
    rules: ignoreText === null ? [] : parseIgnore(ignoreText),
    policy: { maxFileSize, exclude: [...new Set(extras)], ignoreText },
  };
}

/**
 * Turn one `.rewindignore` pattern into a regular expression.
 *
 * Supports the subset people actually write: `*`, `**`, `?`, a leading `/` to
 * anchor at the root, a trailing `/` for directories only, and `!` to negate.
 *
 * @param {string} pattern
 * @param {boolean} anchored
 * @returns {RegExp}
 */
function globToRegExp(pattern, anchored) {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] ?? "";
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  const prefix = anchored ? "^" : "(?:^|.*/)";
  return new RegExp(`${prefix}${re}$`);
}

/**
 * @param {string} text
 * @returns {Rule[]}
 */
export function parseIgnore(text) {
  /** @type {Rule[]} */
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    let dirOnly = false;
    let anchored = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1);
    }
    if (!line) continue;
    rules.push({ negated, dirOnly, re: globToRegExp(line, anchored) });
  }
  return rules;
}

/**
 * Last matching rule wins, as in gitignore.
 *
 * A `dir/` rule applies to the directory *and everything beneath it*, even when
 * the path handed in is a file. Traversal prunes the directory anyway, so this
 * changes nothing during a scan — but `undo` asks this question about paths that
 * came out of a manifest, where there is no traversal to rely on. Without the
 * ancestor check, a file inside a `dir/`-excluded directory would look
 * unprotected and an undo would be willing to delete it.
 *
 * @param {Rule[]} rules
 * @param {string} rel
 * @param {boolean} isDir kept for callers and future directory-only semantics
 * @returns {boolean}
 */
export function matchIgnore(rules, rel, isDir) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly) {
      // `build/` matches the directory `build` — and, for the undo path's sake,
      // everything inside it. It does not match a *file* called `build`, which
      // is why the path itself is only a candidate when it really is a
      // directory.
      const chain = ancestors(rel);
      const candidates = isDir ? chain : chain.slice(0, -1);
      if (!candidates.some((ancestor) => rule.re.test(ancestor))) continue;
    } else if (!rule.re.test(rel)) {
      continue;
    }
    ignored = !rule.negated;
  }
  return ignored;
}

/**
 * Is this path out of bounds?
 *
 * A manifest is just JSON in a file. A hostile or corrupted one could name
 * `../../.ssh/authorized_keys`, and a tool that "restores the tree to a
 * snapshot" would faithfully write there. Every path read out of the store is
 * checked against this before it is joined to the root.
 *
 * @param {string} rel
 * @returns {string | null} the reason it is unsafe, or null if it is fine
 */
export function unsafePath(rel) {
  if (!rel) return "empty path";
  if (rel.includes("\0")) return "contains a NUL byte";
  if (path.isAbsolute(rel)) return "absolute path";
  if (/^[A-Za-z]:[\\/]/.test(rel)) return "absolute path (windows)";
  const segments = rel.split("/");
  if (segments.some((s) => s === "..")) return "contains ..";
  if (segments.some((s) => s === "")) return "empty path segment";
  if (rel.endsWith("/")) return "trailing slash";
  return null;
}

/**
 * Should this path be left out of a snapshot — and, therefore, left alone by an
 * undo?
 *
 * @param {Config} cfg
 * @param {string} rel
 * @param {boolean} isDir
 * @returns {boolean}
 */
export function isExcluded(cfg, rel, isDir) {
  if (!rel) return false;
  const storeRel = cfg.storeRel;
  if (storeRel && (rel === storeRel || rel.startsWith(`${storeRel}/`))) return true;
  if (cfg.excludedPaths.has(rel)) return true;
  for (const segment of rel.split("/")) {
    if (cfg.excludedNames.has(segment)) return true;
    if (cfg.excludedPaths.has(segment)) return true;
  }
  return matchIgnore(cfg.rules, rel, isDir);
}

