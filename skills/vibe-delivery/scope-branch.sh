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
# Prints DONE, then one compact JSON object: ok, worktree, branch, head,
# base_sha, inherited (count), inherited_file, diff_file, reused.
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
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,/^set -/{/^#/!d;/shellcheck/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; }

REPO='' WTP='' BRANCH='' BASE_REF='' OUT='' BUILD_ON='' REMOTE='' FILE='' ENTRY='' ENTRY_BYTES='' MESSAGE=''
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
      if git -C "$REPO" rev-parse --verify -q "$BUILD_ON^{commit}" >/dev/null; then
        from=$BUILD_ON
      elif [[ -n $REMOTE ]] && git -C "$REPO" rev-parse --verify -q "$REMOTE/$BUILD_ON^{commit}" >/dev/null; then
        from=$REMOTE/$BUILD_ON
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
    n=$(grep -cE '^[0-9a-f]{40} ' "$OUT/inherited.txt" || true)
    echo DONE
    jq_ -nc --arg wt "$WTP" --arg br "$BRANCH" --arg head "$head" --arg base "$base_sha" --argjson n "${n:-0}" \
      --arg inh "$OUT/inherited.txt" --arg diff "$OUT/inherited-diff.txt" --argjson reused "$reused" \
      '{ok: true, worktree: $wt, branch: $br, head: $head, base_sha: $base, inherited: $n,
        inherited_file: $inh, diff_file: $diff, reused: $reused}'
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
  *) usage; exit 2 ;;
esac
