import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { compareEntries } from "../src/plan.js";
import { scanTree } from "../src/scan.js";
import { rewindTo } from "../src/undo.js";
import { exists, fingerprint, open, read, snap, workspace, write } from "./helpers.js";

/**
 * Make a mess on top of a snapshot and hand back everything needed to rewind it.
 *
 * @param {import("node:test").TestContext} t
 */
async function mess(t) {
  const root = await workspace(t);
  await write(root, {
    "src/app.js": "version one\n",
    "docs/guide.md": "a guide\n",
    "empty/.gitkeep": "",
    "run.sh": "#!/bin/sh\necho hi\n",
  });
  await chmod(path.join(root, "run.sh"), 0o755);
  const base = await snap(root, {}, { label: "base" });
  const { cfg, store } = await open(root);

  // The kind of damage an agent does in one step: edit, add, delete.
  await write(root, {
    "src/app.js": "version two, broken\n",
    "src/new.js": "brand new\n",
    "junk.txt": "junk\n",
    "deep/nested/file.txt": "nested\n",
  });
  await rm(path.join(root, "docs/guide.md"));

  return { root, cfg, store, base };
}

test("an undo restores edits, deletions and additions alike", async (t) => {
  const { root, cfg, store, base } = await mess(t);

  const result = await rewindTo(cfg, store, base.record, { yes: true });
  assert.equal(result.outcome, "applied");
  assert.equal(await read(root, "src/app.js"), "version one\n");
  assert.equal(await read(root, "docs/guide.md"), "a guide\n");
  assert.equal(await exists(root, "src/new.js"), false);
  assert.equal(await exists(root, "junk.txt"), false);
  assert.equal(await exists(root, "deep/nested/file.txt"), false);
});

test("the plan is applied exactly — a rescan matches the target manifest", async (t) => {
  const { root, cfg, store, base } = await mess(t);
  const target = await store.readManifest(base.record.manifest);

  const result = await rewindTo(cfg, store, base.record, { yes: true });
  assert.equal(result.outcome, "applied");

  const after = await scanTree(cfg, { store, writeObjects: false });
  assert.deepEqual(
    compareEntries(target, after.entries),
    [],
    "after a successful undo the tree must equal the snapshot, not merely look like it",
  );
});

test("a dry run reports the plan and changes absolutely nothing", async (t) => {
  const { root, cfg, store, base } = await mess(t);
  const before = await fingerprint(root);
  const objectsBefore = (await store.stat()).objects;
  const logBefore = (await store.readLog()).length;

  const result = await rewindTo(cfg, store, base.record, { dryRun: true });
  assert.equal(result.outcome, "planned");
  assert.ok(result.plan.steps.length > 0, "there is real work to do");

  assert.equal(await fingerprint(root), before, "not one byte, mode or mtime moved");
  assert.equal((await store.stat()).objects, objectsBefore, "a dry run writes no objects");
  assert.equal((await store.readLog()).length, logBefore, "and no log line");
});

test("an undo without an explicit yes changes nothing", async (t) => {
  const { root, cfg, store, base } = await mess(t);
  const before = await fingerprint(root);

  const result = await rewindTo(cfg, store, base.record, { yes: false });
  assert.equal(result.outcome, "planned");
  assert.equal(await fingerprint(root), before);
});

test("an undo is itself undoable", async (t) => {
  const { root, cfg, store, base } = await mess(t);
  const messy = await fingerprint(root);

  const first = await rewindTo(cfg, store, base.record, { yes: true });
  assert.equal(first.outcome, "applied");
  assert.notEqual(await fingerprint(root), messy);
  assert.ok(first.safety !== null, "the replaced state was captured before anything was touched");

  // The safety snapshot is the state that was just replaced, so rewinding to it
  // puts the mess back exactly.
  const second = await rewindTo(cfg, store, first.safety, { yes: true });
  assert.equal(second.outcome, "applied");
  assert.equal(await fingerprint(root), messy, "the mess came back byte for byte");
});

test("rewinding to where you already are is a no-op, not a rewrite", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "hello\n" });
  const base = await snap(root);
  const { cfg, store } = await open(root);
  const before = await fingerprint(root);

  const result = await rewindTo(cfg, store, base.record, { yes: true });
  assert.equal(result.outcome, "noop");
  assert.equal(result.plan.steps.length, 0);
  assert.equal(await fingerprint(root), before);
});

test("an empty directory comes back", async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, "kept-empty"), { recursive: true });
  await write(root, { "a.txt": "x" });
  const base = await snap(root);

  const { cfg, store } = await open(root);
  await rm(path.join(root, "kept-empty"), { recursive: true });
  await write(root, { "junk.txt": "junk" });

  const result = await rewindTo(cfg, store, base.record, { yes: true });
  assert.equal(result.outcome, "applied");
  const st = await stat(path.join(root, "kept-empty"));
  assert.ok(st.isDirectory(), "an empty directory is part of the tree and is restored");
});

