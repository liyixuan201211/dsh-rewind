---
name: rewind
description: "Undo what an agent did to a directory. Use BEFORE a risky multi-file change or a destructive shell command (rewind snap / rewind exec), and AFTER something went wrong — a broken refactor, a bad codemod, deleted files, a clobbered config, a chmod that broke a script. Also when the user asks 怎么撤回 / 能不能撤销 / undo that / go back / restore what it looked like / what changed since. Works in any folder, with or without git, and can restore files git never tracked."
license: MIT
# The skill asks the agent to run shell commands and read files, and `undo`
# writes files back, so Bash and Read are declared. Declaring the truth is the
# point of the ecosystem it belongs to.
allowed-tools: Bash, Read
metadata:
  version: "1.0.0"
  date: "2026-09-14"
  upstream: "https://github.com/liyixuan201211/dsh-rewind"
---

# rewind

Most "undo" advice assumes the thing that changed is in version control. It
usually is not: an agent edits files in a repository with uncommitted work,
writes into a directory that was never a repository at all, or creates and
deletes scratch files that git never saw.

`rewind` snapshots a directory into its own content-addressed store and can put
the whole tree back — including files git does not track, and including files
that never existed in any commit.

Pair it with `blastradius`: that one tells you what a command *would* destroy,
this one gets it back after it did.

## The one idea: the undo is undoable

`undo` snapshots the present before it touches anything. So the state you
replace is not lost — it is itself a snapshot, and its id is printed. Undoing an
undo is an ordinary operation, not a rescue.

Two consequences worth knowing before you rely on it:

- **Nothing is ever removed recursively.** An undo removes exactly the files it
  captured, then removes a directory only if it is empty. A `node_modules/` or a
  scratch file inside a directory that the snapshot never captured survives.
- **A path whose contents were never captured is never deleted.** If a file was
  too large or unreadable at snapshot time, removing it could not be undone, so
  the whole undo is refused rather than performed half-way.

## Set up the command once per session

```bash
rw() {
  if command -v rewind >/dev/null 2>&1; then rewind "$@"
  else npx --yes github:liyixuan201211/dsh-rewind "$@"
  fi
}
```

## Before the risky thing

**A failed change is cheap to reverse only if you took a snapshot first.** Take
one before any change that touches more than a file or two, and before anything
that deletes:

```bash
rw snap --label "before the auth refactor"
```

Label it with what you are *about to do* — a week later `before the auth
refactor` is worth more than a timestamp.

For a shell command that rewrites many files — a codemod, a formatter, a
migration, a build that writes into the tree — wrap it instead. That records the
before and after in one step and hands back a snapshot id that corresponds to
exactly one command:

```bash
rw exec -- npx jscodeshift -t transform.js src/
rw exec -- rm -rf build/ dist/        # then: rw undo <id> --yes
```

`exec` returns the wrapped command's own exit code, so it is safe to use in a
pipeline. Wrapping a command is the cheapest insurance available; prefer it over
`snap` when a single command is the thing you are worried about.

If the user expects to work for a while — a long refactor, an unfamiliar
codebase, a session where something is likely to go wrong — offer to leave a
watcher running in the background instead:

```bash
rw watch --debounce 2000
```

## After something went wrong

Work up to the undo; do not start with it.

```bash
rw status                    # what differs from the last snapshot (exit 3 if anything does)
rw diff                      # the actual changes, as a unified diff
rw diff --stat               # just the paths and line counts
rw undo --dry-run            # the exact plan: what would be restored, removed, created
rw undo --yes                # do it
```

**Always run `--dry-run` (or plain `rw undo`) and read the plan before passing
`--yes`.** The plan names every path and every action, and it is the exact plan
that will be applied — there is no second scan in between that could differ.
Using `--yes` without reading the plan throws away the only chance to notice
that the snapshot you picked is not the one you meant.

The output is worth reading closely. `rmdir … only if empty` means a directory
will be removed only if nothing the snapshot never captured is inside it, and
`can't … not in the store` means one path cannot be brought back — everything
else still will be.

## Exit codes are the contract

| Exit | Meaning |
|---|---|
| `0` | ok |
| `1` | an error while applying — some paths may not have been restored (read the output) |
| `2` | usage error |
| `3` | `status` only: the tree differs from the last snapshot |
| `4` | `undo`: the plan is ready, but `--yes` was not given. **Nothing changed.** |
| `5` | refused: an unsafe path, or content that was never captured. **Nothing changed.** |
| `6` | nothing to do: the tree is already at that state. **Nothing changed.** |

Codes 4, 5 and 6 all mean *nothing happened*. They are separate numbers so that
"I chose not to act" is never confused with "I acted and it failed". When you see
5, do not reach for `--force` on your own — read the reason it gives and tell the
user, because the reason is always "the store has no copy of this".

## Choosing the snapshot to go back to

```bash
rw undo last            # the most recent snapshot
rw undo @2              # two snapshots ago
rw undo 20260914T1015   # an id or any unique prefix
rw undo 14:32           # the newest snapshot at or before 14:32 today
```

`rw log` lists them with labels, which is why labelling matters. After an
`undo`, `last` is the state you just restored *to*; the way back to what you
replaced is the `pre-undo` id that `undo` prints — copy it from the output
rather than assuming.

## What it captures, and what it therefore cannot restore

Captured: every regular file up to 8 MiB, directories (including empty ones),
symlinks (recorded as links and never followed), and permission bits.

Not captured, and therefore never touched by an undo: `.git`, `node_modules`,
`.venv`, `__pycache__`, `dist`, `build`, `target` and the other entries in
`DEFAULT_EXCLUDED_NAMES`, plus anything matched by a `.rewindignore` in the root
or by `--exclude`. **A path that was not captured is a path the undo refuses to
delete**, which is the whole reason that list exists.

Honest limits:

- **There is no time travel.** If nothing was snapshotted before the change,
  there is nothing to go back to. Take the snapshot first — that is the entire
  discipline this tool asks for.
- **Files over the size limit are recorded but not restorable.** `rw snap` says
  so when it happens; `rw diff` and the undo plan say `can't` when it matters.
- **The store holds plaintext copies of file contents**, including `.env` and
  keys, under `.rewind/`. It must never be committed — the generated
  `.gitignore` says so — and it doubles the disk usage of everything it captures
  (less with deduplication, which is exact, not approximate).
- **Excluded paths are not protected from anything else.** `rewind` will not
  touch `node_modules`, but it also cannot restore it. Use the package manager.
- **A snapshot is not a backup.** It lives in the same directory, on the same
  disk. It protects against a bad edit, not against a dead disk.

## Two rules for using it well

1. **Snapshot before, not after.** `rewind` cannot recover what was never
   captured, and no amount of care at the end of a session substitutes for a
   snapshot at the start of it.
2. **Never pass `--force` without asking.** It exists for the one case where the
   user knows a large or unreadable file is expendable. Reaching for it to get
   past a refusal defeats the check that refusal represents.
