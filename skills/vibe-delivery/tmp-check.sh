#!/usr/bin/env bash
# tmp-check.sh -- quiet disk check for long agent runs. Part of the
# vibe-delivery skill.
#
#   tmp-check.sh [--threshold PCT] [--size-mb MB] [--stale-min MIN] [DIR...]
#
# Prints nothing and exits 0 when all is well. Otherwise prints one line per
# problem and exits 1:
#   - /tmp (often a RAM-backed tmpfs shared by every session) above PCT used
#     (default 75)
#   - any direct child of each DIR (default: /tmp and $VD_JOB_DIR if set)
#     bigger than MB (default 2048) whose newest file is older than MIN
#     minutes (default 60): a likely leftover cache or worktree
set -euo pipefail

THRESHOLD=75 SIZE_MB=2048 STALE_MIN=60
DIRS=()
while (($#)); do
  case $1 in
    --threshold) THRESHOLD=$2; shift 2 ;;
    --size-mb) SIZE_MB=$2; shift 2 ;;
    --stale-min) STALE_MIN=$2; shift 2 ;;
    -h | --help) sed -n '2,/^set -/{/^#/!d;/shellcheck/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) DIRS+=("$1"); shift ;;
  esac
done
((${#DIRS[@]})) || DIRS=(/tmp ${VD_JOB_DIR:+"$VD_JOB_DIR"})

problems=0
pct=$(df --output=pcent /tmp | tail -n 1 | tr -dc '0-9')
if ((pct >= THRESHOLD)); then
  echo "/tmp is ${pct}% full (threshold ${THRESHOLD}%): $(df -h --output=used,size /tmp | tail -n 1 | xargs)"
  problems=1
fi

for root in "${DIRS[@]}"; do
  [[ -d $root ]] || continue
  while IFS= read -r -d '' d; do
    mb=$(du -sm "$d" 2>/dev/null | cut -f1 || echo 0)
    ((mb >= SIZE_MB)) || continue
    # Stale = nothing inside modified within STALE_MIN minutes.
    if [[ -z $(find "$d" -mmin "-$STALE_MIN" -print -quit 2>/dev/null) ]]; then
      echo "stale: $d is ${mb} MB, untouched for over ${STALE_MIN} min"
      problems=1
    fi
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -user "$(id -u)" -print0 2>/dev/null)
done
exit "$problems"