test("the executable bit comes back", async (t) => {
  const { root, cfg, store, base } = await mess(t);
  await chmod(path.join(root, "run.sh"), 0o644);

  const result = await rewindTo(cfg, store, base.record, { yes: true });
  assert.equal(result.outcome, "applied");
  const st = await stat(path.join(root, "run.sh"));
  assert.equal(st.mode & 0o111, 0o111, "a restored script is still runnable");
});

test("a symlink is restored as a symlink", async (t) => {
  const root = await workspace(t);
  await write(root, { "target.txt": "the target\n" });
  await symlink("target.txt", path.join(root, "link.txt"));
  const base = await snap(root);

  const { cfg, store } = await open(root);
  await rm(path.join(root, "link.txt"));
  await write(root, { "link.txt": "now a regular file\n" });

  const result = await rewindTo(cfg, store, base.record, { yes: true });
  assert.equal(result.outcome, "applied");
  // lstat, not stat: stat would follow the link and report the target's type.
  const st = await lstat(path.join(root, "link.txt"));
  assert.ok(st.isSymbolicLink(), "the file type is part of the snapshot");
  assert.equal(await read(root, "link.txt"), "the target\n");
});

test("a missing object refuses the whole undo instead of restoring half of it", async (t) => {
  const { root, cfg, store, base } = await mess(t);
  const before = await fingerprint(root);

  // Remove one object the snapshot needs. Every other file is restorable, which
  // is exactly the situation that must not turn into a partial restore.
  const manifest = await store.readManifest(base.record.manifest);
  const entry = manifest["src/app.js"];
  assert.equal(entry?.t, "f");
  if (entry?.t === "f") await rm(store.objectPath(entry.h));

  const result = await rewindTo(cfg, store, base.record, { yes: true });
  assert.equal(result.outcome, "refused");
  assert.equal(result.applied, null);
  assert.equal(await fingerprint(root), before, "nothing was touched");
  assert.match(result.plan.refusals[0]?.why ?? "", /missing from the store/);
});

test("a corrupt object is reported as a failure and the file is left alone", async (t) => {
  const { root, cfg, store, base } = await mess(t);
  const manifest = await store.readManifest(base.record.manifest);
  const entry = manifest["src/app.js"];
  assert.equal(entry?.t, "f");
  if (entry?.t === "f") {
    // Present, but no longer the bytes its name claims.
    await writeFile(store.objectPath(entry.h), "tampered\n");
  }

  const result = await rewindTo(cfg, store, base.record, { yes: true });
  assert.equal(result.outcome, "applied");
  assert.equal(result.applied?.failures.length, 1);
  assert.match(result.applied?.failures[0]?.why ?? "", /corrupt/);
  // The live file keeps its (bad) content rather than receiving corrupted bytes
  // that would look like a successful restore.
  assert.equal(await read(root, "src/app.js"), "version two, broken\n");
});

test("a target entry whose contents were never captured is reported, not invented", async (t) => {
  const root = await workspace(t);
  await write(root, { "small.txt": "fine\n", "big.bin": "x".repeat(200) });
  const base = await snap(root, { maxFileSize: 50 });

  const { cfg, store } = await open(root);
  await write(root, { "small.txt": "changed\n" });
  // The oversized file is now gone, and the snapshot cannot bring it back — it
  // recorded that the path existed but never stored its bytes. Saying so is the
  // only honest outcome; inventing an empty file would be worse than the loss.
  await rm(path.join(root, "big.bin"));

  const result = await rewindTo(cfg, store, base.record, { yes: true });
  assert.equal(result.outcome, "applied");
  assert.equal(result.plan.unrestorable.length, 1);
  assert.match(result.plan.unrestorable[0]?.path ?? "", /big\.bin/);
  assert.match(result.plan.unrestorable[0]?.why ?? "", /too-large/);
  assert.equal(await read(root, "small.txt"), "fine\n", "everything restorable was restored");
  assert.equal(await exists(root, "big.bin"), false, "the unrestorable path was not faked");
});

test("a safety snapshot is recorded before and after an applied undo", async (t) => {
  const { cfg, store, base } = await mess(t);
  const before = (await store.readLog()).length;

  await rewindTo(cfg, store, base.record, { yes: true });

  const log = await store.readLog();
  assert.equal(log.length, before + 2, "one snapshot of the present, one of the result");
  const [pre, post] = log.slice(-2);
  assert.match(pre?.label ?? "", /pre-undo/);
  assert.match(post?.label ?? "", /undo →/);
  assert.equal(post?.manifest, base.record.manifest, "the post-undo record points at the target");
});
