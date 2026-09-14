#!/usr/bin/env node
/**
 * rewind — undo what happened to this directory.
 *
 * Exit codes are the interface:
 *
 *   0  ok
 *   1  error while applying; some paths may not have been restored
 *   2  usage
 *   3  status: the tree differs from the last snapshot
 *   4  undo: the plan is ready but --yes was not given; nothing changed
 *   5  refused: unsafe path, or content that was never captured; nothing changed
 *   6  nothing to do: the tree is already at that state
 *
 * Codes 4, 5 and 6 all mean the same thing at the filesystem level — *nothing
 * happened* — and they exist as separate numbers so that "I chose not to act"
 * can never be mistaken for "I acted and it failed". A tool that has to be
 * trusted in a panic has to be legible when it declines.
 */
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.js";
import { countDiff, unifiedDiff } from "./diff.js";
import { doctorStore } from "./doctor.js";
import { rewindExec } from "./exec.js";
import { compareEntries } from "./plan.js";
import { pruneStore } from "./prune.js";
import { resolveRef, RefError } from "./refs.js";
import {
  describeEntry,
  makeStyle,
  renderApplyResult,
  renderLog,
  renderPlan,
  renderStatus,
} from "./report.js";
import { scanTree } from "./scan.js";
import { takeSnapshot } from "./snapshot.js";
import { Store } from "./store.js";
import { readAt, rewindTo } from "./undo.js";
import { formatBytes, parseDuration, plural } from "./util.js";
import { watchDirectory } from "./watch.js";

export const VERSION = "1.0.0";

export const EXIT = /** @type {const} */ ({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  DRIFT: 3,
  NEEDS_YES: 4,
  REFUSED: 5,
  NOOP: 6,
});

class UsageError extends Error {}

const HELP = `rewind — undo what happened to this directory.

A snapshot store for any folder, git or not, aimed at the thing coding agents do
at speed: change many files at once, and occasionally change them wrong.

Usage:
  rewind snap [--label <text>] [--note <text>]        take a snapshot now
  rewind log [--limit <n>]                            list snapshots
  rewind status                                       what differs from the last snapshot
  rewind diff [<ref>] [--stat] [-- <path>...]         what changed since <ref>
  rewind undo [<ref>] [--dry-run] [--yes] [--force]   put the tree back
  rewind show <ref>:<path>                            print a file as it was
  rewind exec [--label <text>] -- <command>...        snapshot, run, snapshot
  rewind watch [--debounce <ms>] [--once]             snapshot on every change
  rewind prune [--keep <n>] [--older-than <dur>]      forget old snapshots, reclaim space
  rewind doctor [--verify]                            can this store still restore?
  rewind init                                         create the store

Refs: last (the default), @2 (two snapshots ago), an id prefix, 14:32, 2026-09-14

Options:
  --root <dir>             the directory to protect (default: cwd)
  --store <dir>            where the store lives (default: <root>/.rewind)
  --exclude <name|path>    leave more out (repeatable; default excludes .git,
                           node_modules, dist, build, target)
  --max-file-size <bytes>  capture files up to this size (default: 8388608)
  --rehash                 ignore the size+mtime shortcut and re-read everything
  -q, --quiet              only what matters
  --json                   machine-readable output
  -h, --help               this text
  --version                version

Exit codes:
  0  ok
  1  error while applying; some paths may not have been restored
  2  usage
  3  status: the tree differs from the last snapshot
  4  undo: the plan is ready but --yes was not given; nothing changed
  5  refused: unsafe path, or content that was never captured; nothing changed
  6  nothing to do: the tree is already at that state

The store holds plaintext copies of every file it captured, so .rewind/ is
ignored in .gitignore and must never be committed. \`undo\` prints its plan
before it touches anything, every time, with or without --yes.
`;

/** @type {import("node:util").ParseArgsOptionsConfig} */
const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  root: { type: "string" },
  store: { type: "string" },
  label: { type: "string" },
  note: { type: "string" },
  limit: { type: "string" },
  stat: { type: "boolean" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  force: { type: "boolean" },
  rehash: { type: "boolean" },
  debounce: { type: "string" },
  once: { type: "boolean" },
  keep: { type: "string" },
  "older-than": { type: "string" },
  "max-file-size": { type: "string" },
  exclude: { type: "string", multiple: true },
  "ignore-file": { type: "string" },
  context: { type: "string" },
  verify: { type: "boolean" },
};

