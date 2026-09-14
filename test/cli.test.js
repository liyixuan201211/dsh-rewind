/**
 * The exit-code contract, exercised through the real process boundary.
 *
 * The codes are the interface a script or an agent reads, so they are asserted
 * by spawning the binary rather than by calling into the library. In particular
 * 4, 5 and 6 all mean "nothing happened", and they must stay distinguishable.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { exists, run, workspace, write } from "./helpers.js";

test("--help explains the exit codes and exits 0", async (t) => {
  const root = await workspace(t);
  const res = run(["--help"], { cwd: root });
  assert.equal(res.code, 0);
  assert.match(res.out, /Exit codes:/);
  assert.match(res.out, /4 {2}undo: the plan is ready/);
});

test("--version prints a version and exits 0", async (t) => {
  const root = await workspace(t);
  const res = run(["--version"], { cwd: root });
  assert.equal(res.code, 0);
  assert.match(res.out.trim(), /^\d+\.\d+\.\d+$/);
});

test("no command prints help and exits 0", async (t) => {
  const root = await workspace(t);
  const res = run([], { cwd: root });
  assert.equal(res.code, 0);
  assert.match(res.out, /rewind — undo what happened/);
});

test("an unknown command or flag is a usage error (2)", async (t) => {
  const root = await workspace(t);
  assert.equal(run(["frobnicate"], { cwd: root }).code, 2);
  assert.equal(run(["snap", "--nonsense"], { cwd: root }).code, 2);
});

test("a read-only command in a fresh directory says so instead of making a store", async (t) => {
  const root = await workspace(t);
  const res = run(["status"], { cwd: root });
  assert.equal(res.code, 0);
  assert.match(res.out, /no store/);
  assert.equal(await exists(root, ".rewind"), false, "reading must not create a store");
});

test("snap, then status clean, then drift is exit 3", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });

  const snap = run(["snap"], { cwd: root });
  assert.equal(snap.code, 0);
  assert.match(snap.out, /snapped/);

  assert.equal(run(["status"], { cwd: root }).code, 0, "clean");
  assert.match(run(["status"], { cwd: root }).out, /clean/);

  await write(root, { "a.txt": "two\n" });
  const drifted = run(["status"], { cwd: root });
  assert.equal(drifted.code, 3, "drift has its own code");
  assert.match(drifted.out, /1 path differs/);
});

test("diff shows what changed, and --stat counts lines", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\ntwo\n" });
  run(["snap"], { cwd: root });
  await write(root, { "a.txt": "one\nTWO\nthree\n" });

  const full = run(["diff"], { cwd: root });
  assert.equal(full.code, 0);
  assert.match(full.out, /--- a\.txt/);
  assert.match(full.out, /^\-two$/m);
  assert.match(full.out, /^\+TWO$/m);
  assert.match(full.out, /^\+three$/m);

  const stat = run(["diff", "--stat"], { cwd: root });
  assert.equal(stat.code, 0);
  assert.match(stat.out, /a\.txt\s+\+2 -1/);
});

test("diff accepts path filters after --", async (t) => {
  const root = await workspace(t);
  await write(root, { "src/a.txt": "one\n", "docs/b.txt": "one\n" });
  run(["snap"], { cwd: root });
  await write(root, { "src/a.txt": "two\n", "docs/b.txt": "two\n" });

  const filtered = run(["diff", "--stat", "--", "src"], { cwd: root });
  assert.equal(filtered.code, 0);
  assert.match(filtered.out, /src\/a\.txt/);
  assert.doesNotMatch(filtered.out, /docs\/b\.txt/);
});

test("undo without --yes prints the plan and exits 4, changing nothing", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  run(["snap"], { cwd: root });
  await write(root, { "a.txt": "two\n" });

  const res = run(["undo"], { cwd: root });
  assert.equal(res.code, 4);
  assert.match(res.out, /Restoring/);
  assert.match(res.out, /--yes/);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "two\n");

  const dry = run(["undo", "--dry-run"], { cwd: root });
  assert.equal(dry.code, 0);
  assert.match(dry.out, /dry run/);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "two\n");
});

test("undo --yes restores, and doing it again is exit 6", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  run(["snap"], { cwd: root });
  await write(root, { "a.txt": "two\n", "new.txt": "new\n" });

  const applied = run(["undo", "last", "--yes"], { cwd: root });
  assert.equal(applied.code, 0);
  assert.match(applied.out, /undo complete/);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "one\n");
  assert.equal(await exists(root, "new.txt"), false);

  const again = run(["undo", "@1", "--yes"], { cwd: root });
  assert.equal(again.code, 6, "nothing to do is its own code");
  assert.match(again.out, /nothing to do/);
});

test("a refusal is exit 5 and changes nothing", async (t) => {
  const root = await workspace(t);
  await write(root, { "small.txt": "ok\n" });
  run(["snap", "--max-file-size", "10"], { cwd: root });
  // Too large to have been captured, and created after the snapshot: removing it
  // could not be undone.
  await write(root, { "big.bin": "x".repeat(500) });

  const res = run(["undo", "last", "--yes"], { cwd: root });
  assert.equal(res.code, 5);
  assert.match(res.out, /refused/);
  assert.equal(await exists(root, "big.bin"), true);
});

test("log --json is machine-readable", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  run(["snap", "--label", "first"], { cwd: root });
  run(["snap"], { cwd: root });

  const res = run(["log", "--json"], { cwd: root });
  assert.equal(res.code, 0);
  const parsed = JSON.parse(res.out);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].label, "first");
  assert.equal(parsed[1].unchanged, true);
});

test("snap --json reports the id and counts", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "12345\n" });
  const res = run(["snap", "--json"], { cwd: root });
  assert.equal(res.code, 0);
  const parsed = JSON.parse(res.out);
  assert.match(parsed.id, /^\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  assert.equal(parsed.counts.files, 1);
});

test("status --json reports the changes", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  run(["snap"], { cwd: root });
  await write(root, { "a.txt": "two\n", "b.txt": "new\n" });

  const res = run(["status", "--json"], { cwd: root });
  assert.equal(res.code, 3);
  const parsed = JSON.parse(res.out);
  assert.equal(parsed.changes.length, 2);
  const paths = /** @type {{ path: string }[]} */ (parsed.changes).map((c) => c.path);
  assert.deepEqual(paths.sort(), ["a.txt", "b.txt"]);
});

