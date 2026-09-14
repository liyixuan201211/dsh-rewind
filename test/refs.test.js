import assert from "node:assert/strict";
import test from "node:test";

import { parseTimeRef, RefError, resolveRef } from "../src/refs.js";

/**
 * Build a snapshot at *local* midnight on day `n` of January 2026.
 *
 * Local, not UTC, on purpose: `parseTimeRef` reads a bare date as local time
 * because that is what a person means by "the 3rd". Deriving the fixture from
 * the same clock makes these assertions independent of the machine's timezone —
 * an earlier version of this test passed in UTC and failed in UTC+8.
 *
 * @param {number} n
 * @param {Partial<import("../src/types.js").Snapshot>} [over]
 * @returns {import("../src/types.js").Snapshot}
 */
function record(n, over = {}) {
  const counts = { files: n, dirs: 0, links: 0, skipped: 0, bytes: 0, reused: 0, excluded: 0 };
  return {
    v: 1,
    id: `2026010${n}T000000Z-000${n}`,
    seq: n,
    time: new Date(2026, 0, n, 0, 0, 0).toISOString(),
    kind: "snap",
    label: `snapshot ${n}`,
    manifest: String(n).repeat(64).slice(0, 64),
    parent: n > 1 ? `2026010${n - 1}T000000Z-000${n - 1}` : null,
    parentManifest: null,
    counts,
    unchanged: false,
    ...over,
  };
}

const three = [record(1), record(2), record(3)];

test("last and HEAD mean the newest snapshot", () => {
  assert.equal(resolveRef(three, undefined).seq, 3);
  assert.equal(resolveRef(three, "").seq, 3);
  assert.equal(resolveRef(three, "last").seq, 3);
  assert.equal(resolveRef(three, "HEAD").seq, 3);
});

test("@n counts back from the newest", () => {
  assert.equal(resolveRef(three, "@1").seq, 3);
  assert.equal(resolveRef(three, "@2").seq, 2);
  assert.equal(resolveRef(three, "@3").seq, 1);
  assert.throws(() => resolveRef(three, "@4"), RefError);
  assert.throws(() => resolveRef(three, "@0"), RefError);
});

test("an id or a unique prefix resolves", () => {
  assert.equal(resolveRef(three, "20260102T000000Z-0002").seq, 2);
  assert.equal(resolveRef(three, "20260102T00").seq, 2);
});

test("an ambiguous prefix is refused with the candidates listed", () => {
  const same = [record(1), record(1, { id: "20260101T000000Z-ffff", seq: 2 })];
  assert.throws(
    () => resolveRef(same, "20260101"),
    (err) => {
      assert.ok(err instanceof RefError);
      assert.match(err.message, /matches 2 snapshots/);
      return true;
    },
  );
});

test("a time resolves to the newest snapshot at or before it", () => {
  assert.equal(resolveRef(three, "2026-01-02T13:00:00").seq, 2);
  assert.equal(resolveRef(three, "2026-01-03").seq, 3, "a bare date is that day's local midnight");
  assert.equal(resolveRef(three, "2026-01-01 00:00").seq, 1);
  assert.throws(() => resolveRef(three, "2025-01-01"), RefError);
});

test("parseTimeRef accepts exactly the documented shapes", () => {
  assert.ok(parseTimeRef("14:32") instanceof Date);
  assert.ok(parseTimeRef("14:32:07") instanceof Date);
  assert.ok(parseTimeRef("2026-09-14") instanceof Date);
  assert.ok(parseTimeRef("2026-09-14 14:32") instanceof Date);
  assert.ok(parseTimeRef("2026-09-14T14:32:00") instanceof Date);
  assert.equal(parseTimeRef("not a time"), null);
  assert.equal(parseTimeRef("2026-09-14T14:32:00Z"), null, "an explicit zone is not one of the shapes");
  assert.equal(parseTimeRef("@2"), null);
});

test("HH:MM means today, in local time", () => {
  const parsed = parseTimeRef("09:15");
  const now = new Date();
  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getFullYear(), now.getFullYear());
  assert.equal(parsed.getMonth(), now.getMonth());
  assert.equal(parsed.getDate(), now.getDate());
  assert.equal(parsed.getHours(), 9);
  assert.equal(parsed.getMinutes(), 15);
});

test("an empty log is an error that says what to do", () => {
  assert.throws(() => resolveRef([], "last"), /no snapshots yet/);
});

test("an unknown reference suggests the log", () => {
  assert.throws(() => resolveRef(three, "nope"), /rewind log/);
});