/**
 * @typedef {object} Ctx
 * @property {import("./config.js").Config} cfg
 * @property {Store} store
 * @property {Record<string, any>} values
 * @property {string[]} positionals
 * @property {string[]} rest        arguments after `--`
 * @property {import("./report.js").Style} style
 * @property {boolean} json
 * @property {boolean} quiet
 */

/**
 * Everything after `--` is passed through untouched — to a shell command for
 * `exec`, or as path filters for `diff`. Node's own parser would otherwise try
 * to interpret `-rf` or `--amend` as its flags.
 *
 * @param {string[]} argv
 * @returns {{ main: string[], rest: string[] }}
 */
function splitDoubleDash(argv) {
  const at = argv.indexOf("--");
  if (at === -1) return { main: argv, rest: [] };
  return { main: argv.slice(0, at), rest: argv.slice(at + 1) };
}

/**
 * @param {any} values
 * @returns {Promise<import("./config.js").Config>}
 */
async function buildConfig(values) {
  /** @type {Record<string, unknown>} */
  const opts = {};
  if (values.root !== undefined) opts.root = values.root;
  if (values.store !== undefined) opts.store = values.store;
  if (values["ignore-file"] !== undefined) opts.ignoreFile = values["ignore-file"];
  if (values.exclude !== undefined) opts.exclude = values.exclude;
  if (values["max-file-size"] !== undefined) {
    const size = Number(values["max-file-size"]);
    if (!Number.isFinite(size)) throw new UsageError("--max-file-size must be a number of bytes");
    opts.maxFileSize = size;
  }
  return loadConfig(opts);
}

/**
 * Commands that only read must not create a store: `rewind log` in a directory
 * that has never been snapshotted should say so, not quietly leave a `.rewind/`
 * behind.
 *
 * @param {import("./config.js").Config} cfg
 * @returns {Store | null}
 */
function openExistingStore(cfg) {
  if (!existsSync(cfg.storeDir)) return null;
  return new Store(cfg.storeDir);
}

/* ------------------------------------------------------------------ commands */

