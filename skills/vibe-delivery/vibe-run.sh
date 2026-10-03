#!/usr/bin/env bash
# shellcheck disable=SC2016  # jq programs use $vars inside single quotes on purpose
# vibe-run.sh -- run one vibe session in a worktree and record, mechanically,
# whether it delivered. Part of the vibe-delivery skill.
#
#   vibe-run.sh start --wt DIR --prompt FILE --out DIR [--base REF] [--max-turns N]
#                     [--allow GLOB]... [--expect-file REL] [--expect-commits yes|no]
#                     [--lock NAME] [--timeout-min N] [--max-price USD]
#                     [--guard-ref REF]... [--mr-check-cmd CMD]
#   vibe-run.sh wait  --out DIR [--max-wait SECS]   # prints DONE | STILL_RUNNING | DIED
#   vibe-run.sh run   <start args>                  # start + wait to the end (no time cap callers only)
#   vibe-run.sh check --out DIR [--wt DIR --base REF --allow GLOB... --expect-file REL --expect-commits yes|no --mr-check-cmd CMD]
#                                                   # recompute result.json without running vibe
#
# What `start` does, detached from the caller:
#   env -u LD_LIBRARY_PATH vibe --trust --yolo --workdir WT --max-turns N -p "$(cat prompt)" < /dev/null
# with a `nix` shim first on PATH (vibe re-exports its own LD_LIBRARY_PATH to
# children; the shim drops it again before exec'ing the real nix), fresh
# GOCACHE / GOLANGCI_LINT_CACHE / TMPDIR under OUT (deleted afterwards), and,
# with --lock, under an exclusive flock so runs that share a resource (a k3d
# VM) are serialized across sessions.
#
# OUT/result.json is written when vibe exits:
#   state, vibe_exit, timed_out, head, base_sha, commits[], status_short[],
#   changed_files[], out_of_scope[], expect_file_present, log_tail, reasons[],
#   delivered
# delivered = (commits beyond base, or none if --expect-commits no) AND a clean
#             tree AND nothing outside the --allow globs AND the expect file
#             exists (when given). --base defaults to HEAD at start, so a fix
#             round must add new commits to count as delivered.
#             AND no policy violation:
#   --guard-ref REF (repeatable; e.g. origin/main and main): the ref's sha is
#     recorded at start; at the end a remote ref is re-fetched, and if the ref
#     now contains any commit this run made, the run pushed or merged into a
#     protected branch -> policy_violations.
#   --mr-check-cmd CMD: run in WT at the end with {branch} replaced by the
#     worktree's branch; it must print the number of merge requests whose
#     source is that branch. Non-zero -> policy_violations (only the merge
#     stage may open an MR). If CMD fails, policy_check_errors records it.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,/^set -/{/^#/!d;/shellcheck/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; }

WT='' PROMPT='' OUT='' BASE='' MAX_TURNS=150 EXPECT_FILE='' EXPECT_COMMITS=yes LOCK='' TIMEOUT_MIN=120 MAX_PRICE='' MAX_WAIT=540 MR_CHECK_CMD=''
ALLOW=() GUARD_REFS=() GUARD_START=()

parse() {
  while (($#)); do
    case $1 in
      --wt) WT=$2; shift 2 ;;
      --prompt) PROMPT=$2; shift 2 ;;
      --out) OUT=$2; shift 2 ;;
      --base) BASE=$2; shift 2 ;;
      --max-turns) MAX_TURNS=$2; shift 2 ;;
      --allow) ALLOW+=("$2"); shift 2 ;;
      --expect-file) EXPECT_FILE=$2; shift 2 ;;
      --expect-commits) EXPECT_COMMITS=$2; shift 2 ;;
      --lock) LOCK=$2; shift 2 ;;
      --timeout-min) TIMEOUT_MIN=$2; shift 2 ;;
      --max-price) MAX_PRICE=$2; shift 2 ;;
      --max-wait) MAX_WAIT=$2; shift 2 ;;
      --guard-ref) GUARD_REFS+=("$2"); shift 2 ;;
      --mr-check-cmd) MR_CHECK_CMD=$2; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [[ $EXPECT_COMMITS == yes || $EXPECT_COMMITS == no ]] || die "--expect-commits must be yes or no"
}

