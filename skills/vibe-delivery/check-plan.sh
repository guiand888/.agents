#!/usr/bin/env bash
# check-plan.sh -- validate a planner's plan.json. Part of the vibe-delivery skill.
#
#   check-plan.sh PLAN.json [SCHEMA.json]
#
# 1. JSON Schema validation against plan.schema.json (check-jsonschema, from nixpkgs).
# 2. Structural checks the schema cannot express:
#    - package ids unique within the plan
#    - every package's repo_path equals the plan's (no cross-repo packages)
#    - file scopes are repo-relative (no absolute paths, no ..)
#    - depends_on names only packages in strictly earlier waves
#    - packages in the same wave have disjoint file scopes (equal paths, or
#      one being a directory prefix of the other, count as overlap)
# Prints OK, or one error per line; exit 0 / 1.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PLAN=${1:?usage: check-plan.sh PLAN.json [SCHEMA.json]}
SCHEMA=${2:-$VD_DIR/plan.schema.json}
[[ -f $PLAN ]] || { echo "plan file $PLAN does not exist"; exit 1; }
jq_ empty "$PLAN" 2>/dev/null || { echo "plan file $PLAN is not valid JSON"; exit 1; }

resolve_tool VD_CHECK_JSONSCHEMA check-jsonschema check-jsonschema
errors=
if ! out=$("$VD_CHECK_JSONSCHEMA" --schemafile "$SCHEMA" "$PLAN" 2>&1); then
  errors+="$out"$'\n'
fi

# shellcheck disable=SC2016  # jq program, not shell
structural=$(jq_ -r '
  def norm: sub("/+$"; "") | sub("\\*.*$"; "") | sub("/+$"; "");
  def overlaps($a; $b): ($a | norm) as $x | ($b | norm) as $y
    | ($x == $y) or ($x == "") or ($y == "") or ($x | startswith($y + "/")) or ($y | startswith($x + "/"));
  .repo_path as $repo
  | [.waves[]? | .wave as $w | .packages[]? | {w: $w, id, repo: .repo_path, files: (.files // []), deps: (.depends_on // [])}] as $pk
  | ($pk | group_by(.id) | map(select(length > 1) | "duplicate package id: \(.[0].id)")[]),
    ($pk[] | select(.repo != $repo)
      | "\(.id): targets repo \(.repo) but the scope is \($repo); work for another repository belongs to another scope"),
    ($pk[] | . as $p | .files[]
      | select(startswith("/") or startswith("~") or . == ".." or startswith("../") or contains("/../") or endswith("/.."))
      | "\($p.id): file scope \(.) must be a path inside the repository"),
    ($pk[] | . as $p | .deps[] | . as $d
      | ([$pk[] | select(.id == $d)] | first) as $t
      | if $t == null then "\($p.id): depends_on unknown package \($d)"
        elif $t.w >= $p.w then "\($p.id) (wave \($p.w)): depends_on \($d) which is in wave \($t.w), not an earlier one"
        else empty end),
    ($pk | group_by(.w)[] | . as $wave
      | [range(0; length) as $i | range($i + 1; length) as $j | [$wave[$i], $wave[$j]]][]
      | .[0] as $a | .[1] as $b
      | [$a.files[] as $fa | $b.files[] as $fb | select(overlaps($fa; $fb)) | "\($fa) ~ \($fb)"]
      | select(length > 0)
      | "wave \($a.w): packages \($a.id) and \($b.id) overlap: \(join(", "))")
' "$PLAN" 2>&1) || structural="structural check failed: $structural"
[[ -n $structural ]] && errors+="$structural"$'\n'

if [[ -n ${errors//[$'\n' ]/} ]]; then
  printf '%s' "$errors"
  exit 1
fi
echo OK
