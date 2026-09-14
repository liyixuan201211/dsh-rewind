import assert from "node:assert/strict";
import test from "node:test";

import {
  isExcluded,
  loadConfig,
  matchIgnore,
  parseIgnore,
  unsafePath,
} from "../src/config.js";
import { open, snap, workspace, write } from "./helpers.js";

test("unsafePath refuses anything that could escape the root", () => {
  assert.equal(unsafePath("src/a.js"), null);
  assert.equal(unsafePath("a/b/c"), null);
  assert.match(String(unsafePath("../etc/passwd")), /\.\./);
  assert.match(String(unsafePath("a/../../b")), /\.\./);
  assert.match(String(unsafePath("/etc/passwd")), /absolute/);
  assert.match(String(unsafePath("C:\\Windows\\system32")), /absolute/);
  assert.match(String(unsafePath("")), /empty/);
  assert.match(String(unsafePath("a//b")), /empty path segment/);
  assert.match(String(unsafePath("a\0b")), /NUL/);
});

test("parseIgnore handles the subset people actually write", () => {
  const rules = parseIgnore(
    [
      "# a comment",
      "",
      "*.log",
      "!keep.log",
      "build/",
      "/anchored.txt",
      "docs/**/*.md",
    ].join("\n"),
  );
  assert.equal(matchIgnore(rules, "a/thing.log", false), true);
  assert.equal(matchIgnore(rules, "keep.log", false), false, "negation wins when it comes last");
  assert.equal(matchIgnore(rules, "build", true), true);
  assert.equal(matchIgnore(rules, "build", false), false, "a dir-only rule ignores files");
  assert.equal(matchIgnore(rules, "anchored.txt", false), true);
  assert.equal(matchIgnore(rules, "sub/anchored.txt", false), false, "leading / anchors to the root");
  assert.equal(matchIgnore(rules, "docs/a/b/c.md", false), true);
  assert.equal(matchIgnore(rules, "src/main.js", false), false);
});

test("defaults leave out dependencies and build output, not data", async () => {
  const cfg = await loadConfig({ root: "/tmp" });
  assert.equal(isExcluded(cfg, "node_modules/x/index.js", false), true);
  assert.equal(isExcluded(cfg, ".git/config", false), true);
  assert.equal(isExcluded(cfg, "dist/bundle.js", false), true);
  assert.equal(isExcluded(cfg, "build/out.o", false), true);
  // The whole point is being able to get these back, so they are captured.
  assert.equal(isExcluded(cfg, ".env", false), false);
  assert.equal(isExcluded(cfg, "src/index.js", false), false);
  assert.equal(isExcluded(cfg, "data.sqlite", false), false);
});

test("the store excludes itself wherever it lives", async (t) => {
  const root = await workspace(t);
  const cfg = await loadConfig({ root });
  assert.equal(cfg.storeRel, ".rewind");
  assert.equal(isExcluded(cfg, ".rewind/log.jsonl", false), true);

  const outside = await loadConfig({ root, store: `${root}/../elsewhere-store` });
  assert.equal(outside.storeRel, null, "a store outside the root is not a relative path");
});

test("a .rewindignore in the root is honoured", async (t) => {
  const root = await workspace(t);
  await write(root, { ".rewindignore": "*.tmp\nsecrets/\n", "a.tmp": "x", "keep.txt": "y" });
  const cfg = await loadConfig({ root });
  assert.equal(isExcluded(cfg, "a.tmp", false), true);
  assert.equal(isExcluded(cfg, "secrets/key.pem", false), true);
  assert.equal(isExcluded(cfg, "keep.txt", false), false);
});

test("the capture policy is written into the store and adopted afterwards", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "hello" });
  await snap(root, { maxFileSize: 1024, exclude: ["junkdir", "vendor"] });

  const first = await loadConfig({ root });
  assert.equal(first.maxFileSize, 1024);

  // A later run with no flags at all must adopt the store's policy, not the
  // defaults. This is what stops policy drift from turning into deletions.
  const later = await loadConfig({ root });
  assert.equal(later.maxFileSize, 1024);
  assert.equal(isExcluded(later, "junkdir/thing", false), true);
  assert.equal(isExcluded(later, "vendor/lib.js", false), true);
  assert.equal(isExcluded(later, "src/main.js", false), false);

  // An explicit flag still wins for that run.
  const overridden = await loadConfig({ root, maxFileSize: 4096 });
  assert.equal(overridden.maxFileSize, 4096);
});

test("removing an exclusion rule does not un-protect a path", async (t) => {
  const root = await workspace(t);
  await write(root, { "a.txt": "hello" });
  await snap(root, { exclude: ["private"] });

  // The rule is gone from the flags, but the store remembers it. Protection is
  // a union that only grows, so an undo can never delete something a snapshot
  // was told to leave out.
  const later = await loadConfig({ root });
  assert.equal(isExcluded(later, "private/key.pem", false), true);
});
