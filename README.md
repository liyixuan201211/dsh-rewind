# dsh-rewind

**Undo what an agent did to a directory.**

Content-addressed snapshots of any folder — git or not — with a one-command
rewind, and an undo that can itself be undone.

```bash
dsh plugin --profile web add github:liyixuan201211/dsh-rewind
```

No install needed to try it:

```bash
npx --yes github:liyixuan201211/dsh-rewind --help
```

中文：**把 agent 对目录做的改动撤回去。** 它不依赖 git——未提交的、从未被 git 跟踪的、
甚至这个目录根本不是仓库，都能还原。它和 `dsh-blastradius` 是一对：那个在动手前告诉你
"会毁掉什么、还能不能拿回来"，这个在毁掉之后把它拿回来。**它自己的撤销也能被撤销**：
`undo` 会先把当前状态存成快照再动手，并把那个 id 打给你。

---

## The gap this fills

`git checkout .` sounds like undo. It is not, for the case that actually happens:

| What the agent did | git has it? | `rewind undo` |
|---|---|---|
| Edited a tracked file, uncommitted | No — only the last commit | restores the edits |
| Deleted a file, never committed | No | restores the file |
| Deleted a file that was never tracked | No | restores the file |
| Created 40 files during a bad codemod | It never saw them | removes all 40 |
| `chmod -x` on your build script | No | restores the mode |
| Ran in a directory that is not a repo | — | works the same |
| Rewrote `.env` from a template | No | restores the contents |

git records commits. It does not record the state of your working tree an hour
ago, and it has never seen the files you have not added. That is exactly the
window an agent operates in.

## The one idea: the undo is undoable

Before `undo` touches anything, it snapshots the state it is about to replace —
and prints that id. So the thing you just reverted is not gone; rewinding to it
puts it back, exactly.

```
$ rewind undo --yes
undo complete — 3 restored, 1 removed

  the state you just replaced is 20260914T104302Z-9f31
  rewind undo 20260914T104302Z-9f31 puts it back
```

That is what makes it safe to reach for while something is going wrong. Two more
properties do the rest:

- **Nothing is removed recursively.** An undo removes exactly the files it
  captured, then asks to remove a directory *only if it is empty*. A
  `node_modules/` inside a directory it removes survives, and the output says so.
- **A path whose bytes were never captured is never deleted.** If a file was too
  large or unreadable when the snapshot was taken, removing it could not be
  undone — so the whole undo is refused rather than performed half-way.

## In use

```
$ rewind snap --label "before the refactor"
snapped 20260914T104255Z-44a0  /home/me/project
  3 files, 2 directories, 51 B
  rewind undo 20260914T104255Z-44a0 puts it back

... an agent rewrites the tree ...

$ rewind status
4 paths differ from 20260914T104255Z-44a0 (12s ago)

  build.sh       18 B (mode 755 → 644)
  docs/guide.md  removed  8 B
  src/app.js     25 B (content changed)
  src/helper.js  added    30 B

  rewind diff   see what changed
  rewind undo   go back to 20260914T104255Z-44a0
  rewind snap   accept the current state and move on

$ rewind undo
Restoring 20260914T104255Z-44a0: 3 restored, 1 removed

  remove   src/helper.js  30 B
  restore  build.sh       18 B
  restore  docs/guide.md  8 B
  restore  src/app.js     25 B

nothing changed — nothing is applied without an explicit --yes.
  rewind undo 20260914T104255Z-44a0 --yes
```

`undo` without `--yes` is not an error and not a no-op: it is the plan, printed,
with the exit code that says *nothing happened*.

## Wrapping a command instead of remembering

Discipline is the weak part of any snapshot tool, so the common case — one
command that rewrites many files — has a wrapper:

```bash
rewind exec -- npx jscodeshift -t transform.js src/
rewind exec -- rm -rf build/ dist/
```

It snapshots before, runs the command with your terminal, snapshots after, and
prints the id of the before-state. It exits with *the command's* exit code, so it
is safe inside a pipeline or a script. Undoing a wrapped command is one id, not a
timestamp you have to guess.

For a long session, leave protection running instead:

```bash
rewind watch --debounce 2000
```

Events are coalesced and a content-addressed manifest decides whether anything
really changed, so an idle tick costs one comparison and writes no log line.

