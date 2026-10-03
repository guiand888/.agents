#!/usr/bin/env bash
# shellcheck disable=SC2016  # jq programs use $vars inside single quotes on purpose
# gates.sh -- run a repo profile's gate commands for the paths a branch
# touched, and classify failures against the profile's known master failures.
# Part of the vibe-delivery skill.
#
#   gates.sh start --profile FILE --wt DIR --base REF --out DIR [--level package|full] [--allow GLOB]...
#                  [--verify-paths GLOB]... [--extra-cmd CMD]...
#   gates.sh wait  --out DIR [--max-wait SECS]   # prints DONE | STILL_RUNNING | DIED
#   gates.sh run   <start args>                  # start + wait to the end (no time cap callers, e.g. vibe)
#
# --profile is the repo profile (.claude/vibe-delivery.yaml, or its JSON form).
# --base is the ref the branch forked from; touched paths are
#   git diff --name-only $(git merge-base BASE HEAD) HEAD
# --allow (optional, repeatable) reports touched files outside those globs.
# --verify-paths GLOB (repeatable): also treat every tracked file matching GLOB
#   as touched. A verify-only package can end with no commits, which leaves
#   nothing touched and would skip every path-scoped gate; this makes the
#   profile's gates cover the work it verifies.
# --extra-cmd CMD (repeatable): an extra gate, named extra-1, extra-2, ...,
#   run at any level with no path filter; any non-zero exit fails it. The
#   workflow passes a verify-only package's own test commands here.
#
# A gate runs when its `level` matches (package, full, or both) and at least one
# touched path matches its `paths` (no `paths` = always). In a command,
# `{touched_dirs}` expands to ./dir for each existing touched directory the
# gate's paths matched, and `{touched_files}` to each existing touched file
# they matched (a gate whose placeholder expands to nothing is skipped).
# Every gate gets env -u LD_LIBRARY_PATH and fresh GOCACHE/GOLANGCI_LINT_CACHE/
# TMPDIR under OUT, deleted at the end.
#
# Classification of a failed gate: identifiers are pulled from its log with
# the gate's failure_patterns (ERE; the id is capture group 1, or groups 1..n
# joined with ':' when there are several, e.g. file:SC2086). The gate is
# `known_only` when it exited non-zero, at least one identifier was found,
# every identifier is in the profile's known_master_failures, and none of
# its fatal_patterns matched. Otherwise it is `fail`.
#
# OUT/gates.json: head, base_sha, merge_base, commits_beyond_base, dirty,
# level, touched[], out_of_scope[], gates[{name,status,exit,secs,
# failure_ids[],unknown_failure_ids[],fatal,log}], ran (gates not skipped),
# ok, clean.
#   ok    = tree clean, no out_of_scope, every gate pass|known_only|skipped
#   clean = ok and no gate is known_only
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,/^set -/{/^#/!d;/shellcheck/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; }

PROFILE='' WT='' BASE='' OUT='' LEVEL=package MAX_WAIT=540
ALLOW=() VERIFY_PATHS=() EXTRA_CMDS=()

parse() {
  while (($#)); do
    case $1 in
      --profile) PROFILE=$2; shift 2 ;;
      --wt) WT=$2; shift 2 ;;
      --base) BASE=$2; shift 2 ;;
      --out) OUT=$2; shift 2 ;;
      --level) LEVEL=$2; shift 2 ;;
      --allow) ALLOW+=("$2"); shift 2 ;;
      --verify-paths) VERIFY_PATHS+=("$2"); shift 2 ;;
      --extra-cmd) EXTRA_CMDS+=("$2"); shift 2 ;;
      --max-wait) MAX_WAIT=$2; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
}

profile_json() {
  case $1 in
    *.yaml | *.yml) yq_ -o=json '.' "$1" ;;
    *) jq_ . "$1" ;;
  esac
}

