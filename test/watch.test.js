/**
 * `rewind watch` — the automatic mode.
 *
 * These tests involve real timers and a real filesystem watcher, so they use a
 * short debounce and wait on the callback rather than on a fixed sleep. The
 * coalescing test doubles as a guard against the watcher triggering itself: if
 * writes into the store counted as changes, the log would keep growing.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { watchDirectory } from "../src/watch.js";
import { open, workspace, write } from "./helpers.js";

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("--once takes exactly one snapshot and stops", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  const { cfg, store } = await open(root);

  const result = await watchDirectory(cfg, store, { once: true, debounceMs: 10 });
  assert.equal(result.snapshots, 1);
  assert.equal(result.stopped, false);
  assert.equal((await store.readLog()).length, 1);
});

test("a change made while watching is captured automatically", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  const { cfg, store } = await open(root);

  /** @type {() => void} */
  let started = () => {};
  const startedPromise = new Promise((resolve) => {
    started = () => resolve(undefined);
  });
  /** @type {() => void} */
  let changed = () => {};
  const changedPromise = new Promise((resolve) => {
    changed = () => resolve(undefined);
  });

  const controller = new AbortController();
  const running = watchDirectory(cfg, store, {
    debounceMs: 120,
    signal: controller.signal,
    onSnapshot: (_record, why) => {
      if (why === "start") started();
      if (why === "change") changed();
    },
  });

  await startedPromise;
  await write(root, { "a.txt": "two\n" });

  const outcome = await Promise.race([
    changedPromise.then(() => "changed"),
    sleep(8000).then(() => "timeout"),
  ]);
  controller.abort();
  await running;

  assert.equal(outcome, "changed", "the watcher saw the edit");
  const log = await store.readLog();
  assert.equal(log.length, 2);
  assert.equal(log[1]?.kind, "watch");
  assert.equal(log[1]?.unchanged, false);
});

test("rapid edits coalesce into a single snapshot", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  const { cfg, store } = await open(root);

  /** @type {() => void} */
  let started = () => {};
  const startedPromise = new Promise((resolve) => {
    started = () => resolve(undefined);
  });

  const controller = new AbortController();
  const running = watchDirectory(cfg, store, {
    debounceMs: 300,
    signal: controller.signal,
    onSnapshot: (_record, why) => {
      if (why === "start") started();
    },
  });

  // Wait for the initial snapshot before touching anything, or the writes land
  // inside it and there is no change left for the watcher to see.
  await startedPromise;

  // Three files in the same tick: one debounce window, one snapshot.
  await write(root, { "a.txt": "two\n", "b.txt": "new\n", "c.txt": "new\n" });
  await sleep(1500);
  controller.abort();
  await running;

  const log = await store.readLog();
  assert.equal(
    log.length,
    2,
    "one initial snapshot plus one coalesced snapshot — and the store's own writes must not feed the watcher",
  );
  assert.equal(log[1]?.counts.files, 3);
});

test("aborting stops the watcher", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  const { cfg, store } = await open(root);

  const controller = new AbortController();
  const running = watchDirectory(cfg, store, {
    debounceMs: 50,
    signal: controller.signal,
    onSnapshot: () => {},
  });
  await sleep(120);
  controller.abort();
  const result = await running;
  assert.equal(result.stopped, true);

  // Nothing after the abort changes the log.
  const before = (await store.readLog()).length;
  await write(root, { "a.txt": "after abort\n" });
  await sleep(300);
  assert.equal((await store.readLog()).length, before);
});

test("an already-aborted signal stops immediately", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  const { cfg, store } = await open(root);

  const controller = new AbortController();
  controller.abort();
  const result = await watchDirectory(cfg, store, {
    debounceMs: 50,
    signal: controller.signal,
    onSnapshot: () => {},
  });
  assert.equal(result.stopped, true);
  assert.equal(result.snapshots, 1, "the initial snapshot is still taken");
});

test("maxSnapshots stops the loop", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  const { cfg, store } = await open(root);

  const running = watchDirectory(cfg, store, {
    debounceMs: 80,
    maxSnapshots: 2,
    onSnapshot: () => {},
  });
  await sleep(120);
  await write(root, { "a.txt": "two\n" });

  const result = await Promise.race([running, sleep(8000).then(() => null)]);
  assert.ok(result !== null, "the loop stopped on its own");
  assert.equal(result.snapshots, 2);
});
