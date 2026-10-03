#!/usr/bin/env bash
# dry-run.sh -- exercise the real scripts (vibe-run.sh, gates.sh,
# scope-branch.sh) against throwaway git repos, with tests/fakevibe standing in
# for vibe. No real vibe, no network, no forge.
#
#   bash tests/dry-run.sh [WORKDIR]     (default: a new dir under $TMPDIR or /tmp)
#
# Prints one line per case and exits 1 if any expectation fails.
set -uo pipefail
SK=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
T=${1:-$(mktemp -d "${TMPDIR:-/tmp}/vd-dry.XXXXXX")}
mkdir -p "$T"
T=$(cd "$T" && pwd)
cd "$T" || exit 2
export VIBE_BIN=$SK/tests/fakevibe STUB_ENV_OUT=/dev/null VD_LOCK_DIR=$T/locks
export GIT_AUTHOR_NAME=dry GIT_AUTHOR_EMAIL=dry@example.invalid GIT_COMMITTER_NAME=dry GIT_COMMITTER_EMAIL=dry@example.invalid
# shellcheck source=lib.sh
source "$SK/lib.sh"
trap - ERR
set +e
bad=0
# expect NAME JQ_EXPR JSON -- the case passes when the jq expression is true.
expect() {
  local name=$1 expr=$2 json=$3 got
  got=$(jq_ -c "$expr" <<<"$json" 2>/dev/null)
  if [[ $got == true ]]; then
    printf 'ok    %s\n' "$name"
  else
    printf 'FAIL  %s: %s\n' "$name" "$(jq_ -c . <<<"$json" 2>/dev/null | cut -c1-300 || echo "$json")"
    bad=$((bad + 1))
  fi
}
last_json() { tail -n 1; }
# truth NAME CMD... -- the case passes when CMD succeeds.
truth() {
  local name=$1
  shift
  if "$@"; then printf 'ok    %s\n' "$name"; else printf 'FAIL  %s\n' "$name"; bad=$((bad + 1)); fi
}

# Fixture: a root commit, then an inherited commit on main.
rm -rf repo
git init -q -b main repo
git -C repo commit -q --allow-empty -m root
ROOT=$(git -C repo rev-parse HEAD)
mkdir -p repo/other && echo inherited >repo/other/inherited.txt
git -C repo add other && git -C repo commit -q -m "inherited: other/inherited.txt"
FORK=$(git -C repo rev-parse HEAD)
printf 'prompt text' >prompt.md
reset() { git -C repo checkout -q -B "pkg-$1" "$FORK" && git -C repo clean -qfd; }
vr() { # name mode args...
  local name=$1 mode=$2
  shift 2
  reset "$name"
  STUB_MODE=$mode bash "$SK/vibe-run.sh" run --wt repo --prompt prompt.md --out "out-$name" "$@" 2>/dev/null | last_json
}

echo '--- vibe-run.sh delivered'
expect change-commit '.delivered' "$(vr a commit --base "$FORK" --allow src/)"
expect change-no-commit '.delivered | not' "$(vr b none --base "$FORK" --allow src/)"
expect out-of-scope '(.delivered | not) and (.out_of_scope | length > 0)' "$(vr c oos --base "$FORK" --allow src/)"
expect dirty '.delivered | not' "$(vr d dirty --base "$FORK" --allow src/)"
expect plan-file '.delivered' "$(vr e plan --base "$FORK" --expect-file .vd-plan.json --expect-commits no)"
expect verify-zero-commits '.delivered' "$(vr f verify --base "$FORK" --allow src/ --expect-commits any --expect-file .vd-verify.md --blocked-file .vd-blocked.md)"
expect verify-no-note '.delivered | not' "$(vr g none --base "$FORK" --allow src/ --expect-commits any --expect-file .vd-verify.md)"
expect verify-with-commit '.delivered' "$(vr g2 verifycommit --base "$FORK" --allow src/ --expect-commits any --expect-file .vd-verify.md)"
expect base-at-root-sees-inherited '(.delivered | not) and (.out_of_scope | index("other/inherited.txt") != null)' "$(vr h2 commit --base "$ROOT" --allow src/)"
expect revert-inherited-is-oos '.delivered | not' "$(vr n revertinherited --base "$FORK" --allow src/)"
expect blocked '(.delivered | not) and .blocked' "$(vr j blocked --base "$FORK" --allow src/ --blocked-file .vd-blocked.md)"

