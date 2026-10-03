#!/usr/bin/env bash
# run.sh -- every static check and offline test of the vibe-delivery skill,
# with tools from nixpkgs. Launches no workflow and no real vibe.
#
#   bash tests/run.sh [PROFILE.yaml]...   (extra profiles are validated too)
set -uo pipefail
SK=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bad=0
step() { printf '\n### %s\n' "$*"; }
run() { "$@" || { echo "FAILED: $*"; bad=$((bad + 1)); }; }
nixr() { local pkg=$1; shift; env -u LD_LIBRARY_PATH nix shell "nixpkgs#$pkg" -c "$@"; }

step 'bash -n'
for f in "$SK"/*.sh "$SK"/tests/*.sh "$SK"/tests/fakevibe; do run bash -n "$f"; done
step shellcheck
run nixr shellcheck shellcheck -x -P "$SK" "$SK"/*.sh "$SK"/tests/*.sh "$SK"/tests/fakevibe
step 'node --check (workflow.js wrapped as the async body the Workflow runner gives it)'
W=$(mktemp -d "${TMPDIR:-/tmp}/vd-check.XXXXXX")
{ echo 'async function __wf(args, agent, pipeline, parallel, phase, log, budget) {'; sed 's/^export const meta/const meta/' "$SK/workflow.js"; echo '}'; } >"$W/wf.js"
run nixr nodejs node --check "$W/wf.js"
run nixr nodejs node --check "$SK/tests/harness.mjs"
rm -rf "$W"
step 'schemas against the JSON Schema metaschema'
run nixr check-jsonschema check-jsonschema --check-metaschema "$SK/plan.schema.json" "$SK/profile.schema.json"
step 'profiles'
P=$(mktemp -d "${TMPDIR:-/tmp}/vd-prof.XXXXXX")
sed -n "/^cat >prof.yaml <<'P'$/,/^P$/{/^cat\|^P$/d;p}" "$SK/tests/dry-run.sh" >"$P/test-profile.yaml"
for y in "$P/test-profile.yaml" "$@"; do
  nixr yq-go yq -o=json '.' "$y" >"$P/p.json" && run nixr check-jsonschema check-jsonschema --schemafile "$SK/profile.schema.json" "$P/p.json" && echo "valid: $y"
done
rm -rf "$P"
step 'mock harness (workflow.js with stubbed agents)'
run nixr nodejs node "$SK/tests/harness.mjs"
step 'dry runs (real scripts, fake vibe)'
D=$(mktemp -d "${TMPDIR:-/tmp}/vd-dry.XXXXXX")
run bash "$SK/tests/dry-run.sh" "$D"
rm -rf "$D"

echo
if ((bad == 0)); then echo 'ALL CHECKS PASSED'; else echo "$bad CHECK(S) FAILED"; exit 1; fi
