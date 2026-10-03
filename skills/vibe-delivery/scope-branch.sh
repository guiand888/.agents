#!/usr/bin/env bash
# shellcheck disable=SC2016  # jq programs use $vars inside single quotes on purpose
# scope-branch.sh -- create and maintain a scope's integration branch,
# mechanically. Part of the vibe-delivery skill.
#
#   scope-branch.sh create  --repo DIR --path DIR --branch NAME --base-ref REF --out DIR
#                           [--build-on BRANCH] [--remote NAME]
#   scope-branch.sh refresh --wt DIR --base-ref REF [--remote NAME]
#   scope-branch.sh record  --wt DIR --file REL --entry FILE --entry-bytes N --message MSG
#                           [--remote NAME --branch NAME]
#   scope-branch.sh merge   --wt DIR --branch PKG_BRANCH --pkg-head SHA --fork SHA
#                           [--expect-head SHA]
#
# create runs BEFORE planning, so the planner and the plan reviewer read the
# exact tree every package forks from. It creates the branch from --build-on
# (or --base-ref), merges --base-ref into it (a conflict aborts the merge,
# deletes the new worktree and branch, and fails: the owner rebases the
# build-on branch first), then records what the branch already holds beyond
# the base:
#   OUT/inherited.txt   one line per inherited non-merge commit,
#                       "<full sha> <subject>", each followed by its files
#                       indented by two spaces
#   OUT/inherited-diff.txt  git diff --name-status <base> HEAD (what the
#                       branch adds over the base, in total)
#   OUT/inherited-files.txt the same paths, one per line (the full gates take
#                       it as --allow-file: inherited work is never out of scope)
# --build-on resolves to <remote>/BRANCH when --remote is given and that ref
# exists (the workflow builds on the remote, never on a local checkout), else
# to the local branch.
# Prints DONE, then one compact JSON object: ok, worktree, branch, head,
# base_sha, inherited (count), inherited_file, diff_file, files_file, reused.
#
# refresh merges the (re-fetched) base ref into the integration worktree; a
# scope that waited for another scope's merge (must_finish_before) runs it so
# its packages fork from a base that holds the other scope's work. A conflict
# aborts the merge and fails. Prints JSON: ok, head, merged.
#
# record appends the plan-of-record entry (the file ENTRY, whose size ignoring
# trailing newlines must be N bytes) to REL in the integration worktree,
# commits only that file with MSG, and pushes the branch when --remote is
# given. The worktree is private to the scope, so no hunk staging is needed;
# a dirty tree is refused. Prints JSON: ok, head.
#
# merge is the mechanical integrator (the workflow's integrator "script"): in
# the clean integration worktree, whose HEAD must be --expect-head when given,
# it checks that PKG_BRANCH is at --pkg-head (the reviewed, gated head) and
# runs `git merge --no-ff --no-edit PKG_BRANCH`. On a conflict it aborts the
# merge, leaves HEAD where it was, and prints FAILED with conflicts: true and
# the conflicting files, so the caller can hand the merge to an agent.
# Otherwise it prints JSON: ok, merged, conflicts (false), pre_merge_sha, head,
# tree_equal (HEAD^1 is --fork and the merge tree equals the --pkg-head tree,
# so the gates that passed on the package also cover the merge).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,/^set -/{/^#/!d;/shellcheck/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; }

REPO='' WTP='' BRANCH='' BASE_REF='' OUT='' BUILD_ON='' REMOTE='' FILE='' ENTRY='' ENTRY_BYTES='' MESSAGE='' PKG_HEAD='' FORK='' EXPECT_HEAD=''
sub=${1:-}
[[ -n $sub ]] && shift
while (($#)); do
  case $1 in
    --repo) REPO=$2; shift 2 ;;
    --path | --wt) WTP=$2; shift 2 ;;
    --branch) BRANCH=$2; shift 2 ;;
    --base-ref) BASE_REF=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --build-on) BUILD_ON=$2; shift 2 ;;
    --remote) REMOTE=$2; shift 2 ;;
    --file) FILE=$2; shift 2 ;;
    --entry) ENTRY=$2; shift 2 ;;
    --entry-bytes) ENTRY_BYTES=$2; shift 2 ;;
    --message) MESSAGE=$2; shift 2 ;;
    --pkg-head) PKG_HEAD=$2; shift 2 ;;
    --fork) FORK=$2; shift 2 ;;
    --expect-head) EXPECT_HEAD=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Output contract (like vibe-run.sh wait): a first line DONE or FAILED, then