runner() {
  OUT=$1
  # shellcheck source=/dev/null
  source "$OUT/params.sh"
  local prof=$OUT/profile.json cache=$OUT/cache head merge_base ncommits dirty=false touched oos=
  head=$(git -C "$WT" rev-parse HEAD)
  merge_base=$(git -C "$WT" merge-base "$BASE_SHA" HEAD)
  ncommits=$(git -C "$WT" rev-list --count "$merge_base..HEAD")
  [[ -n $(git -C "$WT" status --porcelain=v1 --untracked-files=all) ]] && dirty=true
  touched=$(git -C "$WT" diff --name-only "$merge_base" HEAD)
  # Allowed-path check: only real changes, before the verify paths are added.
  local changed=$touched
  local f
  if ((${#ALLOW[@]})); then
    while IFS= read -r f; do
      [[ -z $f ]] && continue
      path_allowed "$f" "${ALLOW[@]}" || oos+="$f"$'\n'
    done <<<"$changed"
  fi
  if ((${#VERIFY_PATHS[@]})); then
    local extra_touched='' vf
    while IFS= read -r vf; do
      [[ -n $vf ]] && path_allowed "$vf" "${VERIFY_PATHS[@]}" && extra_touched+="$vf"$'\n'
    done < <(git -C "$WT" ls-files)
    touched=$(printf '%s\n%s' "$touched" "$extra_touched" | sed '/^$/d' | sort -u)
  fi
  # Extra command gates join the profile's gates: level both, no paths.
  local ei=0 ec
  for ec in "${EXTRA_CMDS[@]+"${EXTRA_CMDS[@]}"}"; do
    ei=$((ei + 1))
    jq_ --arg n "extra-$ei" --arg c "$ec" '.gates += [{name: $n, cmd: $c, level: "both"}]' "$prof" >"$prof.tmp" && mv "$prof.tmp" "$prof"
  done

  local known
  known=$(jq_ -r '[.known_master_failures[]?.ids[]?] | .[]' "$prof")

  : >"$OUT/gates.log"
  local results=() n i
  n=$(jq_ '.gates | length' "$prof")
  for ((i = 0; i < n; i++)); do
    local g name cmd glevel tmin paths=() fpats=() fatpats=() matched='' dirs='' files='' status exit=null secs=0 ids='' unknown='' fatal=false
    g=$(jq_ -c ".gates[$i]" "$prof")
    name=$(jq_ -r '.name' <<<"$g")
    cmd=$(jq_ -r '.cmd' <<<"$g")
    glevel=$(jq_ -r '.level // "both"' <<<"$g")
    tmin=$(jq_ -r '.timeout_min // 60' <<<"$g")
    mapfile -t paths < <(jq_ -r '.paths[]?' <<<"$g")
    mapfile -t fpats < <(jq_ -r '.failure_patterns[]?' <<<"$g")
    mapfile -t fatpats < <(jq_ -r '.fatal_patterns[]?' <<<"$g")
    local glog=$OUT/gate-$name.log

    if [[ $glevel != both && $glevel != "$LEVEL" ]]; then
      results+=("$(jq_ -n --arg name "$name" '{name:$name,status:"skipped",reason:"level"}')")
      continue
    fi
    if ((${#paths[@]})); then
      while IFS= read -r f; do
        [[ -z $f ]] && continue
        if path_allowed "$f" "${paths[@]}"; then
          matched+="$f"$'\n'
          # Deleted files can leave a directory that no longer exists.
          if [[ -d $WT/$(dirname -- "$f") ]]; then dirs+="./$(dirname -- "$f")"$'\n'; fi
          if [[ -f $WT/$f ]]; then files+="$f"$'\n'; fi
        fi
      done <<<"$touched"
      if [[ -z $matched ]]; then
        results+=("$(jq_ -n --arg name "$name" '{name:$name,status:"skipped",reason:"no touched path matches"}')")
        continue
      fi
    fi
    local ph pval
    for ph in touched_dirs touched_files; do
      [[ $cmd == *"{$ph}"* ]] || continue
      if [[ $ph == touched_dirs ]]; then
        pval=$(printf '%s' "$dirs" | sort -u | tr '\n' ' ')
      else
        pval=$(printf '%s' "$files" | sort -u | tr '\n' ' ')
      fi
      if [[ -z ${pval// /} ]]; then
        cmd=''
        break
      fi
      cmd=${cmd//"{$ph}"/$pval}
    done
    if [[ -z $cmd ]]; then
      results+=("$(jq_ -n --arg name "$name" '{name:$name,status:"skipped",reason:"placeholder expanded to nothing (touched paths no longer exist)"}')")
      continue
    fi

    mkdir -p "$cache/go" "$cache/lint" "$cache/tmp"
    printf '\n===== gate %s: %s\n' "$name" "$cmd" >>"$OUT/gates.log"
    local t0 t1 rc=0
    t0=$(date +%s)
    (cd "$WT" && env -u LD_LIBRARY_PATH GOCACHE="$cache/go" GOLANGCI_LINT_CACHE="$cache/lint" TMPDIR="$cache/tmp" \
      timeout --kill-after=60 "${tmin}m" bash -c "$cmd") </dev/null >"$glog" 2>&1 || rc=$?
    t1=$(date +%s)
    secs=$((t1 - t0))
    exit=$rc
    cat "$glog" >>"$OUT/gates.log"
    printf '===== gate %s exit %s after %ss\n' "$name" "$rc" "$secs" >>"$OUT/gates.log"

    if [[ $rc == 0 ]]; then
      status=pass
    elif [[ $rc == 124 || $rc == 137 ]]; then
      status=timeout
    else
      local p line
      for p in "${fatpats[@]+"${fatpats[@]}"}"; do
        grep -qE -- "$p" "$glog" && fatal=true
      done
      for p in "${fpats[@]+"${fpats[@]}"}"; do
        while IFS= read -r line; do
          if [[ $line =~ $p ]]; then
            local id=${BASH_REMATCH[1]:-$line} gi
            for ((gi = 2; gi < ${#BASH_REMATCH[@]}; gi++)); do id+=":${BASH_REMATCH[gi]}"; done
            ids+="$id"$'\n'
          fi
        done < <(grep -E -- "$p" "$glog" || true)
      done
      ids=$(printf '%s' "$ids" | sort -u)
      unknown=$(comm -23 <(printf '%s\n' "$ids" | sed '/^$/d' | sort -u) <(printf '%s\n' "$known" | sed '/^$/d' | sort -u))
      if [[ $fatal == false && -n $ids && -z $unknown ]]; then
        status=known_only
      else
        status=fail
      fi
    fi
    results+=("$(jq_ -n --arg name "$name" --arg status "$status" --argjson exit "$exit" --argjson secs "$secs" \
      --arg cmd "$cmd" --arg log "$glog" --argjson fatal "$fatal" \
      --argjson ids "$(printf '%s\n' "$ids" | lines_to_json)" \
      --argjson unknown "$(printf '%s\n' "$unknown" | lines_to_json)" \
      '{name:$name,status:$status,exit:$exit,secs:$secs,cmd:$cmd,failure_ids:$ids,unknown_failure_ids:$unknown,fatal:$fatal,log:$log}')")
  done
  rm_tree "$cache"

  printf '%s\n' "${results[@]+"${results[@]}"}" | jq_ -s \
    --arg head "$head" --arg base_sha "$BASE_SHA" --arg merge_base "$merge_base" \
    --argjson commits "$ncommits" --argjson dirty "$dirty" --arg level "$LEVEL" \
    --argjson touched "$(printf '%s\n' "$touched" | lines_to_json)" \
    --argjson oos "$(printf '%s' "$oos" | lines_to_json)" \
    --arg log "$OUT/gates.log" \
    '. as $g
     | ($g | all(.status == "pass" or .status == "known_only" or .status == "skipped")) as $gates_ok
     | {head:$head, base_sha:$base_sha, merge_base:$merge_base, commits_beyond_base:$commits,
        dirty:$dirty, level:$level, touched:$touched, out_of_scope:$oos, gates:$g, log:$log,
        ran: ($g | map(select(.status != "skipped")) | length),
        ok: ($gates_ok and ($dirty | not) and ($oos | length == 0)),
        clean: ($gates_ok and ($dirty | not) and ($oos | length == 0) and ($g | all(.status != "known_only")))}' \
    >"$OUT/gates.json.tmp"
  mv "$OUT/gates.json.tmp" "$OUT/gates.json"
}

cmd_start() {
  parse "$@"
  [[ -n $PROFILE && -n $WT && -n $BASE && -n $OUT ]] || die "start needs --profile, --wt, --base and --out"
  [[ $LEVEL == package || $LEVEL == full ]] || die "--level must be package or full"
  git -C "$WT" rev-parse --git-dir >/dev/null 2>&1 || die "$WT is not a git worktree"
  mkdir -p "$OUT"
  [[ -e $OUT/gates.json ]] && die "$OUT already has a gates.json; use a new out dir per run"
  OUT=$(cd "$OUT" && pwd)
  WT=$(cd "$WT" && pwd)
  profile_json "$PROFILE" >"$OUT/profile.json" || die "cannot read profile $PROFILE"
  BASE_SHA=$(git -C "$WT" rev-parse --verify "$BASE^{commit}") || die "cannot resolve base $BASE"
  {
    printf 'WT=%q\nBASE_SHA=%q\nLEVEL=%q\n' "$WT" "$BASE_SHA" "$LEVEL"
    local g arr
    for arr in ALLOW VERIFY_PATHS EXTRA_CMDS; do
      local -n ref=$arr
      printf '%s=(' "$arr"
      for g in "${ref[@]+"${ref[@]}"}"; do printf '%q ' "$g"; done
      printf ')\n'
      unset -n ref
    done
  } >"$OUT/params.sh"
  bg_start "$OUT" "${BASH_SOURCE[0]}" _runner "$OUT"
  echo "STARTED pid $(cat "$OUT/pid") out $OUT"
}

# Second line after DONE: compact summary a wrapper agent copies verbatim.
print_summary() {
  jq_ -c '{ok, clean, ran, dirty, head, merge_base, commits_beyond_base, out_of_scope, log,
    gates: [.gates[] | {name, status, exit, failure_ids, unknown_failure_ids, log}]}' "$OUT/gates.json"
}

cmd_wait() {
  parse "$@"
  [[ -n $OUT ]] || die "wait needs --out"
  local rc=0 msg
  msg=$(bg_wait "$OUT" "$MAX_WAIT") || rc=$?
  if [[ $rc == 0 && ! -f $OUT/gates.json ]]; then
    echo "DIED (runner ended without gates.json, see $OUT/runner.log)"
    return 70
  fi
  echo "$msg"
  if [[ $rc == 0 ]]; then print_summary; fi
  return "$rc"
}

case ${1:-} in
  start) shift; cmd_start "$@" ;;
  wait) shift; cmd_wait "$@" ;;
  run)
    shift
    cmd_start "$@"
    bg_wait_forever "$OUT"
    [[ -f $OUT/gates.json ]] || die "runner ended without gates.json, see $OUT/runner.log"
    echo DONE
    print_summary
    ;;
  _runner) shift; runner "$@" ;;
  -h | --help | '') usage ;;
  *) die "unknown subcommand: $1 (start | wait | run)" ;;
esac
