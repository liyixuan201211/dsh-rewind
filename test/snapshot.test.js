import assert from "node:assert/strict";
import { chmod, mkdir, readFile, symlink, utimes } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { scanTree } from "../src/scan.js";
import { takeSnapshot } from "../src/snapshot.js";
import { open, snap, workspace, write } from "./helpers.js";

test("a scan records files, directories and symlinks", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "hello", "sub/b.txt": "nested", "empty/.keep": "" });
  // An empty directory is worth recording: a rewind that dropped it would not
  // actually restore the tree.
  await mkdir(path.join(root, "truly-empty"), { recursive: true });
  await symlink("a.txt", path.join(root, "link.txt"));

  const { cfg, store } = await open(root);
  const scan = await scanTree(cfg, { store });

  const a = scan.entries["a.txt"];
  assert.equal(a?.t, "f");
  assert.equal(a?.t === "f" ? a.s : -1, 5);
  assert.equal(a?.t === "f" ? a.h.length : 0, 64, "a sha-256, not a placeholder");
  assert.equal(scan.entries["sub"]?.t, "d");
  assert.equal(scan.entries["truly-empty"]?.t, "d");
  assert.deepEqual(scan.entries["link.txt"], { t: "l", to: "a.txt" });
  assert.equal(scan.stats.files, 3);
  assert.equal(scan.stats.links, 1);
});

test("a symlink is recorded, never followed", async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await write(outside, { "secret.txt": "not yours" });
  await mkdir(path.join(root, "in"), { recursive: true });
  await symlink(outside, path.join(root, "in", "escape"));

  const { cfg, store } = await open(root);
  const scan = await scanTree(cfg, { store });

  assert.deepEqual(scan.entries["in/escape"], { t: "l", to: outside });
  const names = Object.keys(scan.entries);
  assert.equal(
    names.some((n) => n.includes("secret.txt")),
    false,
    "following the link would have read a file outside the root",
  );
});

test("excluded directories are pruned and never hashed", async (t) => {
  const root = await workspace(t);
  await write(root, {
    "keep.txt": "kept",
    "node_modules/pkg/index.js": "dependency",
    ".git/config": "[core]",
    "dist/bundle.js": "built",
  });

  const { cfg, store } = await open(root);
  const scan = await scanTree(cfg, { store });
  const names = Object.keys(scan.entries);

  assert.deepEqual(names, ["keep.txt"]);
  assert.ok(scan.stats.excluded >= 3);
});

test("a file too large to capture is recorded, not silently skipped", async (t) => {
  const root = await workspace(t);
  await write(root, { "big.bin": "x".repeat(100), "small.txt": "y" });

  const { cfg, store } = await open(root, { maxFileSize: 10 });
  const scan = await scanTree(cfg, { store });

  assert.deepEqual(scan.entries["big.bin"], { t: "x", why: "too-large", s: 100 });
  assert.equal(scan.entries["small.txt"]?.t, "f");
  assert.equal(scan.skipped.length, 1);
});

test("an executable bit survives into the manifest", async (t) => {
  const root = await workspace(t);
  await write(root, { "run.sh": "#!/bin/sh\necho hi\n" });
  await chmod(path.join(root, "run.sh"), 0o755);

  const { cfg, store } = await open(root);
  const scan = await scanTree(cfg, { store });
  const entry = scan.entries["run.sh"];
  assert.equal(entry?.t, "f");
  assert.equal((entry?.t === "f" ? entry.mode : 0) & 0o111, 0o111, "the executable bit is recorded");
});

test("unchanged files reuse their hash instead of being re-read", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one", "b.txt": "two" });
  await snap(root);
  const { cfg, store } = await open(root);

  // The cache is what remembers a file's hash without re-reading it. It is
  // advisory: a stale or missing cache costs a re-read and nothing else.
  const cache = await store.loadStatCache();
  assert.equal(Object.keys(cache).length, 2);

  const scan = await scanTree(cfg, { store, cache });
  assert.equal(scan.stats.reused, 2);

  // A forced rehash must produce the same answer — the shortcut is an
  // optimisation, not a different notion of change.
  const rehashed = await scanTree(cfg, { store, cache, rehash: true });
  assert.equal(rehashed.stats.reused, 0);
  const a = scan.entries["a.txt"];
  const b = rehashed.entries["a.txt"];
  assert.equal(a?.t === "f" ? a.h : "", b?.t === "f" ? b.h : "different");
});

