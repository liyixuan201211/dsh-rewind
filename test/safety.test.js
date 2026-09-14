/**
 * The safety invariants.
 *
 * These are the reasons this tool is safe to reach for while something is going
 * wrong, so each one is asserted on its own rather than buried in a behaviour
 * test. Every test here describes a way an "undo" could destroy data — the exact
 * failure it exists to prevent — and pins the behaviour that prevents it.
 */
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkManifest, planUndo } from "../src/plan.js";
import { recordExistingManifest } from "../src/snapshot.js";
import { scanTree } from "../src/scan.js";
import { rewindTo } from "../src/undo.js";
import { exists, fingerprint, open, read, snap, workspace, write } from "./helpers.js";

test("a directory is never removed recursively: uncaptured content survives", async (t) => {
  const root = await workspace(t);
  await write(root, { "keep.txt": "baseline\n" });
  await snap(root);
  const { cfg, store } = await open(root);

  // A directory created after the snapshot, holding files the scan deliberately
  // never captured. An `rm -rf` of the directory would destroy them; the plan
  // removes the file it knows about and then asks the filesystem to remove the
  // directory only if it is empty.
  await mkdir(path.join(root, "junkdir/node_modules/pkg"), { recursive: true });
  await writeFile(path.join(root, "junkdir/node_modules/pkg/index.js"), "dependency\n");
  await writeFile(path.join(root, "junkdir/plain.txt"), "known\n");

  const latest = await store.latest();
  assert.ok(latest !== null);
  const result = await rewindTo(cfg, store, latest, { yes: true });

  assert.equal(result.outcome, "applied");
  assert.equal(await exists(root, "junkdir/plain.txt"), false, "the captured file was removed");
  assert.equal(
    await exists(root, "junkdir/node_modules/pkg/index.js"),
    true,
    "content the snapshot never captured must survive an undo",
  );
  assert.deepEqual(result.applied?.keptDirs, ["junkdir"], "and the reason is reported");
});

test("paths outside the root are never written, even from a hostile manifest", async (t) => {
  const root = await workspace(t);
  const outside = path.join(path.dirname(root), `canary-${path.basename(root)}.txt`);
  await writeFile(outside, "untouched\n");
  await write(root, { "a.txt": "hello\n" });
  await snap(root);
  const { cfg, store } = await open(root);

  // A manifest is JSON in a file. Anything could have written it, so a manifest
  // that names `../canary.txt` must be refused rather than faithfully followed.
  const evil = await store.putManifest({
    [`../${path.basename(outside)}`]: { t: "f", h: "0".repeat(64), s: 3, mode: 0o644 },
  });
  const record = await recordExistingManifest(store, {
    kind: "snap",
    label: "hostile",
    manifest: evil,
    counts: { files: 1, dirs: 0, links: 0, skipped: 0, bytes: 3, reused: 0, excluded: 0 },
  });

  const result = await rewindTo(cfg, store, record, { yes: true });
  assert.equal(result.outcome, "refused");
  assert.match(result.plan.refusals[0]?.why ?? "", /unsafe path/);
  assert.equal(await readFile(outside, "utf8"), "untouched\n");
  await unlink(outside).catch(() => {});
});

test("an absolute path in a manifest is refused too", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "hello\n" });
  await snap(root);
  const { cfg, store } = await open(root);

  const absolute = path.join(root, "..", "absolute-canary.txt");
  const evil = await store.putManifest({
    [absolute]: { t: "f", h: "0".repeat(64), s: 3, mode: 0o644 },
  });
  const record = await recordExistingManifest(store, {
    kind: "snap",
    label: "hostile",
    manifest: evil,
    counts: { files: 1, dirs: 0, links: 0, skipped: 0, bytes: 3, reused: 0, excluded: 0 },
  });

  const result = await rewindTo(cfg, store, record, { yes: true });
  assert.equal(result.outcome, "refused");
  assert.equal(existsSync(absolute), false);
});

test("a manifest that is both a file and a parent is refused before anything runs", () => {
  const problems = checkManifest({
    a: { t: "f", h: "x", s: 1, mode: 0o644 },
    "a/b": { t: "f", h: "y", s: 1, mode: 0o644 },
  });
  assert.ok(problems.length > 0);
  assert.match(problems[0]?.why ?? "", /parent directory/);
});

test("an undo does not write through a symlink pointing outside the root", async (t) => {
  const root = await workspace(t);
  const target = path.join(path.dirname(root), `link-target-${path.basename(root)}.txt`);
  await writeFile(target, "original\n");
  await write(root, { "a.txt": "hello\n" });
  await snap(root);
  const { cfg, store } = await open(root);

  // Where the snapshot had a regular file, the tree now has a symlink pointing
  // somewhere else entirely. Writing to that path without unlinking first would
  // follow the link and overwrite the file it points at.
  await writeFile(path.join(root, "a.txt"), "local\n");
  await rm(path.join(root, "a.txt"));
  await symlink(target, path.join(root, "a.txt"));

  const latest = await store.latest();
  assert.ok(latest !== null);
  const result = await rewindTo(cfg, store, latest, { yes: true });

  assert.equal(result.outcome, "applied");
  assert.equal(await readFile(target, "utf8"), "original\n", "the link target was not written through");
  assert.equal(await read(root, "a.txt"), "hello\n");
  await unlink(target).catch(() => {});
});

