import assert from "node:assert/strict";
import test from "node:test";

import { countDiff, diffLines, unifiedDiff } from "../src/diff.js";

test("a single changed line produces a minimal hunk with context", () => {
  const out = unifiedDiff("a\nb\nc\n", "a\nX\nc\n", {
    path: "f.txt",
    fromLabel: "before",
    toLabel: "after",
  });
  assert.equal(
    out,
    [
      "--- f.txt (before)",
      "+++ f.txt (after)",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+X",
      " c",
      "",
    ].join("\n"),
  );
});

test("common prefix and suffix are not reprinted", () => {
  const before = ["one", "two", "three", "four", "five", "six"].join("\n");
  const after = ["one", "two", "three", "FOUR", "five", "six"].join("\n");
  const out = unifiedDiff(before, after, { path: "f" });
  // The file is shorter than twice the context, so one hunk covers all of it,
  // with correct numbering — not a hunk starting at line 1 that lost its context.
  assert.match(out, /^@@ -1,6 \+1,6 @@$/m);
  assert.match(out, /^-four$/m);
  assert.match(out, /^\+FOUR$/m);
  assert.match(out, /^ one$/m, "unchanged lines come back as context with a leading space");
  assert.match(out, /^ six$/m);
});

test("context is limited to three lines around a change in a long file", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 20", "line TWENTY");
  const out = unifiedDiff(before, after, { path: "f" });
  assert.match(out, /^@@ -18,7 \+18,7 @@$/m, "three lines either side of line 20");
  assert.match(out, /^ line 17$/m);
  assert.match(out, /^ line 23$/m);
  assert.doesNotMatch(out, /^ line 16$/m, "context stops at three lines");
});

test("the hunk header counts are right for a pure insertion", () => {
  const out = unifiedDiff("a\nb\n", "a\nnew\nb\n", { path: "f" });
  assert.match(out, /^@@ -1,2 \+1,3 @@$/m);
  assert.match(out, /^ a$/m);
  assert.match(out, /^\+new$/m);
  assert.match(out, /^ b$/m);
});

test("an addition from nothing is all plus lines", () => {
  const out = unifiedDiff("", "brand\nnew\n", { path: "f", fromLabel: "absent" });
  assert.match(out, /^--- f \(absent\)$/m);
  assert.match(out, /^@@ -0,0 \+1,2 @@$/m);
  assert.match(out, /^\+brand$/m);
  assert.match(out, /^\+new$/m);
});

test("a deletion to nothing is all minus lines", () => {
  const out = unifiedDiff("gone\nforever\n", "", { path: "f", toLabel: "absent" });
  assert.match(out, /^@@ -1,2 \+0,0 @@$/m);
  assert.match(out, /^-gone$/m);
  assert.match(out, /^-forever$/m);
});

test("separate changes far apart become separate hunks", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 1\n", "line ONE\n").replace("line 38", "line THIRTY-EIGHT");
  const out = unifiedDiff(before, after, { path: "f" });
  assert.equal(out.match(/^@@/gm)?.length, 2, "two hunks, not one giant one");
});

test("identical input says so instead of printing an empty diff", () => {
  const out = unifiedDiff("same\n", "same\n", { path: "f" });
  assert.match(out, /no textual difference/);
});

test("binary content is named, never mangled into text", () => {
  const out = unifiedDiff(Buffer.from([0, 1, 2, 0]), Buffer.from([0, 3, 4, 0]), { path: "f.bin" });
  assert.match(out, /Binary files differ/);
});

test("an oversized pair reports its size rather than guessing", () => {
  const before = Array.from({ length: 1500 }, (_, i) => `a${i}`).join("\n");
  const after = Array.from({ length: 1500 }, (_, i) => `b${i}`).join("\n");
  const out = unifiedDiff(before, after, { path: "big" });
  assert.match(out, /too large to diff/);
  assert.match(out, /1500 lines → 1500 lines/);
});

test("diffLines describes the whole file, with the shared parts as context", () => {
  // The common prefix is trimmed only while filling the LCS table. The returned
  // sequence covers every line, because a caller cannot reattach context it was
  // never given — the earlier version of this function returned just the middle
  // and every hunk silently lost its context and its line numbers.
  const { ops, tooLarge, prefix } = diffLines(["a", "b"], ["a", "c"]);
  assert.equal(tooLarge, false);
  assert.equal(prefix, 1);
  assert.deepEqual(ops, [
    { type: "eq", text: "a" },
    { type: "del", text: "b" },
    { type: "ins", text: "c" },
  ]);
});

test("countDiff counts added and removed lines", () => {
  assert.deepEqual(countDiff("a\nb\n", "a\nc\nd\n"), {
    added: 2,
    removed: 1,
    tooLarge: false,
    binary: false,
  });
  assert.equal(countDiff("x\n", "x\n").added, 0);
  assert.equal(countDiff(Buffer.from([0]), Buffer.from([1])).binary, true);
});

test("a trailing newline is not a change", () => {
  // A file that ends without a newline differs only in that fact; treating it as
  // a rewritten file would fill every diff with noise.
  const { added, removed } = countDiff("a\nb\n", "a\nb\n");
  assert.equal(added, 0);
  assert.equal(removed, 0);
});
