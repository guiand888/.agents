#!/usr/bin/env bash
# wt.sh -- create and remove worktrees with unique names. Part of the
# vibe-delivery skill.
#
#   wt.sh create --repo DIR --path DIR --branch NAME --from REF [--reuse]
#   wt.sh create --repo DIR --path DIR --detach REF
#   wt.sh remove --repo DIR --path DIR [--delete-branch NAME]
#
# create refuses an existing path or branch (exit 3), so two lanes can never
# share a worktree. --reuse accepts an existing path only when it is already
# a worktree on exactly --branch (a fix round going back to its own tree).
# Prints the worktree's absolute path and HEAD sha on success.
# remove never touches the repo's main checkout.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,/^set -/{/^#/!d;/shellcheck/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; }

REPO='' WTP='' BRANCH='' FROM='' DETACH='' REUSE=false DELETE_BRANCH=''
sub=${1:-}
[[ -n $sub ]] && shift
while (($#)); do
  case $1 in
    --repo) REPO=$2; shift 2 ;;
    --path) WTP=$2; shift 2 ;;
    --branch) BRANCH=$2; shift 2 ;;
    --from) FROM=$2; shift 2 ;;
    --detach) DETACH=$2; shift 2 ;;
    --reuse) REUSE=true; shift ;;
    --delete-branch) DELETE_BRANCH=$2; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n $REPO && -n $WTP ]] || die "--repo and --path are required"
WTP=${WTP/#\~/$HOME}
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git repository"

case $sub in
  create)
    if [[ -e $WTP ]]; then
      if [[ $REUSE == true && -n $BRANCH ]] && [[ $(git -C "$WTP" symbolic-ref --short -q HEAD 2>/dev/null) == "$BRANCH" ]]; then
        echo "REUSED $(cd "$WTP" && pwd) $(git -C "$WTP" rev-parse HEAD)"
        exit 0
      fi
      echo "EXISTS: $WTP already exists and is not reusable for branch '${BRANCH:-}'; pick a unique path" >&2
      exit 3
    fi
    mkdir -p "$(dirname "$WTP")"
    if [[ -n $DETACH ]]; then
      git -C "$REPO" worktree add --detach "$WTP" "$DETACH" >&2
    else
      [[ -n $BRANCH && -n $FROM ]] || die "create needs --branch and --from, or --detach"
      if git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
        echo "EXISTS: branch $BRANCH already exists; pick a unique branch or pass --reuse with its worktree path" >&2
        exit 3
      fi
      git -C "$REPO" worktree add -b "$BRANCH" "$WTP" "$FROM" >&2
    fi
    echo "CREATED $(cd "$WTP" && pwd) $(git -C "$WTP" rev-parse HEAD)"
    ;;
  remove)
    main=$(git -C "$REPO" worktree list --porcelain | sed -n '1s/^worktree //p')
    abs=$(cd "$WTP" 2>/dev/null && pwd || echo "$WTP")
    [[ $abs == "$main" ]] && die "refusing to remove the main checkout $main"
    if [[ -e $WTP ]]; then
      chmod -R u+w "${WTP:?}" 2>/dev/null || true
      git -C "$REPO" worktree remove --force "$WTP" || rm_tree "$WTP"
    fi
    git -C "$REPO" worktree prune
    if [[ -n $DELETE_BRANCH ]]; then
      git -C "$REPO" branch -D "$DELETE_BRANCH"
    fi
    echo "REMOVED $WTP"
    ;;
  *) usage; exit 2 ;;
esac