## The store

Content-addressed, in `<root>/.rewind/`:

```
meta.json              which root this store belongs to, and its capture policy
log.jsonl              one line per snapshot, append-only
objects/<ab>/<sha256>  file contents, deduplicated across every snapshot
manifests/<sha256>     one canonical JSON tree per distinct tree state
stat.json              the size+mtime cache that makes rescanning cheap
```

Two properties fall out of addressing content by its hash:

- **Snapshots are cheap.** A file edited ten times is stored once; two snapshots
  of an unchanged tree share one manifest, so the cost is a single log line.
- **Restores are verifiable.** An object's name is the hash of its contents, so a
  restore re-hashes what it read and refuses to write mismatched bytes over a real
  file.

Nothing is ever overwritten in place: objects are written with `O_EXCL`, files are
restored through a temporary file and a rename, and the log is appended.

## What is captured, and what is not

Captured: every regular file up to 8 MiB, directories (including empty ones),
symlinks (recorded as links, never followed), and permission bits.

Left out: `.git`, `node_modules`, `.venv`, `__pycache__`, `dist`, `build`,
`target` and the rest of `DEFAULT_EXCLUDED_NAMES`, plus anything matched by a
`.rewindignore` in the root or by `--exclude`.

**A path that was not captured is a path the undo refuses to delete.** That is
the whole reason the list exists — exclusion is a safety boundary, not a speed
optimisation. The policy is written into `.rewind/meta.json` when the store is
created and read back by every later command, so a snapshot and a later undo
cannot disagree about what the tree contains; and the policy only ever grows more
protective, so deleting an exclusion rule can never turn into an undo that
removes files the store has no copy of.

## Safety properties, each with a test

| Property | Why it exists |
|---|---|
| a refusal changes nothing | a half-applied undo leaves two broken states to reason about |
| nothing is removed recursively | content the snapshot never captured must survive |
| uncaptured content is never deleted | it cannot be put back, so removing it is not undoable |
| the undo is undoable | the replaced state is snapshotted first, and its id printed |
| modified files are never deleted then recreated | a failed restore must not have already destroyed the file |
| content is verified before it is written | a corrupt object must not silently become your file |
| writes are atomic | an interrupted undo never leaves half a file |
| symlinks are recorded, never followed | a link cannot pull in, or write out to, anything outside the root |
| every removal precedes every write | a symlink is unlinked before anything is created beneath it |
| a manifest must be structurally consistent | a missing parent is refused, not created on the fly |
| no path outside the root is written | manifests are JSON; a hostile one is refused, not followed |
| the capture policy only grows | removing a rule cannot make an old path deletable |
| the store is created owner-only | it holds plaintext copies of file contents |

They are asserted in `test/safety.test.js` and `test/undo.test.js` — run them
alone with `node --test test/safety.test.js test/undo.test.js`. The reasoning
behind each is written out in
[`skills/rewind/reference/safety.md`](skills/rewind/reference/safety.md).

## Exit codes are the contract

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | an error while applying — some paths may not have been restored |
| `2` | usage error |
| `3` | `status`: the tree differs from the last snapshot |
| `4` | `undo`: the plan is ready, but `--yes` was not given — **nothing changed** |
| `5` | refused: an unsafe path, or content that was never captured — **nothing changed** |
| `6` | nothing to do: already at that state — **nothing changed** |

4, 5 and 6 all mean *nothing happened*, and they are separate numbers so that "I
chose not to act" is never mistaken for "I acted and it failed".

```bash
rewind status -q || echo "the tree has moved"
```

## Commands

```bash
rewind snap [--label "before X"]      # snapshot now
rewind log [--limit 100]              # what snapshots exist
rewind status                         # what differs from the last one (exit 3 if anything does)
rewind diff [<ref>] [--stat] [-- P]   # the changes themselves
rewind undo [<ref>] [--yes] [--force] # put it back (prints the plan first, always)
rewind show <ref>:<path>              # one file as it was
rewind exec -- <command>              # snapshot, run, snapshot
rewind watch [--debounce 2000]        # snapshot on every change
rewind prune [--keep 20] [--older-than 7d]
rewind doctor [--verify]              # can every snapshot still be restored?
```