test("excluded paths are not touched by an undo", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "v1\n", "node_modules/pkg/index.js": "dependency v1\n" });
  await snap(root);
  const { cfg, store } = await open(root);

  await write(root, { "a.txt": "v2\n", "node_modules/pkg/index.js": "dependency v2\n" });

  const latest = await store.latest();
  assert.ok(latest !== null);
  const result = await rewindTo(cfg, store, latest, { yes: true });

  assert.equal(result.outcome, "applied");
  assert.equal(await read(root, "a.txt"), "v1\n");
  assert.equal(
    await read(root, "node_modules/pkg/index.js"),
    "dependency v2\n",
    "excluded paths are outside the snapshot, so they are outside the undo",
  );
});

test("a file whose contents were never captured is not deleted without --force", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "small\n" });
  const base = await snap(root, { maxFileSize: 10 });
  const { cfg, store } = await open(root);

  // Created after the snapshot and too large to capture: the store has no copy,
  // so removing it could not be undone.
  await write(root, { "big.bin": "x".repeat(500) });
  const before = await fingerprint(root);

  const refused = await rewindTo(cfg, store, base.record, { yes: true });
  assert.equal(refused.outcome, "refused");
  assert.match(refused.plan.refusals[0]?.why ?? "", /never captured/);
  assert.equal(await fingerprint(root), before, "a refusal changes nothing");

  const forced = await rewindTo(cfg, store, base.record, { yes: true, force: true });
  assert.equal(forced.outcome, "applied");
  assert.equal(await exists(root, "big.bin"), false, "--force is the documented escape hatch");
});

test("a snapshot taken under a smaller size limit does not expire into a deletion", async (t) => {
  const root = await workspace(t);
  await write(root, { "small.txt": "small\n", "big.bin": "x".repeat(500) });
  const base = await snap(root, { maxFileSize: 10 });
  const { cfg, store } = await open(root);

  // The store remembers that 500-byte files are not captured, so a later undo —
  // with no flags at all — sees the same world the snapshot did. Before the
  // policy was persisted, this run used the 8 MiB default, decided `big.bin` was
  // "new", and deleted the only copy of it.
  const latest = await store.latest();
  assert.ok(latest !== null);
  const result = await rewindTo(cfg, store, latest, { yes: true });

  assert.equal(result.outcome, "noop");
  assert.equal(await exists(root, "big.bin"), true);
  assert.equal(base.record.counts.files, 1, "only the small file was captured");
});

test("a removal is never planned for a path the snapshot could not restore", () => {
  const cfg = /** @type {any} */ ({ excludedNames: new Set(), excludedPaths: new Set(), rules: [], storeRel: null });
  const live = /** @type {import("../src/types.js").Manifest} */ ({
    "big.bin": { t: "x", why: "too-large", s: 500 },
  });
  const target = /** @type {import("../src/types.js").Manifest} */ ({});
  const plan = planUndo(cfg, live, target);
  assert.equal(plan.refusals.length, 1);
  assert.equal(plan.steps.length, 0, "nothing may be planned when the plan is refused");
});

test("an undo only ever imports content that verifies against its own hash", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "the real content\n" });
  const base = await snap(root);
  const { cfg, store } = await open(root);

  const manifest = await store.readManifest(base.record.manifest);
  const entry = manifest["a.txt"];
  assert.equal(entry?.t, "f");
  if (entry?.t === "f") await writeFile(store.objectPath(entry.h), "swapped content\n");

  await write(root, { "a.txt": "user content\n" });
  const latest = await store.latest();
  assert.ok(latest !== null);
  const result = await rewindTo(cfg, store, latest, { yes: true });

  assert.equal(result.outcome, "applied");
  assert.equal(result.applied?.failures.length, 1);
  assert.equal(
    await read(root, "a.txt"),
    "user content\n",
    "unverified bytes are never written over a real file",
  );
});

test("a dry run leaves the filesystem and the store exactly as they were", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "v1\n", "sub/b.txt": "keep\n" });
  const base = await snap(root);
  const { cfg, store } = await open(root);
  await write(root, { "a.txt": "v2\n", "new.txt": "new\n" });
  await rm(path.join(root, "sub/b.txt"));

  const treeBefore = await fingerprint(root);
  const objectsBefore = (await store.stat()).objects;
  const logBefore = (await store.readLog()).length;

  const result = await rewindTo(cfg, store, base.record, { dryRun: true, yes: true });
  assert.equal(result.outcome, "planned");
  assert.equal(await fingerprint(root), treeBefore);
  assert.equal((await store.stat()).objects, objectsBefore);
  assert.equal((await store.readLog()).length, logBefore);
});