# Persist the run's parameters so the detached runner and `check` share them.
save_params() {
  {
    printf 'WT=%q\nPROMPT=%q\nBASE_SHA=%q\nMAX_TURNS=%q\nEXPECT_FILE=%q\n' "$WT" "$PROMPT" "$BASE_SHA" "$MAX_TURNS" "$EXPECT_FILE"
    printf 'EXPECT_COMMITS=%q\nLOCK=%q\nTIMEOUT_MIN=%q\nMAX_PRICE=%q\n' "$EXPECT_COMMITS" "$LOCK" "$TIMEOUT_MIN" "$MAX_PRICE"
    printf 'MR_CHECK_CMD=%q\nRUN_START=%q\n' "$MR_CHECK_CMD" "${RUN_START:-}"
    local g
    printf 'ALLOW=('
    for g in "${ALLOW[@]+"${ALLOW[@]}"}"; do printf '%q ' "$g"; done
    printf ')\nGUARD_START=('
    for g in "${GUARD_START[@]+"${GUARD_START[@]}"}"; do printf '%q ' "$g"; done
    printf ')\n'
  } >"$OUT/params.sh"
}

# remote_of <ref> -- print the remote name if ref is <remote>/<branch>.
remote_of() {
  local r
  for r in $(git -C "$WT" remote); do
    [[ $1 == "$r"/* ]] && { printf '%s\n' "$r"; return 0; }
  done
  return 1
}

# record_guards -- "ref=sha" for every --guard-ref, taken at start.
record_guards() {
  local ref sha
  for ref in "${GUARD_REFS[@]+"${GUARD_REFS[@]}"}"; do
    sha=$(git -C "$WT" rev-parse --verify -q "$ref^{commit}") || die "--guard-ref $ref does not resolve"
    GUARD_START+=("$ref=$sha")
  done
}

# check_policy -- fills the caller's policy[] and perrors[] arrays.
check_policy() {
  local entry ref old new rem c branch n
  local -a mine=()
  # "This run's commits": committed since the run started. A default branch
  # merged in during the run (MR prep does that) brings older commits that
  # the default branch legitimately contains; the date filter keeps them out.
  mapfile -t mine < <(git -C "$WT" rev-list ${RUN_START:+--since=@"$RUN_START"} "$BASE_SHA..HEAD")
  for entry in "${GUARD_START[@]+"${GUARD_START[@]}"}"; do
    ref=${entry%=*}
    old=${entry##*=}
    if rem=$(remote_of "$ref"); then
      git -C "$WT" fetch -q "$rem" "${ref#"$rem"/}" 2>/dev/null || perrors+=("could not fetch $ref to check it")
    fi
    new=$(git -C "$WT" rev-parse --verify -q "$ref^{commit}") || { perrors+=("guard ref $ref vanished"); continue; }
    [[ $new == "$old" ]] && continue
    for c in "${mine[@]+"${mine[@]}"}"; do
      if git -C "$WT" merge-base --is-ancestor "$c" "$new"; then
        policy+=("protected branch $ref moved from ${old:0:12} to ${new:0:12} and now contains commit ${c:0:12} made by this run")
        break
      fi
    done
  done
  if [[ -n $MR_CHECK_CMD ]]; then
    branch=$(git -C "$WT" symbolic-ref --short -q HEAD || true)
    if [[ -z $branch ]]; then
      :
    elif n=$(cd "$WT" && bash -c "${MR_CHECK_CMD//\{branch\}/$branch}" </dev/null 2>"$OUT/mr-check.err" | tail -n 1 | tr -dc '0-9') && [[ -n $n ]]; then
      if ((n > 0)); then policy+=("$n merge request(s) exist with source branch $branch; only the merge stage may open one"); fi
    else
      perrors+=("MR check command failed or printed no number (see $OUT/mr-check.err)")
    fi
  fi
}

# compute_result <vibe_exit> <timed_out> -- inspect the worktree, write result.json.
compute_result() {
  local vibe_exit=$1 timed_out=$2 head commits status changed oos f reasons=() expect_present=false delivered=true ncommits
  head=$(git -C "$WT" rev-parse HEAD)
  commits=$(git -C "$WT" log --format='%h %s' "$BASE_SHA..HEAD")
  ncommits=$(git -C "$WT" rev-list --count "$BASE_SHA..HEAD")
  # Porcelain status, minus the expect file (it is a hand-off, not work).
  status=$(git -C "$WT" status --porcelain=v1 --untracked-files=all | { if [[ -n $EXPECT_FILE ]]; then grep -vxF -- "?? $EXPECT_FILE" || true; else cat; fi; })
  # Committed changes since base, plus anything still uncommitted.
  changed=$( {
    git -C "$WT" diff --name-only "$BASE_SHA" HEAD
    if [[ -n $status ]]; then printf '%s\n' "$status" | cut -c4- | sed 's/^.* -> //'; fi
  } | sort -u)
  oos=
  while IFS= read -r f; do
    [[ -z $f ]] && continue
    path_allowed "$f" "${ALLOW[@]+"${ALLOW[@]}"}" || oos+="$f"$'\n'
  done <<<"$changed"

  if [[ -n $EXPECT_FILE ]]; then
    # Moved out of the worktree so the next run starts clean; a later
    # `check` finds it in OUT.
    if [[ -f $WT/$EXPECT_FILE ]]; then
      mv -f -- "$WT/$EXPECT_FILE" "$OUT/$(basename -- "$EXPECT_FILE")"
    fi
    if [[ -f $OUT/$(basename -- "$EXPECT_FILE") ]]; then
      expect_present=true
    else
      delivered=false
      reasons+=("expected file $EXPECT_FILE was not written")
    fi
  fi
  if [[ $EXPECT_COMMITS == yes && $ncommits == 0 ]]; then
    delivered=false
    reasons+=("no commits beyond base $BASE_SHA")
  fi
  if [[ $EXPECT_COMMITS == no && $ncommits != 0 ]]; then
    delivered=false
    reasons+=("$ncommits commit(s) made where none were allowed")
  fi
  if [[ -n $status ]]; then
    delivered=false
    reasons+=("working tree is not clean")
  fi
  if [[ -n $oos ]]; then
    delivered=false
    reasons+=("changes outside the allowed paths")
  fi
  local -a policy=() perrors=()
  check_policy
  if ((${#policy[@]})); then
    delivered=false
    reasons+=("POLICY VIOLATION: ${policy[*]}")
  fi
  [[ $timed_out == true ]] && reasons+=("vibe hit the ${TIMEOUT_MIN}-minute timeout")
  [[ $vibe_exit != 0 && $vibe_exit != null ]] && reasons+=("vibe exited $vibe_exit")

  local tail_txt=
  [[ -f $OUT/vibe.log ]] && tail_txt=$(tail -n 60 "$OUT/vibe.log")

  jq_ -n \
    --arg state DONE \
    --argjson vibe_exit "$vibe_exit" \
    --argjson timed_out "$timed_out" \
    --arg head "$head" \
    --arg base_sha "$BASE_SHA" \
    --argjson commits "$(printf '%s\n' "$commits" | lines_to_json)" \
    --argjson status_short "$(printf '%s\n' "$status" | lines_to_json)" \
    --argjson changed_files "$(printf '%s\n' "$changed" | lines_to_json)" \
    --argjson out_of_scope "$(printf '%s' "$oos" | lines_to_json)" \
    --argjson expect_file_present "$expect_present" \
    --arg log_tail "$tail_txt" \
    --argjson reasons "$(printf '%s\n' "${reasons[@]+"${reasons[@]}"}" | lines_to_json)" \
    --argjson delivered "$delivered" \
    --argjson policy "$(printf '%s\n' "${policy[@]+"${policy[@]}"}" | lines_to_json)" \
    --argjson perrors "$(printf '%s\n' "${perrors[@]+"${perrors[@]}"}" | lines_to_json)" \
    --arg out "$OUT" \
    '{state:$state, delivered:$delivered, reasons:$reasons, vibe_exit:$vibe_exit, timed_out:$timed_out,
      head:$head, base_sha:$base_sha, commits:$commits, status_short:$status_short,
      changed_files:$changed_files, out_of_scope:$out_of_scope,
      expect_file_present:$expect_file_present, policy_violations:$policy,
      policy_check_errors:$perrors, out_dir:$out, log_tail:$log_tail}' >"$OUT/result.json.tmp"
  mv "$OUT/result.json.tmp" "$OUT/result.json"
}

# The detached half of `start`.
runner() {
  OUT=$1
  # shellcheck source=/dev/null
  source "$OUT/params.sh"
  local real_nix vibe_bin cache rc=0 timed_out=false
  real_nix=$(command -v nix || true)
  vibe_bin=${VIBE_BIN:-$(command -v vibe || true)}
  if [[ -z $real_nix || -z $vibe_bin ]]; then
    # Still write a result, so a waiter never sees DONE without one.
    echo "vibe-run: nix ('$real_nix') or vibe ('$vibe_bin') not found on PATH; vibe was not started" >>"$OUT/vibe.log"
    compute_result 127 false
    return 0
  fi
  mkdir -p "$OUT/shim"
  printf '#!/usr/bin/env bash\nunset LD_LIBRARY_PATH\nexec %q "$@"\n' "$real_nix" >"$OUT/shim/nix"
  chmod +x "$OUT/shim/nix"
  cache=$OUT/cache
  mkdir -p "$cache/go" "$cache/lint" "$cache/tmp"

  local -a cmd=(env -u LD_LIBRARY_PATH
    "PATH=$OUT/shim:$PATH" "GOCACHE=$cache/go" "GOLANGCI_LINT_CACHE=$cache/lint" "TMPDIR=$cache/tmp"
    timeout --kill-after=60 "${TIMEOUT_MIN}m"
    "$vibe_bin" --trust --yolo --workdir "$WT" --max-turns "$MAX_TURNS" --output text)
  [[ -n $MAX_PRICE ]] && cmd+=(--max-price "$MAX_PRICE")
  cmd+=(-p "$(cat "$PROMPT")")
  if [[ -n $LOCK ]]; then
    local lockdir=${VD_LOCK_DIR:-$HOME/.cache/vibe-delivery/locks} flock_bin
    mkdir -p "$lockdir"
    resolve_tool VD_FLOCK util-linux flock
    flock_bin=$VD_FLOCK
    echo "waiting for lock $LOCK" >>"$OUT/vibe.log"
    cmd=("$flock_bin" -x "$lockdir/$LOCK.lock" "${cmd[@]}")
  fi
  date -u +'started %FT%TZ' >"$OUT/started"
  "${cmd[@]}" </dev/null >>"$OUT/vibe.log" 2>&1 || rc=$?
  [[ $rc == 124 || $rc == 137 ]] && timed_out=true
  rm_tree "$cache"
  compute_result "$rc" "$timed_out"
}

cmd_start() {
  parse "$@"
  [[ -n $WT && -n $PROMPT && -n $OUT ]] || die "start needs --wt, --prompt and --out"
  git -C "$WT" rev-parse --git-dir >/dev/null 2>&1 || die "$WT is not a git worktree"
  [[ -s $PROMPT ]] || die "prompt file $PROMPT is missing or empty"
  # vibe gets the prompt as one argv entry; Linux caps one argument at 128 KiB.
  local size
  size=$(wc -c <"$PROMPT")
  ((size <= 100000)) || die "prompt is $size bytes; keep it under 100000 (one argv entry is capped at 128 KiB). Point vibe at files instead of inlining them."
  [[ $MAX_TURNS =~ ^[0-9]+$ ]] || die "--max-turns must be a number"
  BASE_SHA=$(git -C "$WT" rev-parse --verify "${BASE:-HEAD}^{commit}") || die "cannot resolve base ${BASE:-HEAD}"
  mkdir -p "$OUT"
  if [[ -f $OUT/pid ]] && kill -0 "$(cat "$OUT/pid")" 2>/dev/null; then
    die "a run is already in progress in $OUT (pid $(cat "$OUT/pid")); wait for it instead"
  fi
  [[ -e $OUT/result.json || -e $OUT/exit ]] && die "$OUT already holds a finished run; use a new out dir per run"
  OUT=$(cd "$OUT" && pwd)
  PROMPT=$(cd "$(dirname "$PROMPT")" && pwd)/$(basename "$PROMPT")
  RUN_START=$(($(date +%s) - 2))  # small margin: --since compares whole seconds
  record_guards
  save_params
  bg_start "$OUT" "${BASH_SOURCE[0]}" _runner "$OUT"
  echo "STARTED pid $(cat "$OUT/pid") base $BASE_SHA out $OUT"
}

cmd_wait() {
  parse "$@"
  [[ -n $OUT ]] || die "wait needs --out"
  local rc=0 msg
  msg=$(bg_wait "$OUT" "$MAX_WAIT") || rc=$?
  if [[ $rc == 0 && ! -f $OUT/result.json ]]; then
    echo "DIED (runner ended without result.json, see $OUT/runner.log; recover with: vibe-run.sh check)"
    return 70
  fi
  echo "$msg"
  if [[ $rc == 0 ]]; then print_result; fi
  return "$rc"
}

cmd_check() {
  parse "$@"
  [[ -n $OUT ]] || die "check needs --out"
  if [[ -z $WT && -f $OUT/params.sh ]]; then
    # Recovering a started run whose runner died: reuse its parameters.
    # shellcheck source=/dev/null
    source "$OUT/params.sh"
    BASE=${BASE:-$BASE_SHA}
  fi
  [[ -n $WT && -n $BASE ]] || die "check needs --wt and --base (or an --out holding a started run)"
  BASE_SHA=$(git -C "$WT" rev-parse --verify "$BASE^{commit}") || die "cannot resolve base $BASE"
  mkdir -p "$OUT"
  OUT=$(cd "$OUT" && pwd)
  rm -f "$OUT/result.json"
  compute_result null false
  echo DONE
  print_result
}

# Second line after DONE: the result without the log tail, one compact line,
# so a wrapper agent can copy it verbatim.
print_result() { jq_ -c 'del(.log_tail)' "$OUT/result.json"; }

case ${1:-} in
  start) shift; cmd_start "$@" ;;
  wait) shift; cmd_wait "$@" ;;
  run)
    shift
    cmd_start "$@"
    bg_wait_forever "$OUT"
    [[ -f $OUT/result.json ]] || die "runner ended without result.json, see $OUT/runner.log"
    echo DONE
    print_result
    ;;
  check) shift; cmd_check "$@" ;;
  _runner) shift; runner "$@" ;;
  -h | --help | '') usage ;;
  *) die "unknown subcommand: $1 (start | wait | run | check)" ;;
esac
