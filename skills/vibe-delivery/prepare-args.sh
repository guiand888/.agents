#!/usr/bin/env bash
# shellcheck disable=SC2016  # jq programs use $vars inside single quotes on purpose
# prepare-args.sh -- build the Workflow args for workflow.js from a small
# request file. workflow.js has no filesystem access, so everything it needs
# (repo profiles, the plan schema) is resolved here. Part of the vibe-delivery skill.
#
#   prepare-args.sh REQUEST.json > args.json
#
# REQUEST.json:
#   {
#     "run_tag": "2026-10-04a",            # unique per run; names dirs and worktrees
#     "today": "2026-10-04",
#     "jobdir": "/path/to/job/dir",        # per-run files go under <jobdir>/vd/<run_tag>/ (not /tmp)
#     "max_vibe_runs": 3, "max_turns": 150,  # optional
#     "integrator": "sonnet",              # optional: "sonnet" (default) or "script" (mechanical merge, Sonnet only on conflict)
#     "scopes": [
#       { "key": "short-slug", "repo_path": "/abs/repo", "brief": "what to deliver ...",
#         "integration_branch": "fix/some-branch",
#         "build_on_branch": "optional existing branch to start from",
#         "profile_path": "optional; default <repo_path>/.claude/vibe-delivery.yaml",
#         "followups": [ optional: entries of an earlier run's result.followups to deliver in this scope ] }
#     ]
#   }
#
# For each scope: the profile is read (YAML), validated against
# profile.schema.json, ~ is expanded in worktree_root, base_ref is set to
# <remote>/<default_branch> (or <default_branch> without a remote), and the
# JSON form is saved to <jobdir>/vd/<run_tag>/profiles/<key>.json for gates.sh.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REQ=${1:?usage: prepare-args.sh REQUEST.json > args.json}
[[ -f $REQ ]] || die "$REQ does not exist"
jq_ empty "$REQ" || die "$REQ is not valid JSON"

run_tag=$(jq_ -r '.run_tag // empty' "$REQ")
today=$(jq_ -r '.today // empty' "$REQ")
jobdir=$(jq_ -r '.jobdir // empty' "$REQ")
[[ $run_tag =~ ^[A-Za-z0-9._-]+$ ]] || die "run_tag is missing or has characters other than [A-Za-z0-9._-]"
[[ -n $today ]] || die "today is required"
[[ -n $jobdir && $jobdir == /* ]] || die "jobdir must be an absolute path"
case $jobdir in /tmp | /tmp/*) echo "warning: jobdir is under /tmp, which may be a shared RAM-backed tmpfs" >&2 ;; esac
for gone in ship_partial max_fix_rounds; do
  [[ $(jq_ "has(\"$gone\")" "$REQ") == false ]] || die "$gone is no longer supported: every scope ships what was integrated, and a package gets one fix round (see SKILL.md)"
done
case $(jq_ -r '.integrator // "sonnet"' "$REQ") in sonnet | script) ;; *) die "integrator must be \"sonnet\" or \"script\"" ;; esac
dups=$(jq_ -r '[.scopes[].key] | group_by(.) | map(select(length > 1) | .[0]) | .[]' "$REQ")
[[ -z $dups ]] || die "duplicate scope keys: $dups"
(($(jq_ '.scopes | length' "$REQ") > 0)) || die "no scopes"

rundir=$jobdir/vd/$run_tag
mkdir -p "$rundir/profiles"
resolve_tool VD_CHECK_JSONSCHEMA check-jsonschema check-jsonschema

scopes=()
n=$(jq_ '.scopes | length' "$REQ")
for ((i = 0; i < n; i++)); do
  s=$(jq_ -c ".scopes[$i]" "$REQ")
  key=$(jq_ -r '.key' <<<"$s")
  repo=$(jq_ -r '.repo_path' <<<"$s")
  [[ $key =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "scope key '$key' must be a lowercase slug"
  for f in brief integration_branch repo_path; do
    [[ -n $(jq_ -r ".$f // empty" <<<"$s") ]] || die "scope $key: $f is required"
  done
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die "scope $key: $repo is not a git repository"
  ppath=$(jq_ -r '.profile_path // empty' <<<"$s")
  [[ -n $ppath ]] || ppath=$repo/.claude/vibe-delivery.yaml
  [[ -f $ppath ]] || die "scope $key: no profile at $ppath (write one, or set profile_path)"
  pjson=$rundir/profiles/$key.json
  yq_ -o=json '.' "$ppath" >"$pjson.raw"
  "$VD_CHECK_JSONSCHEMA" --schemafile "$VD_DIR/profile.schema.json" "$pjson.raw" >&2 || die "scope $key: profile $ppath does not match profile.schema.json"
  jq_ --arg home "$HOME" '
      .worktree_root |= sub("^~"; $home)
      | .no_remote = (.no_remote // false)
      | .remote = (if .no_remote then null else (.remote // "origin") end)
      | .base_ref = (if .remote then "\(.remote)/\(.default_branch)" else .default_branch end)' \
    "$pjson.raw" >"$pjson"
  rm -f "$pjson.raw"
  if [[ $(jq_ -r '.no_remote' "$pjson") == false ]]; then
    remote=$(jq_ -r '.remote' "$pjson")
    git -C "$repo" remote get-url "$remote" >/dev/null 2>&1 || die "scope $key: profile says remote '$remote' but the repo has no such remote"
  fi
  scopes+=("$(jq_ -c --slurpfile p "$pjson" --arg pj "$pjson" --arg pp "$ppath" \
    '. + {profile: $p[0], profile_json: $pj, profile_path: $pp}' <<<"$s")")
done

plan_schema=$(jq_ 'del(.["$schema"], .["$id"], .title)' "$VD_DIR/plan.schema.json")

printf '%s\n' "${scopes[@]}" | jq_ -s \
  --arg run_tag "$run_tag" --arg today "$today" --arg jobdir "$jobdir" --arg rundir "$rundir" \
  --arg skill_dir "$VD_DIR" --argjson plan_schema "$plan_schema" --slurpfile req "$REQ" '
  {
    run_tag: $run_tag, today: $today, jobdir: $jobdir, rundir: $rundir, skill_dir: $skill_dir,
    integrator: ($req[0].integrator // "sonnet"),
    max_vibe_runs: ($req[0].max_vibe_runs // 3),
    max_turns: ($req[0].max_turns // 150),
    plan_schema: $plan_schema,
    scopes: .
  }' | tee "$rundir/args.json"
echo "args written to $rundir/args.json" >&2
