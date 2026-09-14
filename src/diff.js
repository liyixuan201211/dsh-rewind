/**
 * A unified diff, in about two hundred lines and no dependencies.
 *
 * The algorithm is the plain longest-common-subsequence table, not Myers. That
 * is a deliberate trade: an LCS table is obviously correct (and can be read in
 * one pass), where a bug in a hand-rolled Myers shows up as a plausible-looking
 * diff that is quietly wrong — the worst possible failure for a tool whose
 * output people use to decide whether to throw work away. The table costs
 * O(n·m) memory, so both sides are capped and the common prefix and suffix are
 * trimmed first, which is where the bulk of a typical edit is.
 *
 * When the cap is exceeded the diff says so instead of guessing.
 */
import { isBinary } from "./util.js";

/** Per side, after the common prefix and suffix are trimmed. Enforced. */
export const DIFF_MAX_LINES = 1200;
/** Secondary guard for a lopsided pair; 4M cells is ~16 MB of Int32Array. */
export const DIFF_MAX_CELLS = 4_000_000;

/**
 * @typedef {object} Op
 * @property {"eq" | "del" | "ins"} type
 * @property {string} text
 */

/**
 * @param {string[]} aLines
 * @param {string[]} bLines
 * @returns {{ ops: Op[], tooLarge: boolean, prefix: number, suffix: number }}
 */
export function diffLines(aLines, bLines) {
  let prefix = 0;
  while (prefix < aLines.length && prefix < bLines.length && aLines[prefix] === bLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < aLines.length - prefix &&
    suffix < bLines.length - prefix &&
    aLines[aLines.length - 1 - suffix] === bLines[bLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const a = aLines.slice(prefix, aLines.length - suffix);
  const b = bLines.slice(prefix, bLines.length - suffix);
  const n = a.length;
  const m = b.length;

  // Both caps are enforced. The per-side cap is the one that normally bites and
  // it bounds memory outright (1200² cells is ~6 MB); the cell cap is the guard
  // for a very lopsided pair if the line cap is ever raised.
  if (n > DIFF_MAX_LINES || m > DIFF_MAX_LINES || n * m > DIFF_MAX_CELLS) {
    return { ops: [], tooLarge: true, prefix, suffix };
  }

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const ai = a[i];
      const bj = b[j];
      table[i * width + j] =
        ai === bj
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }

  /** @type {Op[]} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i];
    const bj = b[j];
    if (ai === bj) {
      ops.push({ type: "eq", text: /** @type {string} */ (ai) });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push({ type: "del", text: /** @type {string} */ (ai) });
      i += 1;
    } else {
      ops.push({ type: "ins", text: /** @type {string} */ (bj) });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "del", text: /** @type {string} */ (a[i]) });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "ins", text: /** @type {string} */ (b[j]) });
    j += 1;
  }

  // The trim above is only an optimisation for the LCS table. Callers need a
  // sequence that describes the *whole* file — otherwise every hunk numbering
  // starts at 1 and all the unchanged context vanishes from the output, which is
  // exactly the bug this line pair exists to prevent. Reattach the trimmed lines.
  const full = [
    ...aLines.slice(0, prefix).map((text) => /** @type {Op} */ ({ type: "eq", text })),
    ...ops,
    ...aLines.slice(aLines.length - suffix).map((text) => /** @type {Op} */ ({ type: "eq", text })),
  ];

  return { ops: full, tooLarge: false, prefix, suffix };
}

/**
 * Group changed operations into hunks, merging any two changes separated by no
 * more than `2 × context` unchanged lines — the same rule git uses.
 *
 * @param {Op[]} ops
 * @param {number} context
 * @returns {{ start: number, end: number }[]}
 */
function hunks(ops, context) {
  /** @type {number[]} */
  const changed = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]?.type !== "eq") changed.push(i);
  }
  /** @type {{ start: number, end: number }[]} */
  const out = [];
  let k = 0;
  while (k < changed.length) {
    const first = /** @type {number} */ (changed[k]);
    let last = first;
    while (k + 1 < changed.length) {
      const next = /** @type {number} */ (changed[k + 1]);
      if (next - last - 1 > context * 2) break;
      k += 1;
      last = next;
    }
    k += 1;
    out.push({
      start: Math.max(0, first - context),
      end: Math.min(ops.length - 1, last + context),
    });
  }
  return out;
}

