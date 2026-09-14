# Changelog

## 1.0.0 — 2026-09-14

First release.

**The idea: an undo whose undo also works, in any directory, git or not.** The
thing that actually needs recovering is almost never a commit — it is the working
tree an agent just rewrote: uncommitted edits, files git has never seen, a config
overwritten from a template. git holds commits; it does not hold an hour ago.

### Added

- `rewind snap` — a content-addressed snapshot of the tree: regular files,
  directories (including empty ones), symlinks and permission bits.
- `rewind undo [<ref>]` — restore the tree to a snapshot. Refuses, changing
  nothing, without `--yes`; prints the plan first, always, with or without it.
- `rewind exec -- <command>` — snapshot, run, snapshot. Exits with the wrapped
  command's status, so it composes; prints the before-id, so one command is one
  undo.
- `rewind watch` — debounced automatic snapshots. Events are coalesced and a
  content-addressed manifest decides whether anything really changed, so an idle
  tick costs one comparison and writes no log line.
- `rewind status` / `diff` / `show` / `log` — what differs from a snapshot, the
  unified diff of it, one file as it was, and the history.
- `rewind prune` / `doctor` — mark-and-sweep GC that keeps anything a surviving
  snapshot references, and a store check that can re-hash every object.
- Refs by name (`last`), position (`@3`), unique id prefix, or time (`14:32`,
  `2026-09-14`).
- A DSH skill (`skills/rewind/`) that teaches the agent to snapshot before a
  risky change, to wrap risky commands in `exec`, and to work up to
  `undo --dry-run` → `undo --yes` instead of reaching for the undo first.

### Safety properties, with tests

Each of these is a way an "undo" could destroy data, and each is asserted on its
own in `test/safety.test.js` / `test/undo.test.js`:

- **A refusal changes nothing.** Unsafe paths, inconsistent manifests and missing
  objects are all detected before the first write.
- **Nothing is removed recursively.** A directory is removed with `rmdir`, only
  if empty, so content the snapshot never captured survives — and is reported.
- **Uncaptured content is never deleted.** A file that was too large or
  unreadable at snapshot time is recorded as such, and removing it is refused
  unless `--force` says otherwise.
- **The undo is undoable.** The replaced state is snapshotted before anything is
  touched, and its id printed.
- **A modified file is never deleted and recreated**, so a failed restore cannot
  have already destroyed the file it failed to restore.
- **Content is verified before it is written**, so a corrupt object is reported
  rather than written over a real file.
- **Writes are atomic** — temporary file, chmod, rename.
- **Symlinks are recorded, never followed**, in either direction.
- **No path outside the root is written**, from a hostile manifest or otherwise.
- **The capture policy only grows**: a path any version of the policy excluded
  stays protected, so deleting a rule cannot make an old path deletable.
- **The store is created owner-only** (`0700`), because it holds plaintext copies
  of file contents.

### Bugs found and fixed while building this

Kept here because each one is a hazard this class of tool walks into, and the
test that pins it is the useful part:

- **Modified files were deleted before being restored.** The planner treated any
  non-identical path as a removal, so every edited file was unlinked and then
  rewritten. It looked harmless until a restore failed — a corrupt object — and
  the file was simply gone. Caught by the corrupt-object test, and the fix is why
  "every removal is planned before any write" is now asserted directly.
- **The manifest stored mtime**, so a file that was merely *touched* produced a
  different manifest hash and `unchanged` disagreed with the diff. Content and
  change-detection are now separate: the manifest is content only, and the
  size+mtime shortcut lives in `stat.json`, where being wrong costs a re-read.
- **Permission bits were invisible to the differ**, so `chmod -x` was not
  restored even though the mode was captured. `sameEntry` now compares mode.
- **Capture policy was not persisted.** A store created with
  `--max-file-size 10` recorded a 46-byte file as "not captured"; a later undo
  using the default 8 MiB saw an ordinary file, concluded it was "new", and
  deleted the only copy. The policy now lives in `meta.json` and later commands
  adopt it, and a path the *target* never captured is never deleted.
- **A manifest could name a file with no parent directory.** The write then had
  nowhere to land — which, if the parent existed as a symlink in the live tree,
  was the only thing preventing a write outside the root. Such manifests are now
  refused before anything runs, so the guarantee does not rest on that accident.
- **Diff hunks lost their context and restarted at line 1.** Trimming the common
  prefix and suffix for the LCS table left the returned sequence describing only
  the middle, so every hunk was numbered from 1 with no context lines. The trim
  is now purely internal.
- **`DIFF_MAX_LINES` was documented but never enforced**, so a 1500-line pair
  produced a full diff rather than the "too large to diff" line the cap promises.

### Notes

- Requires Node >= 20. Plain ESM JavaScript with JSDoc types: no build step, no
  install-time scripts. They cannot be TypeScript, because Node refuses to strip
  types for files inside `node_modules` — where the package lands when installed
  or run through `npx`. `npm run typecheck` still checks the whole tree.
- The cordis patch is intentionally empty: this plugin adds nothing to the boot
  graph, and a tool about reversible side effects should not be an irreversible
  one.
- **The store holds plaintext file contents**, including `.env` files and keys.
  It is created `0700` and `.gitignore` excludes it, and there is no encryption.
- The store is in the same directory on the same disk. This is an undo, not a
  backup.
- 106 tests, typecheck clean, CI on Node 20/22/24 plus an `installable` job that
  packs the tarball, installs it into a real consumer `node_modules` and restores
  a file with the installed bin. Two more jobs assert that `src/` imports no
  network module and that `package.json` defines no lifecycle script.
