# shellcheck shell=bash
# Shared helpers for the vibe-delivery scripts. Sourced, never executed.
#
# Every script that sources this file drops LD_LIBRARY_PATH first: vibe
# exports its bundled LD_LIBRARY_PATH to every child, and a system `nix`
# started under it dies on a GLIBCXX mismatch. Scripts vibe itself may call
# (gates.sh, check-plan.sh, wt.sh) are therefore safe to call from vibe.

unset LD_LIBRARY_PATH

# Under set -e a failing command exits silently; say where, on stderr
# (runner.log for detached jobs).
set -E
trap 'echo "vibe-delivery: ${BASH_SOURCE[0]##*/}:$LINENO: command failed (exit $?): $BASH_COMMAND" >&2' ERR

VD_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export VD_DIR

die() {
  printf 'vibe-delivery: %s\n' "$*" >&2
  exit 2
}

# resolve_tool <VAR> <nixpkgs-attr> <binary> -- store a tool's absolute path
# in VAR (exported, so child scripts inherit it). Tools come from nixpkgs;
# VD_PREFER_PATH=1 uses a binary already on PATH instead.
resolve_tool() {
  local var=$1 attr=$2 bin=$3 p=
  if [[ -n ${!var:-} && -x ${!var} ]]; then return 0; fi
  if [[ ${VD_PREFER_PATH:-0} == 1 ]]; then p=$(command -v "$bin" 2>/dev/null || true); fi
  if [[ -z $p ]]; then
    p=$(nix shell "nixpkgs#$attr" -c bash -c "command -v $bin" 2>/dev/null) || die "cannot resolve $bin from nixpkgs#$attr"
  fi
  [[ -x $p ]] || die "resolved $bin to '$p', which is not executable"
  printf -v "$var" '%s' "$p"
  export "${var?}"
}

resolve_tool VD_JQ jq jq
jq_() { "$VD_JQ" "$@"; }
yq_() {
  resolve_tool VD_YQ yq-go yq
  "$VD_YQ" "$@"
}

# rm_tree <dir> -- delete a cache/worktree dir. Go marks its cache read-only,
# so chmod first. Guarded against empty or root paths.
rm_tree() {
  local d=${1:?rm_tree needs a path}
  [[ $d == / || $d == "$HOME" || $d == "$HOME/" ]] && die "refusing to delete $d"
  [[ -e $d ]] || return 0
  chmod -R u+w "${d:?}" 2>/dev/null || true
  rm -rf "${d:?}"
}

# lines_to_json -- stdin lines -> JSON array of strings (empty lines dropped).
lines_to_json() { jq_ -R . | jq_ -s 'map(select(length > 0))'; }

# path_allowed <file> <glob>... -- 0 if file matches one allow glob.
# Glob rules: bash patterns where * also spans '/'; an entry ending in '/'
# is a directory prefix; a bare directory name also covers its contents.
path_allowed() {
  local f=$1 g
  shift
  for g in "$@"; do
    [[ -z $g ]] && continue
    if [[ $g == */ ]]; then
      [[ $f == "$g"* ]] && return 0
    else
      # shellcheck disable=SC2053  # $g is intentionally a pattern
      [[ $f == $g || $f == "$g"/* ]] && return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Detached jobs. Agents have a ~10-minute cap per shell call, and vibe or a
# full gate run takes longer, so long work runs detached and the caller waits
# in bounded chunks. Layout of a job dir: pid, exit (written last), runner.log.
# ---------------------------------------------------------------------------

# bg_start <dir> <cmd>... -- run cmd in a new session, stdin from /dev/null.
bg_start() {
  local dir=$1
  shift
  mkdir -p "$dir"
  if [[ -f $dir/pid ]] && kill -0 "$(cat "$dir/pid")" 2>/dev/null; then
    die "a run is already in progress in $dir (pid $(cat "$dir/pid")); wait for it instead"
  fi
  [[ -e $dir/exit ]] && die "$dir already holds a finished run; use a new out dir"
  # shellcheck disable=SC2016  # expanded by the inner bash
  setsid bash -c '"$@"; rc=$?; echo "$rc" > "$0/exit.tmp"; mv "$0/exit.tmp" "$0/exit"' "$dir" "$@" \
    </dev/null >>"$dir/runner.log" 2>&1 &
  echo $! >"$dir/pid"
}

# bg_wait <dir> [max_secs] -- block until the job ends or max_secs pass.
# Prints exactly one of DONE / STILL_RUNNING / DIED and returns 0 / 75 / 70.
bg_wait() {
  local dir=$1 max=${2:-540} pid
  [[ -f $dir/pid ]] || die "no job was started in $dir"
  pid=$(cat "$dir/pid")
  if [[ ! -e $dir/exit ]] && kill -0 "$pid" 2>/dev/null; then
    timeout "$max" tail --pid="$pid" -f /dev/null || true
  fi
  if [[ -e $dir/exit ]]; then
    echo DONE
    return 0
  fi
  if kill -0 "$pid" 2>/dev/null; then
    echo STILL_RUNNING
    return 75
  fi
  echo "DIED (pid $pid is gone and $dir/exit was never written)"
  return 70
}

# bg_wait_forever <dir> -- for callers without a per-call time cap.
bg_wait_forever() {
  local rc
  while :; do
    bg_wait "$1" 540 >/dev/null && rc=0 || rc=$?
    [[ $rc == 75 ]] || return "$rc"
  done
}
