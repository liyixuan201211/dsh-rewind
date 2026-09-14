/**
 * Shared test helpers.
 *
 * Two styles are used deliberately. Most tests drive the library in-process,
 * because that is fast and gives them a real object to assert on. The tests that
 * are *about* the command line — exit codes, output, argument handling — spawn
 * the real binary, because the exit code contract is only meaningful if it is
 * exercised through the process boundary that defines it.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { scanTree } from "../src/scan.js";
import { takeSnapshot } from "../src/snapshot.js";
import { Store } from "../src/store.js";

export const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "cli.js",
);

/**
 * A throwaway directory, removed when the test ends.
 *
 * The path is canonicalised, because that is what the tool stores and compares:
 * macOS hands out `/var/folders/...` while `realpath` reports
 * `/private/var/folders/...`, and asserting on the un-canonicalised form makes
 * every path comparison look like a bug.
 *
 * @param {import("node:test").TestContext} t
 * @returns {Promise<string>}
 */
export async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "rewind-test-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return realpathSync.native(dir);
}

/**
 * @param {string} root
 * @param {object} [opts] config overrides
 * @returns {Promise<{ cfg: import("../src/config.js").Config, store: Store }>}
 */
export async function open(root, opts = {}) {
  const cfg = await loadConfig({ root, ...opts });
  const store = await Store.open(cfg.storeDir, cfg.root, cfg.policy);
  return { cfg, store };
}

/**
 * @param {string} root
 * @param {object} [opts]
 * @param {object} [snapOpts]
 */
export async function snap(root, opts = {}, snapOpts = {}) {
  const { cfg, store } = await open(root, opts);
  return takeSnapshot(cfg, store, snapOpts);
}

/**
 * @param {string} root
 * @param {Record<string, string | Buffer>} files
 * @returns {Promise<void>}
 */
export async function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<string>}
 */
export const read = (root, rel) => readFile(path.join(root, rel), "utf8");

/**
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<boolean>}
 */
export async function exists(root, rel) {
  try {
    await readFile(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

/**
 * A complete, comparable picture of a directory: every entry the tool would
 * capture, including size and mtime.
 *
 * Used to assert that an operation changed *nothing* — "the file still has the
 * right bytes" is a weaker claim than "not one byte, mode or timestamp moved".
 *
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function fingerprint(root) {
  const cfg = await loadConfig({ root });
  const scan = await scanTree(cfg, { store: null, writeObjects: false });
  const sorted = Object.keys(scan.entries).sort();
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of sorted) out[key] = scan.entries[key];
  return JSON.stringify(out);
}

/**
 * Run the real CLI.
 *
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {{ code: number, out: string, err: string }}
 */
export function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: res.status ?? -1, out: res.stdout ?? "", err: res.stderr ?? "" };
}
