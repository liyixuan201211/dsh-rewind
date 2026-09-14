# Commands

Every command takes the same global options.

```
--root <dir>             the directory to protect (default: the working directory)
--store <dir>            where the store lives (default: <root>/.rewind)
--exclude <name|path>    leave more out (repeatable)
--max-file-size <bytes>  capture files up to this size (default: 8388608)
--rehash                 ignore the size+mtime cache and re-read everything
-q, --quiet              only what matters
--json                   machine-readable output
```

## Taking snapshots

```bash
rw snap                          # snapshot now
rw snap --label "before refactor"
rw snap --note "green tests, 3 failures known"
rw init                          # create the store without snapshotting
```

`snap` records even when nothing changed, and says so (`unchanged`). That is
deliberate: "I checked and nothing moved" is information. `watch` is the one
exception — an idle timer tick is not recorded, or the log would be mostly ticks.

## Reading history

```bash
rw log                           # the last 20, newest first
rw log --limit 100
rw log --json
rw status                        # what differs from the last snapshot
rw diff                          # unified diff of everything that changed
rw diff @3                       # since a specific snapshot
rw diff --stat                   # paths and line counts only
rw diff --stat -- src tests      # paths after -- are filters
rw show @2:src/app.js            # one file as it was
```

`status` exits `3` when there is drift, so it doubles as a check:

```bash
rw status -q || echo "the tree has moved since the last snapshot"
```

## Going back

```bash
rw undo                          # print the plan; change nothing (exit 4)
rw undo --dry-run                # the same thing, explicitly
rw undo --yes                    # apply it
rw undo @3 --yes
rw undo 14:32 --yes              # the newest snapshot at or before 14:32
rw undo "<id>" --yes --force     # also remove paths whose contents were never captured
```

`undo` targets: nothing / `last` / `HEAD` for the newest, `@N` to count back
from the newest, an id or any unique id prefix, or a time (`14:32`, `2026-09-14`,
`2026-09-14 14:32`).

The plan is printed before anything is touched, with or without `--yes`, and it
is the exact plan that gets applied.

## Wrapping commands

```bash
rw exec -- make test                       # snapshot, run, snapshot
rw exec --label "codemod" -- npx jscodeshift -t t.js src/
```

The wrapped command inherits the terminal, and `exec` exits with *its* status.
The summary goes to stderr, so stdout stays the command's own.

## Continuous protection

```bash
rw watch                         # snapshot on every change until Ctrl-C
rw watch --debounce 2000
rw watch --once                  # one snapshot and exit (useful in a hook)
```

Events are coalesced by the debounce window and a content-addressed manifest
decides whether anything actually changed, so an idle tick costs one comparison.
Changes to the store itself are ignored — otherwise every snapshot would trigger
the next one.

## Maintenance

```bash
rw prune --keep 20               # forget snapshots older than the newest 20
rw prune --older-than 7d
rw prune --dry-run
rw doctor                        # can every snapshot still be restored?
rw doctor --verify               # also re-hash every object (slower)
```

`prune` marks and sweeps: objects shared with a surviving snapshot are kept, and
the newest snapshot is never dropped. `doctor` reports a missing manifest, a
missing object, a corrupt object (with `--verify`), a duplicate id, and a store
whose recorded root does not match the directory it is being used for.