echo '--- fix round counts only its own commits'
reset i
STUB_MODE=commit bash "$SK/vibe-run.sh" run --wt repo --prompt prompt.md --out out-i0 --base "$FORK" --allow src/ >/dev/null 2>&1
R0=$(git -C repo rev-parse HEAD)
expect fix-no-new-commit '.delivered | not' "$(STUB_MODE=none bash "$SK/vibe-run.sh" run --wt repo --prompt prompt.md --out out-i1 --base "$FORK" --commits-since "$R0" --allow src/ 2>/dev/null | last_json)"
expect fix-new-commit '.delivered' "$(STUB_MODE=commit bash "$SK/vibe-run.sh" run --wt repo --prompt prompt.md --out out-i2 --base "$FORK" --commits-since "$R0" --allow src/ 2>/dev/null | last_json)"

echo '--- start refusals'
reset k
out=$(bash "$SK/vibe-run.sh" start --wt repo --prompt prompt.md --out out-k1 2>&1 | tail -1)
truth 'missing --base refused' test -n "$(grep -F -- --base <<<"$out")"
out=$(bash "$SK/vibe-run.sh" start --wt repo --prompt prompt.md --out out-k2 --base "$FORK" --prompt-bytes 5 2>&1 | tail -1)
truth 'prompt-bytes mismatch refused' test -n "$(grep -F PROMPT_MISMATCH <<<"$out")"

echo '--- policy guards'
rm -rf remote.git rc
git init -q --bare -b main remote.git
git clone -q remote.git rc 2>/dev/null
git -C rc commit -q --allow-empty -m base && git -C rc push -q origin HEAD:main && git -C rc fetch -q
F=$(git -C rc rev-parse HEAD)
git -C rc checkout -q -b feat/x
expect push-to-default '(.delivered | not) and (.policy_violations | length > 0)' "$(STUB_MODE=pushmain bash "$SK/vibe-run.sh" run --wt rc --prompt prompt.md --out out-p1 --base "$F" --allow src/ --guard-ref origin/main --mr-check-cmd 'echo 0' 2>/dev/null | last_json)"
git -C rc checkout -q -B feat/y "$F"
expect mr-exists '(.delivered | not) and (.policy_violations | length > 0)' "$(STUB_MODE=commit bash "$SK/vibe-run.sh" run --wt rc --prompt prompt.md --out out-p2 --base "$F" --allow src/ --guard-ref origin/main --mr-check-cmd 'echo 1' 2>/dev/null | last_json)"

echo '--- gates.sh (verify-only)'
cat >prof.yaml <<'P'
version: 1
repo: demo
default_branch: main
remote: null
no_remote: true
worktree_root: ~/x
bookkeeping: {files: [TODO.md], plan_entry_file: TODO.md, followup_file: TODO.md, convention: "none"}
merge: {}
gates:
  - {name: other-lint, cmd: "echo FILES={touched_files}", paths: ["other/*"]}
  - {name: src-only, cmd: "true", paths: ["src/*"]}
known_master_failures: []
P
git -C repo checkout -q -B gv "$FORK"
g() { bash "$SK/gates.sh" run --profile prof.yaml --wt repo --base "$FORK" "$@" 2>/dev/null | last_json; }
expect gates-nothing-ran '.ran == 0' "$(g --out g1)"
expect gates-verify-paths-and-extra '.ok and .ran >= 2' "$(g --out g2 --verify-paths other/ --extra-cmd 'echo running test; true')"
expect gates-extra-failing '.ok | not' "$(g --out g3 --verify-paths other/ --extra-cmd 'exit 3')"
expect gates-verify-path-not-oos '.ok and (.out_of_scope | length == 0)' "$(g --out g4 --allow src/ --verify-paths other/)"

