/**
 * `rewind watch` — protection that does not depend on anyone remembering.
 *
 * A filesystem watcher is inherently noisy (one save can produce several
 * events), so events are coalesced by a debounce window and then a *snapshot*
 * decides whether anything actually changed. The manifest is content-addressed,
 * so an idle tick costs one hash comparison and writes no log line at all.
 *
 * The watcher is deliberately not a daemon: it runs in the foreground, prints
 * what it saved, and exits on Ctrl-C. A background process that quietly doubles
 * the disk usage of a directory is exactly the sort of thing a person should
 * have to opt into knowingly.
 */
import { watch as fsWatch } from "node:fs";
import path from "node:path";

import { isExcluded } from "./config.js";
import { takeSnapshot } from "./snapshot.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./types.js").Snapshot} Snapshot */

/**
 * @typedef {object} WatchOptions
 * @property {number} [debounceMs]   default 1200
 * @property {AbortSignal} [signal]  stop the loop
 * @property {(record: Snapshot | null, why: string) => void} [onSnapshot]
 * @property {number} [maxSnapshots] stop after this many recorded snapshots (tests, CI)
 * @property {boolean} [once]        take one snapshot and exit without watching
 */

/**
 * @typedef {object} WatchResult
 * @property {number} snapshots recorded snapshots
 * @property {number} ticks     debounce windows that fired, changed or not
 * @property {boolean} stopped  true when the loop ended because it was asked to
 */

/**
 * @param {Config} cfg
 * @param {Store} store
 * @param {WatchOptions} [opts]
 * @returns {Promise<WatchResult>}
 */
export async function watchDirectory(cfg, store, opts = {}) {
  const debounceMs = opts.debounceMs ?? 1200;
  const signal = opts.signal;
  const onSnapshot = opts.onSnapshot ?? (() => {});
  const maxSnapshots = opts.maxSnapshots ?? Number.POSITIVE_INFINITY;

  const initial = await takeSnapshot(cfg, store, { kind: "watch", label: "watch started" });
  onSnapshot(initial.record, "start");
  let recorded = 1;

  if (opts.once === true || recorded >= maxSnapshots) {
    return { snapshots: recorded, ticks: 0, stopped: false };
  }

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let ticks = 0;
  let running = false;
  let dirty = false;
  /** @type {(value?: unknown) => void} */
  let resolveDone = () => {};
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  /**
   * @returns {Promise<void>}
   */
  const fire = async () => {
    timer = null;
    if (running) {
      // A change landed while the last snapshot was being written; come back.
      dirty = true;
      return;
    }
    running = true;
    dirty = false;
    ticks += 1;
    try {
      const result = await takeSnapshot(cfg, store, { kind: "watch", label: "auto" });
      if (result.recorded) {
        recorded += 1;
        onSnapshot(result.record, "change");
      } else {
        onSnapshot(null, "unchanged");
      }
    } catch (err) {
      onSnapshot(null, `error: ${/** @type {Error} */ (err).message}`);
    } finally {
      running = false;
      if (dirty && timer === null) schedule();
      if (recorded >= maxSnapshots) finish(true);
    }
  };

  /**
   * @returns {void}
   */
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      void fire();
    }, debounceMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  /**
   * @param {boolean} stopped
   * @returns {void}
   */
  const finish = (stopped) => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    watcher.close();
    resolveDone();
    void stopped;
  };

  const watcher = fsWatch(cfg.root, { recursive: true }, (_event, filename) => {
    if (filename === null) {
      schedule();
      return;
    }
    const rel = String(filename).split(path.sep).join("/");
    if (rel === "") return;
    // Watching the store would make every snapshot trigger the next one. Any
    // path with an excluded segment — `.rewind/log.jsonl`, `node_modules/...` —
    // is skipped for the same reason it is skipped during a scan.
    if (isExcluded(cfg, rel, false)) return;
    schedule();
  });

  watcher.on("error", (err) => {
    onSnapshot(null, `watcher error: ${err.message}`);
    finish(false);
  });

  if (signal !== undefined) {
    if (signal.aborted) finish(true);
    else signal.addEventListener("abort", () => finish(true), { once: true });
  }

  await done;
  return { snapshots: recorded, ticks, stopped: signal?.aborted === true };
}
