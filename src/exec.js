/**
 * `rewind exec` — snapshot, run, snapshot.
 *
 * This is the mode that needs no discipline from anyone. Wrapping a command is
 * one word, and it produces the thing `undo` wants most: a snapshot id that
 * corresponds to exactly one command, so "undo the thing I just ran" is a single
 * unambiguous reference instead of a timestamp you have to guess.
 *
 * The exit code is the wrapped command's exit code, always. A wrapper that
 * swallowed it would break `rewind exec -- make test` in every CI pipeline it
 * was dropped into.
 */
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

import { takeSnapshot } from "./snapshot.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./types.js").Snapshot} Snapshot */

/**
 * @typedef {object} ExecOptions
 * @property {string[]} argv
 * @property {string} [label]
 * @property {boolean} [quiet]
 */

/**
 * @typedef {object} ExecResult
 * @property {Snapshot | null} before
 * @property {Snapshot | null} after
 * @property {number} code
 * @property {number} ms
 * @property {boolean} unchanged
 */

/**
 * @param {Config} cfg
 * @param {Store} store
 * @param {ExecOptions} opts
 * @returns {Promise<ExecResult>}
 */
export async function rewindExec(cfg, store, opts) {
  const argv = opts.argv;
  const cmd = argv[0];
  if (cmd === undefined) throw new Error("exec needs a command: rewind exec -- <command>");
  const args = argv.slice(1);
  const display = argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
  const label = opts.label ?? display;

  const before = await takeSnapshot(cfg, store, {
    kind: "exec",
    label: `before: ${label}`,
    command: { argv: display, code: null, ms: 0 },
  });

  const started = Date.now();
  const code = await new Promise(
    (/** @type {(code: number) => void} */ resolve) => {
      const child = /** @type {import("node:child_process").ChildProcess} */ (
        spawn(cmd, args, { stdio: "inherit" })
      );
      child.on("error", (err) => {
        process.stderr.write(`rewind: could not run ${cmd}: ${err.message}\n`);
        resolve(127);
      });
      child.on("close", (exitCode, signal) => {
        if (signal !== null) {
          // `128 + signum` is the shell convention, and it keeps a killed child
          // from looking like a successful run. `SIGTERM` is 15, so the process
          // sees 143 — the same number the shell would have reported.
          const signals = /** @type {Record<string, number | undefined>} */ (osConstants.signals);
          resolve(128 + (signals[signal] ?? 1));
        } else {
          resolve(exitCode ?? 0);
        }
      });
    },
  );
  const ms = Date.now() - started;

  const after = await takeSnapshot(cfg, store, {
    kind: "exec",
    label: `after: ${label} (exit ${code})`,
    command: { argv: display, code, ms },
  });

  return {
    before: before.record,
    after: after.record,
    code,
    ms,
    unchanged: after.unchanged,
  };
}