test("the log is append-only: an undo adds records, never rewrites them", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "v1\n" });
  const base = await snap(root);
  const { cfg, store } = await open(root);
  await write(root, { "a.txt": "v2\n" });

  const before = await store.readLog();
  await rewindTo(cfg, store, base.record, { yes: true });
  const after = await store.readLog();

  assert.equal(after.length, before.length + 2);
  assert.deepEqual(after.slice(0, before.length), before, "existing history is untouched");
});

test("a snapshot of a directory with an unreadable subdirectory still works", async (t) => {
  const root = await workspace(t);
  await write(root, { "readable/a.txt": "fine\n", "locked/b.txt": "hidden\n" });
  await chmod(path.join(root, "locked"), 0o000);

  const { cfg, store } = await open(root);
  const scan = await scanTree(cfg, { store });

  // Running as root (CI containers) defeats the permission bits entirely, so
  // only assert the outcome when the directory really is unreadable.
  const readable = await readFile(path.join(root, "locked/b.txt"), "utf8").then(
    () => true,
    () => false,
  );
  assert.equal(scan.entries["readable/a.txt"]?.t, "f", "a locked sibling does not abort the scan");
  if (!readable) {
    assert.equal(scan.entries["locked"]?.t, "d", "the directory itself is still recorded");
    assert.ok(scan.skipped.some((s) => s.why === "unreadable-directory"));
  }
  await chmod(path.join(root, "locked"), 0o755);
});

test("every removal is planned before any write", () => {
  // This ordering is load-bearing, not cosmetic. A write to a path that is
  // currently a symlink is only safe because the symlink's own removal is
  // planned earlier in the same plan — the link is gone before anything is
  // created beneath it. If a refactor ever interleaved these, an undo could
  // write outside the root; this test fails first.
  const cfg = /** @type {any} */ ({
    excludedNames: new Set(),
    excludedPaths: new Set(),
    rules: [],
    storeRel: null,
  });
  /** @param {string} h */
  const file = (h) => ({ t: "f", h, s: 1, mode: 0o644 });
  const live = /** @type {import("../src/types.js").Manifest} */ ({
    "a.txt": file("1"),
    "gone.txt": file("2"),
    "old/x.txt": file("3"),
    old: { t: "d" },
    link: { t: "l", to: "/somewhere/else" },
  });
  const target = /** @type {import("../src/types.js").Manifest} */ ({
    "a.txt": file("9"),
    "fresh/y.txt": file("4"),
    fresh: { t: "d" },
  });

  const plan = planUndo(cfg, live, target);
  /** @param {string} action */
  const isRemoval = (action) =>
    action === "delete-file" || action === "delete-link" || action === "rmdir";
  const actions = plan.steps.map((step) => step.action);
  const lastRemoval = actions.reduce((acc, action, i) => (isRemoval(action) ? i : acc), -1);
  const firstCreation = actions.findIndex((action) => !isRemoval(action));

  assert.ok(actions.includes("delete-link"), "the symlink is removed");
  assert.ok(actions.includes("write"), "and something is written");
  assert.ok(
    firstCreation === -1 || lastRemoval < firstCreation,
    `every removal must precede every creation, got: ${actions.join(", ")}`,
  );
});

test("a manifest naming a path under a live symlink cannot write outside the root", async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await write(outside, { "victim.txt": "ORIGINAL\n" });
  await write(root, { "a.txt": "safe\n" });
  await snap(root);
  const { cfg, store } = await open(root);

  // The tree contains a symlink to a directory outside the root, and a hostile
  // manifest names a file *under* it. The string ".." never appears, so a check
  // on the path text alone would allow this.
  await symlink(outside, path.join(root, "link"));

  const hash = await store.putObject(Buffer.from("PWNED\n"));
  const evil = await store.putManifest({
    "link/victim.txt": { t: "f", h: hash, s: 6, mode: 0o644 },
  });
  const record = await recordExistingManifest(store, {
    kind: "snap",
    label: "hostile",
    manifest: evil,
    counts: { files: 1, dirs: 0, links: 0, skipped: 0, bytes: 6, reused: 0, excluded: 0 },
  });

  const result = await rewindTo(cfg, store, record, { yes: true });

  // Refused outright: the manifest names a file whose parent directory it never
  // records, and creating parents on the fly is exactly how a write would end up
  // following the symlink. Nothing is created, nothing is removed, and the link
  // is left alone.
  assert.equal(result.outcome, "refused");
  assert.match(result.plan.refusals[0]?.why ?? "", /missing from the manifest/);
  assert.equal(result.applied, null);
  assert.equal(
    await readFile(path.join(outside, "victim.txt"), "utf8"),
    "ORIGINAL\n",
    "nothing may be written through a symlink, and nothing outside the root may change",
  );
  assert.equal(
    (await lstat(path.join(root, "link"))).isSymbolicLink(),
    true,
    "a refusal leaves the symlink where it was",
  );
});

test("the store is created owner-only", async (t) => {
  const root = await workspace(t);
  const { store } = await open(root);
  if (process.platform === "win32") return; // mode bits are not a thing there
  const info = await stat(store.dir);
  assert.equal(
    info.mode & 0o077,
    0,
    "the store holds plaintext file contents, so no group or other access",
  );
});
