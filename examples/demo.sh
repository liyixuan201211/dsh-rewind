#!/usr/bin/env bash
#
# An end-to-end run of the thing this tool claims to do: break a directory the
# way an agent breaks one, and put it back — then put the breakage back, because
# an undo that cannot be undone is just a different way to lose work.
#
# The exit codes are the contract, so the demo asserts them rather than only
# printing output.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$HERE/src/cli.js"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

rw() { node "$CLI" "$@"; }

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "a directory, before anything goes wrong"
mkdir -p src docs
printf 'export const answer = 41\n' > src/app.js
printf '# Guide\n\nHow it works.\n' > docs/guide.md
printf '#!/bin/sh\necho build\n' > build.sh
chmod +x build.sh
rw snap --label "before the refactor"

step "an agent rewrites the tree"
printf 'export const answer = 42\n' > src/app.js
printf 'export const helper = () => 0\n' > src/helper.js
rm -f docs/guide.md
mkdir -p scratch/node_modules/dep
printf 'a dependency nobody snapshotted\n' > scratch/node_modules/dep/index.js
printf 'scratch\n' > scratch/notes.txt

rw status
printf 'status exit: %s (3 = the tree has drifted)\n' "$?"

step "what actually changed"
rw diff --stat

step "the plan, before anything is touched"
rw undo
printf 'undo without --yes: %s (4 = nothing changed)\n' "$?"

# Refusing must mean refusing.
[ "$(cat src/app.js)" = 'export const answer = 42' ] \
  || { echo "a refusal changed a file"; exit 1; }
[ -f src/helper.js ] || { echo "a refusal removed a file"; exit 1; }

step "apply it"
rw undo --yes
printf 'undo --yes: %s\n' "$?"

[ "$(cat src/app.js)" = 'export const answer = 41' ] || { echo "the edit was not restored"; exit 1; }
[ -f docs/guide.md ] || { echo "the deleted file was not restored"; exit 1; }
[ -f src/helper.js ] && { echo "the added file was not removed"; exit 1; }
[ -x build.sh ] || { echo "the executable bit was not restored" ; exit 1; }
echo "the tree is back: edit reverted, deletion restored, additions removed, mode restored"

step "the uncaptured dependency survived"
[ -f scratch/node_modules/dep/index.js ] \
  || { echo "an undo removed content it never captured"; exit 1; }
echo "scratch/node_modules/dep/index.js is still here — an undo never removes recursively"

step "and the undo is itself undoable"
safety="$(rw log --json | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const log = JSON.parse(s);
    const pre = log.filter((r) => r.label.startsWith("pre-undo")).pop();
    process.stdout.write(pre ? pre.id : "");
  });')"
[ -n "$safety" ] || { echo "no pre-undo safety snapshot was recorded"; exit 1; }

rw undo "$safety" --yes >/dev/null
[ "$(cat src/app.js)" = 'export const answer = 42' ] \
  || { echo "the undo of the undo did not restore the mess"; exit 1; }
[ -f src/helper.js ] || { echo "the undo of the undo did not restore the addition"; exit 1; }
echo "the breakage is back, byte for byte: rewind undo $safety"

step "wrapping a command instead of remembering to snapshot"
rw exec -- node -e "require('fs').writeFileSync('generated.txt','from a build step\n')" 2>/dev/null
[ -f generated.txt ] || { echo "exec did not run the command"; exit 1; }
folded="$(rw log --json | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const log = JSON.parse(s);
    const before = log.filter((r) => r.label.startsWith("before:")).pop();
    process.stdout.write(before ? before.id : "");
  });')"
rw undo "$folded" --yes >/dev/null
[ -f generated.txt ] && { echo "undoing the wrapped command left its output behind"; exit 1; }
echo "rewind exec -- <command> makes one command reversible by id"

step "the store can be trusted"
rw doctor --verify

step "exit codes are the contract"
# Each code is produced on purpose, and asserted: a change to the contract
# should fail here rather than be discovered by whoever depended on it.
check_code() { # label expected actual
  if [ "$3" != "$2" ]; then
    printf '  %-14s -> %s, expected %s\n' "$1" "$3" "$2"
    echo "the exit-code contract changed"
    exit 1
  fi
  printf '  %-14s -> %s\n' "$1" "$3"
}

printf 'drift\n' > src/app.js
set +e
rw status >/dev/null 2>&1;                       check_code "drift"         3 $?
rw undo "$safety" --dry-run >/dev/null 2>&1;     check_code "dry run"       0 $?
rw undo "$safety" >/dev/null 2>&1;               check_code "needs --yes"   4 $?
rw undo "$safety" --yes >/dev/null 2>&1;         check_code "apply"         0 $?
rw undo "$safety" --yes >/dev/null 2>&1;         check_code "nothing to do" 6 $?
rw frobnicate >/dev/null 2>&1;                   check_code "usage"         2 $?
set -e

# 4 and 6 both mean nothing happened; so does a refusal at 5.
set +e
rw snap --max-file-size 1 >/dev/null 2>&1
printf 'yy' > bigger.bin
rw undo last --yes >/dev/null 2>&1;              check_code "refused"       5 $?
set -e
[ -f bigger.bin ] || { echo "a refusal removed a file"; exit 1; }

printf '\n\033[1mrewind works.\033[0m\n'