Refs: `last` (the default), `@2` (two back), an id or unique prefix, `14:32`, or
`2026-09-14`. Full details in
[`skills/rewind/reference/commands.md`](skills/rewind/reference/commands.md).

## Installing as a DSH plugin

```bash
dsh plugin --profile web add github:liyixuan201211/dsh-rewind
```

This installs the skill (`skills/rewind/`), which teaches an agent to snapshot
before a risky change, to wrap risky commands in `rewind exec`, and to work up to
`undo --dry-run` → `undo --yes` instead of reaching for the undo first.

The bundle patch adds **nothing** to the boot graph — `cordis.patch.yml` is
present, valid, and inert. The whole execution surface is that empty file,
`package.json` (no lifecycle scripts), the CLI in `src/`, and the SKILL.md prose.
A tool whose subject is making side effects reversible has no business being an
irreversible new side effect in the boot layer.

## Honest positioning

This is not the first program that can restore a file, so what is it, exactly?

| | What it covers | Where it stops |
|---|---|---|
| **git** | committed content | the working tree, untracked files, non-repos |
| **Time Machine / volume snapshots** | the whole disk, hourly | coarse-grained, OS-specific, restoring one directory is awkward |
| **restic / borg / rsync** | backups to another location | repository setup, encryption config, not aimed at "undo the last 5 minutes" |
| **editor/agent checkpoints** (Claude Code, Cursor, …) | edits that tool made, in that session | vendor- and session-scoped; the store is not yours to read |
| **`rewind`** | any directory, any process, right now | it has no time travel: nothing snapshotted means nothing to restore |

The niche is narrow on purpose: *local, immediate, per-directory, vendor-neutral,
zero-dependency undo, whose store is plain files you can inspect with `ls`.*
A GitHub search for a content-addressed snapshot/undo CLI in this shape returns
essentially nothing, which is either an opportunity or a warning; the honest
answer is that the need is usually served badly by `git stash` and `cp -r`.

It is deliberately **not** a backup. The store lives in the same directory on the
same disk. It protects against a bad edit, not against a dead disk.

## Things it is honest about not knowing

- **There is no time travel.** If nothing was snapshotted before the change,
  there is nothing to go back to. `rewind watch` exists so that this stops being
  something you have to remember.
- **Files over the size limit are recorded, not restorable.** `snap` says so when
  it happens; the undo plan says `can't` when it matters.
- **The store holds plaintext copies of file contents**, including `.env` and
  keys. Keep it out of version control (the `.gitignore` says so) and be aware of
  it on a shared machine. There is no encryption.
- **Ignored paths are not protected from anything else.** It will not touch your
  `node_modules`, and it also cannot restore it.
- **A snapshot is not a commit.** Restoring an old snapshot discards whatever
  came after it, deliberately, including someone else's work.
- **Large repositories cost disk.** Deduplication is exact, so the cost is the
  sum of distinct file versions, but that is still a second copy of everything.

## Development

Requires Node >= 20. Plain ESM JavaScript with JSDoc types: no build step, no
install-time scripts, and the published `bin` actually runs when installed —
CI asserts that by packing the tarball and running it from a real `node_modules`.

```bash
npm test            # 105 tests
npm run typecheck   # tsc --noEmit over the JSDoc types
npm run check       # both
./examples/demo.sh  # end to end, asserting every exit code
```

```
src/
  cli.js         the exit-code contract and argument parsing
  config.js      what is captured, the ignore rules, and the stored policy
  scan.js        walking the tree: content hashes, symlinks, what cannot be read
  store.js       content-addressed objects, manifests, the append-only log
  snapshot.js    scan → manifest → one log line
  plan.js        comparing two manifests; the undo plan and every refusal
  undo.js        preflight, snapshot the present, apply, verify
  diff.js        a unified diff, capped and honest about being capped
  refs.js        naming a moment: last, @2, an id, 14:32
  exec.js        snapshot, run, snapshot
  watch.js       debounced automatic snapshots
  prune.js       mark and sweep
  doctor.js      can this store still do what it promises?
  report.js      human output
```

CI runs the suite on Node 20/22/24, installs the packed tarball into a real
`node_modules` and restores a file with it, runs the safety properties on their
own, runs the demo, and checks that `src/` contains no network import and that
`package.json` defines no lifecycle script.

## License

MIT.
