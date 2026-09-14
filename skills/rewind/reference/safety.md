# The safety properties, and why each one exists

Every item below is asserted by a test in `test/safety.test.js` or
`test/undo.test.js`. They are listed here because a tool that edits your files
should be reviewable without reading the source — and because each one is a way
an "undo" could destroy data instead of restoring it.

## 1. A refusal changes nothing

The plan is built completely before anything is applied, and any problem found
during planning stops the whole thing:

- a path in the manifest that is absolute, contains `..`, or is otherwise out of
  bounds;
- a manifest that breaks its one structural promise — that every path's
  ancestors are recorded, and all of them are directories. Either a path is both
  a file and a parent (`a` and `a/b`), or a parent is missing entirely
  (`a/b` with no `a`);
- an object that a needed restore would read but which is missing from the store.

The missing-parent case is not pedantry. If a manifest names `link/file.txt`
without recording `link`, no directory step is planned — and if `link` happens to
be a symlink to a directory outside the root, the write would follow it. Creating
parents on the fly is exactly what would turn that into an escape, so a manifest
that omits them is refused rather than repaired. The guarantee does not rest on
the accident that the write would have had nowhere to land. An accompanying test
asserts the other half of the reasoning directly: **every removal is planned
before every write**, so a symlink is always unlinked before anything is created
beneath it.

A refusal exits `5` and leaves the tree untouched. An undo that stops half-way is
worse than no undo, because now there are two inconsistent states to reason about
and no record of which files are in which.

## 2. Nothing is removed recursively

A deletion step names one file, or names a directory that is removed only if it
is already empty (`rmdir`, never `rm -rf`). Files the snapshot never captured —
anything under `node_modules/`, a file over the size limit, a build artefact the
policy excludes — therefore survive an undo by construction, and the output
reports them under `kept`.

## 3. A path whose bytes were not captured is never deleted

If a file was too large or unreadable at snapshot time, it is recorded as an `x`
entry with the reason. Removing it during an undo could not be undone, so:

- if the *target* manifest has an `x` entry for a path that now holds something,
  the undo is refused;
- if the *live* tree has an `x` entry for a path the target does not have, the
  undo is refused.

`--force` overrides both, and is the only way to override them.

## 4. The undo is undoable

Before applying anything, `undo` snapshots the state it is about to replace —
including files created since the last snapshot, which is why the pre-undo scan
writes content into the store. The id of that safety snapshot is printed, and
rewinding to it restores exactly what was there.

This is why `undo` performs its own scan rather than trusting the newest log
entry: the newest entry describes an *older* state whenever the tree has drifted,
which is precisely when someone reaches for `undo`.

## 5. Modified files are never deleted and recreated

A path that exists as the same kind of thing in both the live tree and the target
is a modification, handled by a write step. It is not deleted first. Deleting
first would mean that a restore which then failed — a corrupt object, a
permission error, a full disk — had already destroyed the file it failed to
restore.

## 6. Content is verified before it is written

An object's filename is the hash of its contents. A restore re-hashes what it
read and refuses to write it if they disagree, reporting a failure instead. A
corrupted store therefore cannot silently write wrong bytes over a real file.

## 7. Writes are atomic

Restored content lands in a sibling temporary file, is chmod-ed to the recorded
mode, and is renamed into place. An interrupted undo never leaves a half-written
file where a real one used to be.

## 8. Symlinks are recorded, never followed

During a scan a symlink becomes a link entry naming its target; its target is not
read, so a link pointing outside the root cannot pull outside content in, and a
link cycle cannot hang the scan. During an undo a link is unlinked before
anything is written at that path, so a restore cannot be redirected through a
link the agent created.

## 9. Excluded paths stay out of undos

A path the policy excludes is skipped while scanning *and* re-checked while
planning, so the two cannot disagree. The store also persists its capture policy
(`.rewind/meta.json`) and later commands adopt it, because a command using a
different `--max-file-size` or `--exclude` than the snapshot did would compute a
different view of the tree — and "not in the snapshot" is what makes a path look
like something to delete.

## 10. The policy only ever grows more protective

Exclusion rules from the store are unioned with the ones currently in force. A
name that any version of the policy excluded stays protected, so deleting an
exclusion rule can never turn into an undo that removes files the store has no
copy of.

## What these properties do *not* claim

- **They are not a backup.** The store is in the same directory, on the same
  disk. They protect against a bad edit, not a dead disk.
- **They do not make a stale snapshot correct.** Restoring a snapshot from before
  someone else's work discards that work, deliberately and by definition.
- **They do not cover what was never captured.** `git`, `node_modules`, and
  anything else the policy leaves out are outside every guarantee here — that is
  the reason they are left out.
- **They do not encrypt the store.** Captured file contents — including `.env`
  and credentials — sit in `.rewind/objects/` as plaintext. Keep it out of
  version control, and be aware of it on a shared machine.