echo '--- scope-branch.sh'
rm -rf sb wts
git init -q -b main sb
(
  cd sb || exit 1
  echo base >f.txt && echo log >WIP.md && git add -A && git commit -qm base
  git checkout -q -b build-on && echo work >g.txt && git add g.txt && git commit -qm "work g"
  git checkout -q main && echo m2 >h.txt && git add h.txt && git commit -qm "main moved"
  git checkout -q -b conflicting main~1 && echo conflict >h.txt && git add h.txt && git commit -qm "conflicting h"
  git checkout -q main
)
expect create-build-on '.ok and .inherited == 1' "$(bash "$SK/scope-branch.sh" create --repo sb --path "$T/wts/int1" --branch int/one --base-ref main --build-on build-on --out sbout1 2>/dev/null | last_json)"
expect create-conflict-fails '.ok | not' "$(bash "$SK/scope-branch.sh" create --repo sb --path "$T/wts/int2" --branch int/two --base-ref main --build-on conflicting --out sbout2 2>/dev/null | last_json)"
truth 'conflict leaves no branch or worktree' test -z "$(git -C sb branch --list int/two)" -a ! -e "$T/wts/int2"
printf -- '- [ ] task one\n- [ ] task two' >entry.md
expect record-bytes-ok '.ok' "$(bash "$SK/scope-branch.sh" record --wt "$T/wts/int1" --file WIP.md --entry entry.md --entry-bytes 29 --message "docs: plan of record" 2>/dev/null | last_json)"
expect record-bytes-wrong '(.ok | not) and (.reason | test("ENTRY_MISMATCH"))' "$(bash "$SK/scope-branch.sh" record --wt "$T/wts/int1" --file WIP.md --entry entry.md --entry-bytes 7 --message x 2>/dev/null | last_json)"
(cd sb && echo m3 >i.txt && git add i.txt && git commit -qm "main moved again")
expect refresh '.ok and .merged' "$(bash "$SK/scope-branch.sh" refresh --wt "$T/wts/int1" --base-ref main 2>/dev/null | last_json)"

echo '--- scope-branch.sh merge (integrator "script")'
INT=$T/wts/int1
IH=$(git -C "$INT" rev-parse HEAD)
git -C sb branch pkg/ok "$IH"
git -C sb worktree add -q "$T/wts/pkg-ok" pkg/ok
(cd "$T/wts/pkg-ok" && mkdir -p src && echo ok >src/ok.txt && git add src && git commit -qm "feat: ok")
PH=$(git -C sb rev-parse pkg/ok)
expect merge-tree-equal '.ok and .merged and .tree_equal' "$(bash "$SK/scope-branch.sh" merge --wt "$INT" --branch pkg/ok --pkg-head "$PH" --fork "$IH" --expect-head "$IH" 2>/dev/null | last_json)"
IH2=$(git -C "$INT" rev-parse HEAD)
expect merge-wrong-expect-head '.ok | not' "$(bash "$SK/scope-branch.sh" merge --wt "$INT" --branch pkg/ok --pkg-head "$PH" --fork "$IH" --expect-head "$IH" 2>/dev/null | last_json)"
git -C sb branch pkg/clash "$IH"
git -C sb worktree add -q "$T/wts/pkg-clash" pkg/clash
(cd "$T/wts/pkg-clash" && mkdir -p src && echo clash >src/ok.txt && git add src && git commit -qm "feat: clash")
CH=$(git -C sb rev-parse pkg/clash)
expect merge-conflict-aborts '(.ok | not) and .conflicts and (.files | index("src/ok.txt") != null)' "$(bash "$SK/scope-branch.sh" merge --wt "$INT" --branch pkg/clash --pkg-head "$CH" --fork "$IH" --expect-head "$IH2" 2>/dev/null | last_json)"
truth 'conflict leaves HEAD and tree unchanged' test "$(git -C "$INT" rev-parse HEAD)" = "$IH2" -a -z "$(git -C "$INT" status --porcelain)"
expect merge-stale-pkg-head '.ok | not' "$(bash "$SK/scope-branch.sh" merge --wt "$INT" --branch pkg/clash --pkg-head "$IH" --fork "$IH" 2>/dev/null | last_json)"

echo "dry runs in $T"
if ((bad == 0)); then echo 'DRY-RUN: all cases passed'; else echo "DRY-RUN: $bad failure(s)"; exit 1; fi