/**
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function cmdInit(ctx) {
  await Store.open(ctx.cfg.storeDir, ctx.cfg.root, ctx.cfg.policy);
  if (ctx.json) {
    emit({ root: ctx.cfg.root, store: ctx.cfg.storeDir });
    return EXIT.OK;
  }
  process.stdout.write(`store ready at ${ctx.cfg.storeDir}\n`);
  process.stdout.write(`  protecting ${ctx.cfg.root}\n`);
  return EXIT.OK;
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function cmdSnap(ctx) {
  const result = await takeSnapshot(ctx.cfg, ctx.store, {
    kind: "snap",
    label: ctx.values.label ?? "",
    ...(ctx.values.note === undefined ? {} : { note: ctx.values.note }),
    rehash: ctx.values.rehash === true,
  });
  const stats = await ctx.store.stat();

  if (ctx.json) {
    emit({
      id: result.record.id,
      unchanged: result.unchanged,
      manifest: result.record.manifest,
      counts: result.record.counts,
      skipped: result.skipped,
      store: { snapshots: stats.snapshots, objects: stats.objects, bytes: stats.bytes },
    });
    return EXIT.OK;
  }
  if (ctx.quiet) return EXIT.OK;

  const style = ctx.style;
  const c = result.record.counts;
  const head = result.unchanged
    ? `${style.dim("unchanged")} ${style.bold(result.record.id)}`
    : `${style.green("snapped")} ${style.bold(result.record.id)}`;
  process.stdout.write(`${head}  ${style.dim(ctx.cfg.root)}\n`);
  process.stdout.write(
    `  ${plural(c.files, "file")}, ${plural(c.dirs, "directory", "directories")}, ` +
      `${formatBytes(c.bytes)}${c.reused > 0 ? `, ${c.reused} reused` : ""}\n`,
  );
  if (result.skipped.length > 0) {
    process.stdout.write(
      `  ${style.yellow("not captured")} ${plural(result.skipped.length, "path")}:\n`,
    );
    for (const s of result.skipped.slice(0, 5)) {
      process.stdout.write(`    ${s.path} — ${s.why}${s.size === undefined ? "" : ` (${formatBytes(s.size)})`}\n`);
    }
    if (result.skipped.length > 5) {
      process.stdout.write(`    … and ${result.skipped.length - 5} more\n`);
    }
  }
  process.stdout.write(`  ${style.dim(`rewind undo ${result.record.id}`)} puts it back\n`);
  return EXIT.OK;
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function cmdLog(ctx) {
  const store = ctx.store;
  const records = await store.readLog();
  const limit = ctx.values.limit === undefined ? 20 : Number(ctx.values.limit);
  if (!Number.isFinite(limit) || limit < 1) throw new UsageError("--limit must be a positive number");

  if (ctx.json) {
    emit(records.slice(-limit));
    return EXIT.OK;
  }
  process.stdout.write(renderLog(records, { limit, style: ctx.style }));
  return EXIT.OK;
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function cmdStatus(ctx) {
  const records = await ctx.store.readLog();
  const latest = records.length > 0 ? (records[records.length - 1] ?? null) : null;
  if (latest === null) {
    if (ctx.json) emit({ snapshots: 0, changes: [] });
    else process.stdout.write(renderStatus({ record: null, changes: [], ref: "" }));
    return EXIT.OK;
  }
  const base = await ctx.store.readManifest(latest.manifest);
  const live = await scanTree(ctx.cfg, {
    store: ctx.store,
    cache: await ctx.store.loadStatCache(),
    writeObjects: false,
  });
  const changes = compareEntries(base, live.entries);

  if (ctx.json) {
    emit({
      ref: latest.id,
      time: latest.time,
      changes: changes.map((c) => ({ path: c.path, change: c.change, from: c.from, to: c.to })),
    });
    return changes.length > 0 ? EXIT.DRIFT : EXIT.OK;
  }
  process.stdout.write(renderStatus({ record: latest, changes, ref: latest.id, style: ctx.style }));
  return changes.length > 0 ? EXIT.DRIFT : EXIT.OK;
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function cmdDiff(ctx) {
  const records = await ctx.store.readLog();
  if (records.length === 0) {
    process.stdout.write("no snapshots yet — `rewind snap` takes one\n");
    return EXIT.OK;
  }
  const base = resolveRef(records, ctx.positionals[1]);
  const baseManifest = await ctx.store.readManifest(base.manifest);
  const live = await scanTree(ctx.cfg, {
    store: ctx.store,
    cache: await ctx.store.loadStatCache(),
    writeObjects: false,
  });

  const filters = ctx.rest.map((p) => p.replace(/\/+$/, ""));
  const changes = compareEntries(baseManifest, live.entries).filter((change) => {
    if (filters.length === 0) return true;
    return filters.some((f) => change.path === f || change.path.startsWith(`${f}/`));
  });

  if (changes.length === 0) {
    if (ctx.json) emit({ ref: base.id, changes: [] });
    else process.stdout.write(`${ctx.style.green("no changes")} since ${base.id}\n`);
    return EXIT.OK;
  }

  const context = ctx.values.context === undefined ? 3 : Number(ctx.values.context);
  if (!Number.isFinite(context) || context < 0) throw new UsageError("--context must be >= 0");

  /** @type {{ path: string, change: string, added?: number, removed?: number, detail?: string }[]} */
  const stat = [];
  let text = "";

  for (const change of changes) {
    const before = await contentAt(ctx.store, change.from);
    const after = await contentNow(ctx.cfg.root, change.path, change.to);

    // An addition or a deletion still gets a real diff: absent is treated as an
    // empty file, so a new file shows up as `+` lines instead of as a note. Only
    // a side that genuinely is not a file (a directory, a symlink, something too
    // large to have been captured) falls back to a one-line description.
    if (before.kind !== "other" && after.kind !== "other" && (before.kind === "file" || after.kind === "file")) {
      const beforeBuf = before.kind === "file" ? before.buf : Buffer.alloc(0);
      const afterBuf = after.kind === "file" ? after.buf : Buffer.alloc(0);
      const counts = countDiff(beforeBuf, afterBuf);
      stat.push({
        path: change.path,
        change: change.change,
        added: counts.added,
        removed: counts.removed,
        ...(counts.binary ? { detail: "binary" } : {}),
        ...(counts.tooLarge ? { detail: "too large to diff" } : {}),
      });
      if (ctx.values.stat !== true) {
        text += `\n${change.path}  ${change.change}\n`;
        text += unifiedDiff(beforeBuf, afterBuf, {
          path: change.path,
          fromLabel: before.kind === "file" ? base.id : "absent",
          toLabel: after.kind === "file" ? "now" : "absent",
          context,
        });
      }
      continue;
    }

    const detail =
      `${describeEntry(change.from)} → ${describeEntry(change.to)}` +
      (before.kind === "other" ? ` (${before.why})` : "");
    stat.push({ path: change.path, change: change.change, detail });
    if (ctx.values.stat !== true) text += `\n${change.path}  ${change.change}  ${detail}\n`;
  }

  if (ctx.json) {
    emit({ ref: base.id, changes: stat });
    return EXIT.OK;
  }
  if (ctx.values.stat === true) {
    const width = Math.max(...stat.map((s) => s.path.length));
    for (const s of stat) {
      const pad = " ".repeat(width - s.path.length);
      const counts =
        s.added === undefined ? (s.detail ?? "") : `+${s.added} -${s.removed}${s.detail ? ` (${s.detail})` : ""}`;
      process.stdout.write(`  ${s.path}${pad}  ${counts}\n`);
    }
    process.stdout.write(
      `\n${plural(changes.length, "path")} changed since ${base.id}\n`,
    );
    return EXIT.OK;
  }
  process.stdout.write(`${text}\n${plural(changes.length, "path")} changed since ${base.id}\n`);
  return EXIT.OK;
}