test("show prints a file as it was", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "the old contents\n" });
  run(["snap"], { cwd: root });
  await write(root, { "a.txt": "the new contents\n" });

  const res = run(["show", "last:a.txt"], { cwd: root });
  assert.equal(res.code, 0);
  assert.equal(res.out, "the old contents\n");

  const gone = run(["show", "last:nope.txt"], { cwd: root });
  assert.equal(gone.code, 1);
  assert.match(gone.err, /did not exist/);
});

test("exec returns the wrapped command's exit code and undoes it by id", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "clean\n" });

  const failing = run(["exec", "--", process.execPath, "-e", "process.exit(7)"], { cwd: root });
  assert.equal(failing.code, 7, "the wrapper must not swallow the child's status");

  const making = run(
    ["exec", "--", process.execPath, "-e", "require('fs').writeFileSync('made.txt','hi')"],
    { cwd: root },
  );
  assert.equal(making.code, 0);
  assert.equal(await exists(root, "made.txt"), true);
  assert.match(making.err, /rewind undo .* undoes this command/);

  // The id printed for the "before" snapshot removes exactly what the command did.
  const beforeId = /rewind ([\dT]+Z-[0-9a-f]{4}) →/.exec(making.err)?.[1];
  assert.ok(beforeId, "exec prints the before id");
  const undone = run(["undo", String(beforeId), "--yes"], { cwd: root });
  assert.equal(undone.code, 0);
  assert.equal(await exists(root, "made.txt"), false);
});

test("exec needs a command", async (t) => {
  const root = await workspace(t);
  const res = run(["exec"], { cwd: root });
  assert.equal(res.code, 2);
  assert.match(res.err, /exec needs a command/);
});

test("prune drops old snapshots and keeps the newest", async (t) => {
  const root = await workspace(t);
  for (const version of ["one", "two", "three", "four"]) {
    await write(root, { "a.txt": `${version}\n` });
    run(["snap", "--label", version], { cwd: root });
  }

  const dry = run(["prune", "--keep", "2", "--dry-run"], { cwd: root });
  assert.equal(dry.code, 0);
  assert.match(dry.out, /would drop 2 snapshots, keeping 2/);
  assert.equal(JSON.parse(run(["log", "--json"], { cwd: root }).out).length, 4, "dry run kept everything");

  const applied = run(["prune", "--keep", "2"], { cwd: root });
  assert.equal(applied.code, 0);
  const log = JSON.parse(run(["log", "--json"], { cwd: root }).out);
  assert.equal(log.length, 2);
  assert.equal(log[log.length - 1].label, "four", "the present state is never dropped");

  // And what is left can still be restored.
  await write(root, { "a.txt": "broken\n" });
  const undo = run(["undo", "last", "--yes"], { cwd: root });
  assert.equal(undo.code, 0);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "four\n");
});

test("prune --keep rejects nonsense", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  run(["snap"], { cwd: root });
  assert.equal(run(["prune", "--keep", "0"], { cwd: root }).code, 2);
  assert.equal(run(["prune", "--older-than", "yesterday"], { cwd: root }).code, 2);
});

test("doctor reports a healthy store, and catches a corrupted object", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "content\n" });
  run(["snap"], { cwd: root });

  const healthy = run(["doctor", "--verify"], { cwd: root });
  assert.equal(healthy.code, 0);
  assert.match(healthy.out, /ok — every snapshot in the log can be restored/);

  // Corrupt the single object in the store.
  const { readdir } = await import("node:fs/promises");
  const shard = (await readdir(path.join(root, ".rewind/objects")))[0];
  assert.ok(shard);
  const name = (await readdir(path.join(root, ".rewind/objects", String(shard))))[0];
  assert.ok(name);
  await writeFile(path.join(root, ".rewind/objects", String(shard), String(name)), "tampered\n");

  const broken = run(["doctor", "--verify"], { cwd: root });
  assert.equal(broken.code, 1);
  assert.match(broken.out, /corrupt/);
});

test("a .rewindignore keeps paths out of snapshots and out of undos", async (t) => {
  const root = await workspace(t);
  await write(root, { ".rewindignore": "*.log\n", "a.txt": "one\n", "noisy.log": "v1\n" });
  run(["snap"], { cwd: root });
  await write(root, { "a.txt": "two\n", "noisy.log": "v2\n" });

  const status = run(["status", "--json"], { cwd: root });
  const paths = /** @type {{ path: string }[]} */ (JSON.parse(status.out).changes).map((c) => c.path);
  assert.deepEqual(paths, ["a.txt"], "an ignored path is not part of the tree");

  run(["undo", "last", "--yes"], { cwd: root });
  assert.equal(await readFile(path.join(root, "noisy.log"), "utf8"), "v2\n");
});

test("--quiet prints nothing on success", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "one\n" });
  const res = run(["snap", "--quiet"], { cwd: root });
  assert.equal(res.code, 0);
  assert.equal(res.out, "");
});