/**
 * @param {Op[]} ops
 * @returns {{ o: number, n: number }[]} line numbers immediately before each op
 */
function lineNumbers(ops) {
  /** @type {{ o: number, n: number }[]} */
  const before = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    before.push({ o, n });
    if (op.type !== "ins") o += 1;
    if (op.type !== "del") n += 1;
  }
  return before;
}

/**
 * Added/removed line counts, for `diff --stat`.
 *
 * @param {Buffer | string} before
 * @param {Buffer | string} after
 * @returns {{ added: number, removed: number, tooLarge: boolean, binary: boolean }}
 */
export function countDiff(before, after) {
  const a = Buffer.isBuffer(before) ? before : Buffer.from(before, "utf8");
  const b = Buffer.isBuffer(after) ? after : Buffer.from(after, "utf8");
  if (isBinary(a) || isBinary(b)) return { added: 0, removed: 0, tooLarge: false, binary: true };
  const { ops, tooLarge } = diffLines(toLines(a.toString("utf8")), toLines(b.toString("utf8")));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "ins") added += 1;
    else if (op.type === "del") removed += 1;
  }
  return { added, removed, tooLarge, binary: false };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
const toLines = (text) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/**
 * @param {Buffer | string} before
 * @param {Buffer | string} after
 * @param {object} [opts]
 * @param {string} [opts.path]
 * @param {string} [opts.fromLabel]
 * @param {string} [opts.toLabel]
 * @param {number} [opts.context]
 * @returns {string}
 */
export function unifiedDiff(before, after, opts = {}) {
  const context = opts.context ?? 3;
  const path = opts.path ?? "file";
  const fromLabel = opts.fromLabel ?? "before";
  const toLabel = opts.toLabel ?? "after";

  const beforeBuf = Buffer.isBuffer(before) ? before : Buffer.from(before, "utf8");
  const afterBuf = Buffer.isBuffer(after) ? after : Buffer.from(after, "utf8");

  if (isBinary(beforeBuf) || isBinary(afterBuf)) {
    return `--- ${path} (${fromLabel})\n+++ ${path} (${toLabel})\nBinary files differ\n`;
  }

  const aLines = toLines(beforeBuf.toString("utf8"));
  const bLines = toLines(afterBuf.toString("utf8"));
  const { ops, tooLarge, prefix, suffix } = diffLines(aLines, bLines);

  const header = `--- ${path} (${fromLabel})\n+++ ${path} (${toLabel})\n`;

  if (aLines.length === bLines.length && ops.length > 0 && prefix === aLines.length) {
    return `${header}(no textual difference)\n`;
  }
  if (tooLarge) {
    // Say what is true and stop. A fabricated summary would be worse than none.
    return (
      `${header}@@ too large to diff @@\n` +
      `  ${aLines.length} lines → ${bLines.length} lines` +
      `${prefix > 0 ? `, ${prefix} identical at the start` : ""}` +
      `${suffix > 0 ? `, ${suffix} identical at the end` : ""}\n`
    );
  }
  if (ops.length === 0) return `${header}(no textual difference)\n`;

  const before_ = lineNumbers(ops);
  const grouped = hunks(ops, context);
  let out = header;
  for (const hunk of grouped) {
    let oldCount = 0;
    let newCount = 0;
    for (let i = hunk.start; i <= hunk.end; i += 1) {
      const op = ops[i];
      if (op === undefined) continue;
      if (op.type !== "ins") oldCount += 1;
      if (op.type !== "del") newCount += 1;
    }
    const start = /** @type {{ o: number, n: number }} */ (before_[hunk.start]);
    // The convention every diff tool uses: a hunk with nothing on one side
    // points at the line *before* the insertion point, which is why a pure
    // addition to an empty file reads `-0,0` rather than `-1,0`.
    const oldStart = oldCount === 0 ? start.o - 1 : start.o;
    const newStart = newCount === 0 ? start.n - 1 : start.n;
    out += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
    for (let i = hunk.start; i <= hunk.end; i += 1) {
      const op = ops[i];
      if (op === undefined) continue;
      const prefixChar = op.type === "eq" ? " " : op.type === "del" ? "-" : "+";
      out += `${prefixChar}${op.text}\n`;
    }
  }
  return out;
}