/**
 * @param {Store} store
 * @param {import("./types.js").Entry | undefined} entry
 * @returns {Promise<{ kind: "file" | "other" | "absent", buf: Buffer, why: string }>}
 */
async function contentAt(store, entry) {
  if (entry === undefined) return { kind: "absent", buf: Buffer.alloc(0), why: "absent" };
  if (entry.t === "f") {
    try {
      return { kind: "file", buf: await store.readObject(entry.h), why: "" };
    } catch (err) {
      return { kind: "other", buf: Buffer.alloc(0), why: /** @type {Error} */ (err).message };
    }
  }
  return { kind: "other", buf: Buffer.alloc(0), why: `not a file (${entry.t})` };
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {import("./types.js").Entry | undefined} entry
 * @returns {Promise<{ kind: "file" | "other" | "absent", buf: Buffer, why: string }>}
 */
async function contentNow(root, rel, entry) {
  if (entry === undefined) return { kind: "absent", buf: Buffer.alloc(0), why: "absent" };
  if (entry.t !== "f") return { kind: "other", buf: Buffer.alloc(0), why: `not a file (${entry.t})` };
  try {
    return { kind: "file", buf: await readFile(path.join(root, rel)), why: "" };
  } catch (err) {
    return { kind: "other", buf: Buffer.alloc(0), why: /** @type {Error} */ (err).message };
  }
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function cmdShow(ctx) {
  const spec = ctx.positionals[1];
  if (spec === undefined) throw new UsageError("show needs <ref>:<path>, e.g. rewind show @2:src/app.js");
  const at = spec.indexOf(":");
  if (at <= 0) throw new UsageError("show needs <ref>:<path>, e.g. rewind show last:src/app.js");
  const ref = spec.slice(0, at);
  const rel = spec.slice(at + 1);
  const records = await ctx.store.readLog();
  const snapshot = resolveRef(records, ref);
  const buf = await readAt(ctx.store, snapshot, rel);
  process.stdout.write(buf);
  return EXIT.OK;
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function cmdUndo(ctx) {
  const records = await ctx.store.readLog();
  const target = resolveRef(records, ctx.positionals[1]);
  const result = await rewindTo(ctx.cfg, ctx.store, target, {
    dryRun: ctx.values["dry-run"] === true,
    yes: ctx.values.yes === true,
    force: ctx.values.force === true,
  });

  if (ctx.json) {
    const failures = result.applied === null ? 0 : result.applied.failures.length;
    emit({
      outcome: result.outcome,
      target: target.id,
      summary: result.plan.summary,
      steps: result.plan.steps.map((s) => ({ path: s.path, action: s.action })),
      unrestorable: result.plan.unrestorable,
      refusals: result.plan.refusals,
      applied: result.applied,
      safety: result.safety === null ? null : result.safety.id,
    });
    return failures > 0 ? EXIT.ERROR : outcomeToExit(result.outcome, ctx);
  }

  if (result.outcome === "noop") {
    process.stdout.write(
      `${ctx.style.green("nothing to do")} — the tree already matches ${target.id}\n`,
    );
    return EXIT.NOOP;
  }

  process.stdout.write(renderPlan(result.plan, target.id, ctx.style));

  if (result.outcome === "refused") {
    process.stdout.write(
      `\n${ctx.style.red("refused")} — nothing was changed.\n` +
        `  ${ctx.style.dim("a path that was never captured cannot be put back, and one that was never")}\n` +
        `  ${ctx.style.dim("captured cannot be removed safely; see the reasons above")}\n`,
    );
    return EXIT.REFUSED;
  }

  if (result.plan.unrestorable.length > 0) {
    process.stdout.write(
      `\n${ctx.style.yellow("note")} — ${plural(result.plan.unrestorable.length, "path")} in that snapshot ` +
        `cannot be restored; everything else will be.\n`,
    );
  }

  if (ctx.values["dry-run"] === true) {
    process.stdout.write(`\n${ctx.style.dim("dry run — nothing was changed")}\n`);
    return EXIT.OK;
  }
  if (ctx.values.yes !== true) {
    process.stdout.write(
      `\n${ctx.style.yellow("nothing changed")} — nothing is applied without an explicit --yes.\n` +
        `  ${ctx.style.dim(`rewind undo ${target.id} --yes`)}\n`,
    );
    return EXIT.NEEDS_YES;
  }

  process.stdout.write(`\n${renderApplyResult(result, ctx.style)}`);
  return result.applied !== null && result.applied.failures.length > 0 ? EXIT.ERROR : EXIT.OK;
}

/**
 * @param {"planned" | "refused" | "noop" | "applied"} outcome
 * @param {Ctx} ctx
 * @returns {number}
 */
function outcomeToExit(outcome, ctx) {
  switch (outcome) {
    case "refused":
      return EXIT.REFUSED;
    case "noop":
      return EXIT.NOOP;
    case "planned":
      return ctx.values["dry-run"] === true ? EXIT.OK : EXIT.NEEDS_YES;
    default:
      return EXIT.OK;
  }
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function cmdExec(ctx) {
  const argv = ctx.rest.length > 0 ? ctx.rest : ctx.positionals.slice(1);
  if (argv.length === 0) throw new UsageError("exec needs a command: rewind exec -- <command>");
  const result = await rewindExec(ctx.cfg, ctx.store, {
    argv,
    ...(ctx.values.label === undefined ? {} : { label: ctx.values.label }),
  });

  if (ctx.json) {
    process.stderr.write(
      `${JSON.stringify({ before: result.before?.id, after: result.after?.id, code: result.code, ms: result.ms })}\n`,
    );
  } else if (!ctx.quiet) {
    const style = ctx.style;
    const changed = result.unchanged
      ? style.dim("no files changed")
      : `${plural(result.after?.counts.files ?? 0, "file")} captured`;
    process.stderr.write(
      `\n${style.dim("rewind")} ${result.before?.id} → ${result.after?.id}  ` +
        `${style.dim(`exit ${result.code}, ${result.ms}ms, ${changed}`)}\n` +
        `  ${style.dim(`rewind undo ${result.before?.id} --yes`)} undoes this command\n`,
    );
  }
  return result.code;
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function cmdWatch(ctx) {
  const debounceMs = ctx.values.debounce === undefined ? 1200 : Number(ctx.values.debounce);
  if (!Number.isFinite(debounceMs) || debounceMs < 0) throw new UsageError("--debounce must be >= 0");

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  const started = Date.now();
  try {
    const result = await watchDirectory(ctx.cfg, ctx.store, {
      debounceMs,
      once: ctx.values.once === true,
      signal: controller.signal,
      onSnapshot: (record, why) => {
        if (ctx.quiet || ctx.json) return;
        if (record === null) {
          if (why !== "unchanged") process.stderr.write(`${ctx.style.dim(`  ${why}`)}\n`);
          return;
        }
        const stamp = new Date().toISOString().slice(11, 19);
        process.stderr.write(
          `${ctx.style.dim(stamp)}  ${ctx.style.green("saved")} ${record.id}  ` +
            `${plural(record.counts.files, "file")}\n`,
        );
      },
    });
    if (ctx.json) {
      emit({ ...result, ms: Date.now() - started });
    } else if (!ctx.quiet) {
      process.stderr.write(
        `\n${plural(result.snapshots, "snapshot")} in ${Math.round((Date.now() - started) / 1000)}s — ` +
          `\`rewind log\` lists them\n`,
      );
    }
    return EXIT.OK;
  } catch (err) {
    if (ctx.values.once === true) throw err;
    process.stderr.write(
      `rewind: could not watch ${ctx.cfg.root}: ${/** @type {Error} */ (err).message}\n` +
        `  recursive watching needs Node 20+ on macOS, Windows or Linux\n`,
    );
    return EXIT.ERROR;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function cmdPrune(ctx) {
  const keep = ctx.values.keep === undefined ? 20 : Number(ctx.values.keep);
  if (!Number.isFinite(keep) || keep < 1) throw new UsageError("--keep must be at least 1");
  if (ctx.values["older-than"] !== undefined) {
    // parseDuration speaks in durations, not in exit codes; a bad value is a
    // usage error and must not be reported as a runtime failure.
    try {
      parseDuration(String(ctx.values["older-than"]));
    } catch (err) {
      throw new UsageError(/** @type {Error} */ (err).message);
    }
  }

  const result = await pruneStore(ctx.cfg, ctx.store, {
    keep,
    ...(ctx.values["older-than"] === undefined ? {} : { olderThan: String(ctx.values["older-than"]) }),
    dryRun: ctx.values["dry-run"] === true,
  });

  if (ctx.json) {
    emit({
      dropped: result.dropped.map((r) => r.id),
      kept: result.kept,
      manifestsRemoved: result.manifestsRemoved,
      objectsRemoved: result.objectsRemoved,
      bytesReclaimed: result.bytesReclaimed,
      applied: result.applied,
    });
    return EXIT.OK;
  }
  if (result.dropped.length === 0) {
    process.stdout.write(`${ctx.style.dim("nothing to prune")} — ${plural(result.kept, "snapshot")} kept\n`);
    return EXIT.OK;
  }
  const verb = result.applied ? "dropped" : "would drop";
  process.stdout.write(
    `${verb} ${plural(result.dropped.length, "snapshot")}, keeping ${result.kept}\n`,
  );
  if (result.applied) {
    process.stdout.write(
      `  ${plural(result.objectsRemoved, "object")}, ${plural(result.manifestsRemoved, "manifest")} ` +
        `removed — ${formatBytes(result.bytesReclaimed)} reclaimed\n`,
    );
  } else {
    process.stdout.write(`  ${ctx.style.dim("dry run — nothing was removed")}\n`);
  }
  return EXIT.OK;
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<number>}
 */
async function cmdDoctor(ctx) {
  const result = await doctorStore(ctx.cfg, ctx.store, { verify: ctx.values.verify === true });
  if (ctx.json) {
    emit(result);
    return result.problems.length > 0 ? EXIT.ERROR : EXIT.OK;
  }
  const style = ctx.style;
  process.stdout.write(
    `${plural(result.snapshots, "snapshot")}, ${plural(result.manifests, "manifest")}, ` +
      `${plural(result.objects, "object")}` +
      `${result.verified > 0 ? `, ${result.verified} verified` : ""}\n`,
  );
  if (result.unreferencedObjects > 0) {
    process.stdout.write(
      `  ${style.dim(`${result.unreferencedObjects} unreferenced objects — \`rewind prune\` reclaims them`)}\n`,
    );
  }
  if (result.problems.length === 0) {
    process.stdout.write(`${style.green("ok")} — every snapshot in the log can be restored\n`);
    return EXIT.OK;
  }
  process.stdout.write(`\n${style.red(`${plural(result.problems.length, "problem")}`)}:\n`);
  for (const problem of result.problems.slice(0, 20)) {
    process.stdout.write(`  ${problem.what}: ${problem.why}\n`);
  }
  if (result.problems.length > 20) {
    process.stdout.write(`  … and ${result.problems.length - 20} more\n`);
  }
  return EXIT.ERROR;
}

/* --------------------------------------------------------------------- entry */

/**
 * @param {unknown} value
 * @returns {void}
 */
function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const { main: mainArgs, rest } = splitDoubleDash(argv);

  /** @type {{ values: Record<string, any>, positionals: string[] }} */
  let parsed;
  try {
    parsed = parseArgs({ args: mainArgs, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`rewind: ${/** @type {Error} */ (err).message}\n`);
    process.stderr.write(`try \`rewind --help\`\n`);
    return EXIT.USAGE;
  }
  const values = parsed.values;
  const positionals = parsed.positionals;

  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (values.help === true || positionals.length === 0) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  const command = positionals[0];
  const style = makeStyle(process.stdout);
  const json = values.json === true;
  const quiet = values.quiet === true || json;

  const known = new Set([
    "init",
    "snap",
    "log",
    "status",
    "diff",
    "undo",
    "show",
    "exec",
    "watch",
    "prune",
    "doctor",
  ]);
  if (command === undefined || !known.has(command)) {
    process.stderr.write(`rewind: unknown command ${JSON.stringify(command)}\n`);
    process.stderr.write(`try \`rewind --help\`\n`);
    return EXIT.USAGE;
  }

  const cfg = await buildConfig(values);
  const readOnly = command === "log" || command === "status" || command === "diff" || command === "show";
  const existing = readOnly ? openExistingStore(cfg) : null;
  if (readOnly && existing === null) {
    if (json) emit({ snapshots: 0, changes: [], note: "no store in this directory" });
    else {
      process.stdout.write(
        `no store in ${cfg.root} — \`rewind snap\` creates one\n`,
      );
    }
    return EXIT.OK;
  }
  const store = existing ?? (await Store.open(cfg.storeDir, cfg.root, cfg.policy));

  /** @type {Ctx} */
  const ctx = { cfg, store, values, positionals, rest, style, json, quiet };

  switch (command) {
    case "init":
      return cmdInit(ctx);
    case "snap":
      return cmdSnap(ctx);
    case "log":
      return cmdLog(ctx);
    case "status":
      return cmdStatus(ctx);
    case "diff":
      return cmdDiff(ctx);
    case "undo":
      return cmdUndo(ctx);
    case "show":
      return cmdShow(ctx);
    case "exec":
      return cmdExec(ctx);
    case "watch":
      return cmdWatch(ctx);
    case "prune":
      return cmdPrune(ctx);
    case "doctor":
      return cmdDoctor(ctx);
    default:
      return EXIT.USAGE;
  }
}

/* ----------------------------------------------------------------- execution */

/**
 * Is this module the program, or a library imported by one? Comparing resolved
 * real paths is the only check that survives being run through `npx`, a symlink
 * in `node_modules/.bin`, or a Windows path.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.stdout.on("error", (err) => {
    // `rewind log | head` closes the pipe early; that is not an error worth a
    // stack trace.
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "EPIPE") process.exit(EXIT.OK);
    throw err;
  });
  try {
    const code = await main(process.argv.slice(2));
    process.exitCode = code;
  } catch (err) {
    if (err instanceof RefError || err instanceof UsageError) {
      process.stderr.write(`rewind: ${err.message}\n`);
      process.exitCode = err instanceof UsageError ? EXIT.USAGE : EXIT.ERROR;
    } else {
      process.stderr.write(`rewind: ${/** @type {Error} */ (err).stack ?? String(err)}\n`);
      process.exitCode = EXIT.ERROR;
    }
  }
}
