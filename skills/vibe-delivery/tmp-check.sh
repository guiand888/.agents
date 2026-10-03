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
#   - a leftover: any direct child directory of each DIR (default: /tmp and
#     $VD_JOB_DIR if set), whatever its name, owned by you, that is
#       bigger than MB (default 100),
#       has nothing inside modified within MIN minutes (default 60), and
#       is not in use: no process of yours has a file open in it, has it as
#       its working directory, or maps a file from it (what `lsof +D` would
#       report, read from /proc in one pass).
#     Typical leftovers: finished nix-shell.* build dirs, per-run Go caches.
#     A last line sums them up.
set -euo pipefail

THRESHOLD=75 SIZE_MB=100 STALE_MIN=60
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

# Every path a process of ours holds open, has as cwd, or maps. Collected
# once; a candidate dir is in use if any of these paths lies inside it.
in_use=''
collect_in_use() {
  local p
  for p in /proc/[0-9]*; do
    [[ -O $p ]] || continue
    {
      readlink "$p/cwd" 2>/dev/null || true
      find "$p/fd" -mindepth 1 -maxdepth 1 -printf '%l\n' 2>/dev/null || true
      awk 'NF >= 6 && $6 ~ /^\// {print $6}' "$p/maps" 2>/dev/null || true
    }
  done | sort -u
}

stale_total=0
for root in "${DIRS[@]}"; do
  [[ -d $root ]] || continue
  while IFS= read -r -d '' d; do
    mb=$(du -sm "$d" 2>/dev/null | cut -f1 || echo 0)
    ((${mb:-0} >= SIZE_MB)) || continue
    # Stale = nothing inside modified within STALE_MIN minutes.
    [[ -z $(find "$d" -mmin "-$STALE_MIN" -print -quit 2>/dev/null) ]] || continue
    [[ -n $in_use ]] || in_use=$(collect_in_use)
    if grep -qF -- "$d/" <<<"$in_use" || grep -qxF -- "$d" <<<"$in_use"; then
      continue
    fi
    echo "leftover: $d is ${mb} MB, untouched for over ${STALE_MIN} min, nothing open in it"
    stale_total=$((stale_total + mb))
    problems=1
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -user "$(id -u)" -print0 2>/dev/null)
done
((stale_total == 0)) || echo "leftovers total ${stale_total} MB (remove with chmod -R u+w DIR && rm -rf DIR once you know whose they are)"
exit "$problems"
