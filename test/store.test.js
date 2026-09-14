import assert from "node:assert/strict";
import { appendFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { sha256 } from "../src/util.js";
import { Store, StoreError } from "../src/store.js";
import { open, workspace } from "./helpers.js";

test("objects are addressed by content and stored once", async (t) => {
  const root = await workspace(t);
  const { store } = await open(root);

  const one = Buffer.from("same bytes\n");
  const two = Buffer.from("same bytes\n");
  const other = Buffer.from("different\n");

  const h1 = await store.putObject(one);
  const h2 = await store.putObject(two);
  const h3 = await store.putObject(other);

  assert.equal(h1, h2, "identical content has one name");
  assert.notEqual(h1, h3);
  assert.equal(h1, sha256(one));

  const stats = await store.stat();
  assert.equal(stats.objects, 2, "the duplicate was not written twice");

  // Sharded two hex characters deep, so a directory never holds millions of
  // entries on a filesystem that struggles with that.
  const shard = h1.slice(0, 2);
  assert.deepEqual(await readdir(path.join(store.objectsDir, shard)), [h1]);
});

test("a corrupted object is detected instead of restored", async (t) => {
  const root = await workspace(t);
  const { store } = await open(root);
  const hash = await store.putObject(Buffer.from("trustworthy\n"));

  assert.equal((await store.readObject(hash)).toString(), "trustworthy\n");

  // Rewrite the object in place. Its name is the hash of its contents, so the
  // mismatch must be caught: restoring it would write the wrong bytes over a
  // real file while reporting success.
  await writeFile(store.objectPath(hash), "tampered\n");
  await assert.rejects(() => store.readObject(hash), (err) => {
    assert.ok(err instanceof StoreError);
    assert.match(err.message, /corrupt/);
    return true;
  });
});

test("manifests are canonical, so an unchanged tree has one hash", async (t) => {
  const root = await workspace(t);
  const { store } = await open(root);

  const a = await store.putManifest({
    "b.txt": { t: "f", h: "2", s: 1, mode: 0o644 },
    "a.txt": { t: "f", h: "1", s: 1, mode: 0o644 },
  });
  const b = await store.putManifest({
    "a.txt": { t: "f", h: "1", s: 1, mode: 0o644 },
    "b.txt": { t: "f", h: "2", s: 1, mode: 0o644 },
  });
  assert.equal(a, b, "insertion order must not change the hash");

  const read = await store.readManifest(a);
  assert.deepEqual(Object.keys(read), ["a.txt", "b.txt"], "keys come back sorted");
});

test("a missing manifest is an error, not an empty tree", async (t) => {
  const root = await workspace(t);
  const { store } = await open(root);
  await assert.rejects(() => store.readManifest("0".repeat(64)), (err) => {
    assert.ok(err instanceof StoreError);
    assert.match(err.message, /missing/);
    return true;
  });
});

test("the log survives a process killed mid-append", async (t) => {
  const root = await workspace(t);
  const { store } = await open(root);
  await store.appendRecord({
    v: 1,
    id: "20260101T000000Z-aaaa",
    seq: 1,
    time: new Date().toISOString(),
    kind: "snap",
    label: "",
    manifest: "0".repeat(64),
    parent: null,
    parentManifest: null,
    counts: { files: 0, dirs: 0, links: 0, skipped: 0, bytes: 0, reused: 0, excluded: 0 },
    unchanged: false,
  });

  // A half-written final line is exactly what a SIGKILL during appendFile
  // leaves behind. It must be ignored rather than treated as corruption.
  await appendFile(store.logPath, '{"v":1,"id":"20260101T0000');

  const log = await store.readLog();
  assert.equal(log.length, 1);
  assert.equal(log[0]?.id, "20260101T000000Z-aaaa");
});

test("the store records which root it belongs to", async (t) => {
  const root = await workspace(t);
  const { store } = await open(root);
  const meta = store.readMeta();
  assert.ok(meta !== null);
  assert.equal(meta.root, root);
  assert.equal(meta.tool, "dsh-rewind");
});