test("the manifest is content, not timestamps", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "same content" });
  await snap(root);

  // Change only the mtime. The content hash is the source of truth, so this must
  // not read as a change: restoring a file just because it was touched would
  // rewrite identical bytes and reset permissions for no reason.
  const future = new Date(Date.now() + 60_000);
  await utimes(path.join(root, "a.txt"), future, future);

  const second = await snap(root);
  assert.equal(second.unchanged, true);
  assert.equal(second.record.manifest, second.record.parentManifest);

  // An entry has no mtime field at all — that is the property being protected.
  const { store } = await open(root);
  const manifest = await store.readManifest(second.record.manifest);
  assert.deepEqual(Object.keys(manifest["a.txt"] ?? {}).sort(), ["h", "mode", "s", "t"]);
});

test("a chmod is a change, and is captured", async (t) => {
  const root = await workspace(t);
  await write(root, { "run.sh": "#!/bin/sh\n" });
  await chmod(path.join(root, "run.sh"), 0o755);
  const first = await snap(root);

  await chmod(path.join(root, "run.sh"), 0o644);
  const second = await snap(root);

  assert.equal(second.unchanged, false, "permissions are part of the tree");
  const { store } = await open(root);
  const before = await store.readManifest(first.record.manifest);
  const after = await store.readManifest(second.record.manifest);
  assert.equal(before["run.sh"]?.t === "f" ? before["run.sh"].mode : 0, 0o755);
  assert.equal(after["run.sh"]?.t === "f" ? after["run.sh"].mode : 0, 0o644);
});

test("an identical snapshot is recorded and marked unchanged", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one" });
  const first = await snap(root);
  assert.equal(first.unchanged, false, "the first snapshot has nothing to compare against");

  const second = await snap(root);
  assert.equal(second.unchanged, true);
  assert.equal(second.recorded, true, "an explicit snapshot is a fact worth recording");
  assert.equal(second.record.manifest, first.record.manifest);
});

test("a watch tick that changed nothing is not recorded", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one" });
  const { cfg, store } = await open(root);

  const first = await takeSnapshot(cfg, store, { kind: "watch", label: "start" });
  assert.equal(first.recorded, true);

  const idle = await takeSnapshot(cfg, store, { kind: "watch", label: "auto" });
  assert.equal(idle.unchanged, true);
  assert.equal(idle.recorded, false, "an idle timer tick must not bury the interesting entries");

  const log = await store.readLog();
  assert.equal(log.length, 1);

  // A real change on a watch tick is recorded.
  await write(root, { "a.txt": "two" });
  const changed = await takeSnapshot(cfg, store, { kind: "watch", label: "auto" });
  assert.equal(changed.unchanged, false);
  assert.equal(changed.recorded, true);
  assert.equal((await store.readLog()).length, 2);
});

test("snapshot ids are unique even within the same second", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one" });
  const ids = new Set();
  for (let i = 0; i < 5; i += 1) {
    const result = await snap(root, {}, { label: `run ${i}` });
    ids.add(result.record.id);
  }
  assert.equal(ids.size, 5);
});

test("a snapshot's counts describe what was captured", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "12345", "sub/b.txt": "678" });
  const result = await snap(root);
  assert.equal(result.record.counts.files, 2);
  assert.equal(result.record.counts.dirs, 1);
  assert.equal(result.record.counts.bytes, 8);
});

test("the log line and the manifest agree", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "hello" });
  const result = await snap(root);
  const { store } = await open(root);
  const manifest = await store.readManifest(result.record.manifest);
  const entry = manifest["a.txt"];
  assert.equal(entry?.t, "f");
  const object = entry?.t === "f" ? await store.readObject(entry.h) : Buffer.alloc(0);
  assert.equal(object.toString(), "hello");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "hello");
});
