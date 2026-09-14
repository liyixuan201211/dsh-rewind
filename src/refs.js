/**
 * Naming a snapshot.
 *
 * The point of a rewind tool is that you reach for it while something is going
 * wrong, so the names have to be the ones already in your head: "the last one",
 * "the one three ago", "the one from 14:32". Ids exist for scripts, and a unique
 * prefix is enough — nobody should have to retype `20260914T101530Z-1a2b`.
 */
import { shortHash } from "./util.js";

/** @typedef {import("./types.js").Snapshot} Snapshot */

export class RefError extends Error {}

/**
 * `HH:MM` (today), `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM[:SS]` — read as local time,
 * because that is what a person means by "14:32". Snapshot ids embed a UTC stamp,
 * which is why an id is matched before any of these.
 *
 * @param {string} text
 * @returns {Date | null}
 */
export function parseTimeRef(text) {
  let m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (m !== null) {
    const now = new Date();
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(m[1]),
      Number(m[2]),
      Number(m[3] ?? 0),
    );
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m !== null) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    );
  }
  return null;
}

/**
 * @param {Snapshot[]} records oldest first
 * @param {string | undefined} ref
 * @returns {Snapshot}
 */
export function resolveRef(records, ref) {
  if (records.length === 0) {
    throw new RefError("this directory has no snapshots yet — run `rewind snap` first");
  }
  const newest = /** @type {Snapshot} */ (records[records.length - 1]);

  if (ref === undefined || ref === "" || ref === "last" || ref === "HEAD") return newest;

  const nth = /^@(\d+)$/.exec(ref);
  if (nth !== null) {
    const n = Number(nth[1]);
    if (n < 1 || n > records.length) {
      throw new RefError(`@${n} is out of range: there ${records.length === 1 ? "is 1 snapshot" : `are ${records.length} snapshots`}`);
    }
    return /** @type {Snapshot} */ (records[records.length - n]);
  }

  const exact = records.find((r) => r.id === ref);
  if (exact !== undefined) return exact;

  const prefixed = records.filter((r) => r.id.startsWith(ref));
  if (prefixed.length === 1) return /** @type {Snapshot} */ (prefixed[0]);
  if (prefixed.length > 1) {
    const ids = prefixed.map((r) => `  ${r.id}  ${describe(r)}`).join("\n");
    throw new RefError(`"${ref}" matches ${prefixed.length} snapshots:\n${ids}`);
  }

  const when = parseTimeRef(ref);
  if (when !== null && !Number.isNaN(when.getTime())) {
    const atOrBefore = records.filter((r) => new Date(r.time).getTime() <= when.getTime());
    if (atOrBefore.length === 0) {
      throw new RefError(`nothing had been snapshotted yet at ${ref}`);
    }
    return /** @type {Snapshot} */ (atOrBefore[atOrBefore.length - 1]);
  }

  throw new RefError(`no snapshot matches "${ref}" — try \`rewind log\` to see the ids`);
}

/**
 * @param {Snapshot} record
 * @returns {string}
 */
export function describe(record) {
  /** @type {string[]} */
  const bits = [record.kind];
  if (record.label) bits.push(record.label);
  if (record.command) bits.push(`exit ${record.command.code ?? "?"}`);
  return bits.join(" · ");
}

/**
 * Short form for a listing: `20260914T101530Z-1a2b  3m ago  snap  label`.
 *
 * @param {Snapshot} record
 * @param {Date} [now]
 * @returns {string}
 */
export function relativeTime(record, now = new Date()) {
  const ms = now.getTime() - new Date(record.time).getTime();
  if (ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * @param {Snapshot} record
 * @returns {string}
 */
export const shortId = (record) => record.id;

/**
 * The short hash of a snapshot's manifest, for display next to it.
 *
 * @param {Snapshot} record
 * @returns {string}
 */
export const manifestShort = (record) => shortHash(record.manifest);