# one compact JSON line a wrapper agent copies verbatim.
fail() {
  echo FAILED
  jq_ -nc --arg why "$*" '{ok: false, reason: $why}'
  exit 1
}

# merge_base_ref <wt> -- merge BASE_REF; on conflict abort and return 1.
merge_base_ref() {
  local wt=$1
  if ! git -C "$wt" merge --no-edit "$BASE_REF" >&2; then
    CONFLICTS=$(git -C "$wt" diff --name-only --diff-filter=U | tr '\n' ' ')
    git -C "$wt" merge --abort >&2 || true
    return 1
  fi
}

case $sub in
  create)
    [[ -n $REPO && -n $WTP && -n $BRANCH && -n $BASE_REF && -n $OUT ]] || die "create needs --repo, --path, --branch, --base-ref and --out"
    mkdir -p "$OUT"
    OUT=$(cd "$OUT" && pwd)
    if [[ -n $REMOTE ]]; then git -C "$REPO" fetch -q "$REMOTE" --prune >&2 || fail "git fetch $REMOTE failed"; fi
    from=$BASE_REF
    if [[ -n $BUILD_ON ]]; then
      if [[ -n $REMOTE ]] && git -C "$REPO" rev-parse --verify -q "$REMOTE/$BUILD_ON^{commit}" >/dev/null; then
        from=$REMOTE/$BUILD_ON
      elif git -C "$REPO" rev-parse --verify -q "$BUILD_ON^{commit}" >/dev/null; then
        from=$BUILD_ON
      else
        fail "build-on branch $BUILD_ON does not exist${REMOTE:+ locally or on $REMOTE}"
      fi
    fi
    reused=false
    if ! line=$(bash "$VD_DIR/wt.sh" create --repo "$REPO" --path "$WTP" --branch "$BRANCH" --from "$from" --reuse 2>&1 | tail -n 1); then
      fail "wt.sh create failed: $line"
    fi
    case $line in
      CREATED*) ;;
      REUSED*) reused=true ;;
      *) fail "wt.sh create: $line" ;;
    esac
    WTP=$(cd "$WTP" && pwd)
    if [[ $reused == false && -n $BUILD_ON ]]; then
      CONFLICTS=''
      if ! merge_base_ref "$WTP"; then
        bash "$VD_DIR/wt.sh" remove --repo "$REPO" --path "$WTP" --delete-branch "$BRANCH" >&2 || true
        fail "merging $BASE_REF into $BUILD_ON conflicts in: $CONFLICTS; rebase $BUILD_ON on $BASE_REF first"
      fi
    fi
    base_sha=$(git -C "$WTP" rev-parse "$BASE_REF^{commit}")
    head=$(git -C "$WTP" rev-parse HEAD)
    : >"$OUT/inherited.txt"
    while IFS= read -r c; do
      [[ -z $c ]] && continue
      git -C "$WTP" log -1 --format='%H %s' "$c" >>"$OUT/inherited.txt"
      git -C "$WTP" diff-tree --no-commit-id --name-only -r "$c" | sed 's/^/  /' >>"$OUT/inherited.txt"
    done < <(git -C "$WTP" rev-list --no-merges --reverse "$base_sha..HEAD")
    git -C "$WTP" diff --name-status "$base_sha" HEAD >"$OUT/inherited-diff.txt"
    git -C "$WTP" diff --name-only "$base_sha" HEAD >"$OUT/inherited-files.txt"
    n=$(grep -cE '^[0-9a-f]{40} ' "$OUT/inherited.txt" || true)
    echo DONE
    jq_ -nc --arg wt "$WTP" --arg br "$BRANCH" --arg head "$head" --arg base "$base_sha" --argjson n "${n:-0}" \
      --arg inh "$OUT/inherited.txt" --arg diff "$OUT/inherited-diff.txt" --arg files "$OUT/inherited-files.txt" \
      --argjson reused "$reused" \
      '{ok: true, worktree: $wt, branch: $br, head: $head, base_sha: $base, inherited: $n,
        inherited_file: $inh, diff_file: $diff, files_file: $files, reused: $reused}'
    ;;
  refresh)
    [[ -n $WTP && -n $BASE_REF ]] || die "refresh needs --wt and --base-ref"
    [[ -z $(git -C "$WTP" status --porcelain=v1 --untracked-files=all) ]] || fail "integration worktree $WTP is not clean"
    if [[ -n $REMOTE ]]; then git -C "$WTP" fetch -q "$REMOTE" >&2 || fail "git fetch $REMOTE failed"; fi
    before=$(git -C "$WTP" rev-parse HEAD)
    CONFLICTS=''
    merge_base_ref "$WTP" || fail "merging $BASE_REF into the integration branch conflicts in: $CONFLICTS"
    head=$(git -C "$WTP" rev-parse HEAD)
    echo DONE
    jq_ -nc --arg head "$head" --argjson merged "$([[ $head != "$before" ]] && echo true || echo false)" '{ok: true, head: $head, merged: $merged}'
    ;;
  record)
    [[ -n $WTP && -n $FILE && -n $ENTRY && -n $ENTRY_BYTES && -n $MESSAGE ]] || die "record needs --wt, --file, --entry, --entry-bytes and --message"
    [[ -f $ENTRY ]] || fail "entry file $ENTRY does not exist"
    got=$(printf '%s' "$(cat "$ENTRY")" | wc -c)
    ((got == ENTRY_BYTES)) || fail "ENTRY_MISMATCH: $ENTRY has $got bytes (ignoring trailing newlines), expected $ENTRY_BYTES; rewrite it exactly as given"
    [[ -z $(git -C "$WTP" status --porcelain=v1 --untracked-files=all) ]] || fail "integration worktree $WTP is not clean"
    target=$WTP/$FILE
    mkdir -p "$(dirname "$target")"
    if [[ -s $target ]]; then
      # Exactly one blank line between the existing content and the entry.
      [[ $(tail -c 1 "$target" | od -An -c | tr -d ' ') == '\n' ]] || printf '\n' >>"$target"
      printf '\n' >>"$target"
    fi
    printf '%s\n' "$(cat "$ENTRY")" >>"$target"
    git -C "$WTP" add -- "$FILE"
    staged=$(git -C "$WTP" diff --cached --name-only)
    [[ $staged == "$FILE" ]] || fail "unexpected staged paths: $staged"
    git -C "$WTP" commit -q -m "$MESSAGE"
    if [[ -n $REMOTE ]]; then
      [[ -n $BRANCH ]] || die "record with --remote needs --branch"
      git -C "$WTP" push -q -u "$REMOTE" "$BRANCH" >&2 || fail "push of $BRANCH to $REMOTE failed"
    fi
    echo DONE
    jq_ -nc --arg head "$(git -C "$WTP" rev-parse HEAD)" '{ok: true, head: $head}'
    ;;
  merge)
    [[ -n $WTP && -n $BRANCH && -n $PKG_HEAD && -n $FORK ]] || die "merge needs --wt, --branch, --pkg-head and --fork"
    [[ -z $(git -C "$WTP" status --porcelain=v1 --untracked-files=all) ]] || fail "integration worktree $WTP is not clean"
    pre=$(git -C "$WTP" rev-parse HEAD)
    if [[ -n $EXPECT_HEAD && $pre != "$(git -C "$WTP" rev-parse "$EXPECT_HEAD^{commit}")" ]]; then
      fail "integration head is $pre, expected $EXPECT_HEAD"
    fi
    tip=$(git -C "$WTP" rev-parse --verify -q "refs/heads/$BRANCH^{commit}") || fail "package branch $BRANCH does not exist"
    want=$(git -C "$WTP" rev-parse "$PKG_HEAD^{commit}")
    [[ $tip == "$want" ]] || fail "package branch $BRANCH is at $tip, not at the reviewed head $want"
    if ! git -C "$WTP" merge --no-ff --no-edit "refs/heads/$BRANCH" >&2; then
      files=$(git -C "$WTP" diff --name-only --diff-filter=U | lines_to_json)
      git -C "$WTP" merge --abort >&2 || true
      now=$(git -C "$WTP" rev-parse HEAD)
      echo FAILED
      jq_ -nc --arg pre "$pre" --arg now "$now" --argjson files "$files" \
        '{ok: false, merged: false, conflicts: true, files: $files, pre_merge_sha: $pre, head: $now,
          reason: "merge conflicts; aborted, HEAD unchanged"}'
      exit 1
    fi
    head=$(git -C "$WTP" rev-parse HEAD)
    teq=false
    if [[ $(git -C "$WTP" rev-parse HEAD^1) == "$(git -C "$WTP" rev-parse "$FORK^{commit}")" &&
      $(git -C "$WTP" rev-parse 'HEAD^{tree}') == "$(git -C "$WTP" rev-parse "$want^{tree}")" ]]; then
      teq=true
    fi
    echo DONE
    jq_ -nc --arg pre "$pre" --arg head "$head" --argjson teq "$teq" \
      '{ok: true, merged: true, conflicts: false, pre_merge_sha: $pre, head: $head, tree_equal: $teq}'
    ;;
  *) usage; exit 2 ;;
esac
