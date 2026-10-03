---
name: vibe-delivery
description: Multi-scope code delivery where the `vibe` CLI plans, writes and fixes the code in git worktrees, Claude agents review each package once and merge, small issues ship as recorded follow-ups instead of extra rounds, and delivery and gate results are decided by scripts rather than by agent reports. Use when the user asks to deliver one or more scopes (bug fixes, features, close-outs) with vibe, runs /vibe-delivery, or asks for a "vibe delivery" or "vibe workflow". Needs a per-repo profile at .claude/vibe-delivery.yaml.
---

# vibe-delivery

Deliver several scopes in parallel. `vibe` writes plans and code; Claude agents check them; small scripts decide the facts that agents used to report (what the integration branch already holds, did vibe commit, did it stay in scope, did the gates pass, did anyone open an MR early). Everything specific to a repository, its hosts and its forge lives in that repo's profile, `.claude/vibe-delivery.yaml`. This skill holds none of it.

vibe does the heavy lifting; Claude work is kept from doubling it. No Claude agent drives or re-plans a package once the plan is reviewed. Each package is reviewed once (Sonnet; Fable instead for a package the plan marked high-risk). The reviewer classifies every finding as blocking or deferrable. Packages ship first and get corrected afterwards: a package with no blocking finding ships at once and its deferrable findings become follow-ups in the repo's bookkeeping. Blocking findings get one vibe fix round and a narrow re-check of just those items. A package whose blocking items stay open is filed as a follow-up with its branch and evidence, and the rest of the scope still ships.

Skill dir: `~/.claude/skills/vibe-delivery/` (written `$SK` below).

## Roles

| Role | Who | Notes |
|---|---|---|
| Orchestrator | you (Opus) | pre-flight, launch, monitoring, post-run |
| Base, setup | Haiku wrapper + `scope-branch.sh` | base: creates the integration branch before planning and lists its inherited commits; setup: commits the plan-of-record entry and pushes |
| Planner | vibe through a Haiku wrapper | writes `.vd-plan.json` in a read-only worktree at the integration head; `check-plan.sh` validates it |
| Plan review | Fable | the only ground-truthing of package specs: approve, correct, or one re-plan; sets `kind` and `high_risk` |
| Collision check | Fable | only with more than one scope |
| Code and fixes | vibe through a Haiku wrapper | the wrapper creates the package worktree and runs `vibe-run.sh` with a prompt the workflow builds from the reviewed plan (or, for the fix round, from the blocking findings only); no Claude agent writes or checks it |
| Gates | Haiku wrapper | `gates.sh` |
| Reviewer | Sonnet (Fable for `high_risk`) | the package's one review: reads the diff, the gate log and, for verify-only packages, the verification note; never re-runs builds. Classifies each finding blocking or deferrable; verdict ship, fix or reject |
| Re-check | Sonnet | only after a fix round: checks only the blocking items against the fix diff and the new gate log; no new review |
| Integrator | Sonnet (default) or script | serial `merge --no-ff` into the integration branch. With `"integrator": "script"`, `scope-branch.sh merge` merges mechanically and Sonnet runs only on a conflict. Gates after the merge unless the merge tree provably equals the gated package tree; merge undone if they fail |
| MR prep | vibe through the Haiku wrapper | merges the default branch, ticks bookkeeping (own hunks only), files every follow-up in the profile's `followup_file`, pushes the integration branch; never opens an MR. One more vibe run only if the full gates then fail |
| MR merge | Sonnet | the only stage that opens and merges an MR, after the mechanical merge gate; always ships what was integrated |

## Stages

BASE (`scope-branch.sh create`: the integration branch from `build_on_branch` or the base ref, the base ref merged in, inherited commits listed) -> PLAN (vibe, read-only worktree detached at the integration head) -> PLAN REVIEW (Fable) -> COLLISION (Fable, `must_finish_before`) -> [REFRESH: a scope that waited for another merges the base ref again] -> SETUP (`scope-branch.sh record`: plan-of-record entry, push) -> WAVES (packages of a wave in parallel, all forked from the same integration head; a wave starts only after the previous wave is integrated) -> INTEGRATE (Sonnet, or a script with Sonnet on conflict) -> MR PREP (vibe, then the full gates once) -> MR MERGE (Sonnet).

Inherited files never count as out of scope: package runs diff against their fork (which holds them), and the full gates at MR prep, which diff the whole branch against the base ref, get the inherited file list as `--allow-file`. With `--remote`, the build-on branch is taken from the remote, not the local checkout.

The branch exists before planning so that the planner and the plan reviewer read the exact tree every package forks from, and are told, from git, which commits it already holds (each with its files). They plan verification and bookkeeping around that work, never a package that recreates it. (The first live trial planned "re-apply commit X" for work SETUP had already merged; the package had nothing to commit.) The alternative, a precomputed summary of what the build-on branch adds, would leave the planner reading a tree without that work.

Per package: vibe (up to `max_vibe_runs` runs: the first, then generic continuations) -> gates -> the one review, then by severity:

- **no blocking finding**: ship (integrate) at once; deferrable findings become follow-ups. No fix round.
- **blocking findings** (or gates red beyond the known master failures, which the workflow adds as a blocking item itself): one fix round straight to vibe whose prompt holds the blocking items only -> gates -> one narrow Sonnet re-check of those items against the fix diff. All resolved and gates ok: ship. Anything open: `blocking_open`, not integrated, filed as a follow-up with its branch, evidence and open items; the rest of the scope still ships.
- **reject** (the approach is wrong): `rejected`, filed with the reviewer's reason.
- **no review** (the reviewer died): `review_failed`, filed; never shipped on silence.

Blocking means a correctness, concurrency or data-integrity bug, a security problem, a false or fabricated claim in code comments, docs or bookkeeping ("proof X ran" when it did not), or red gates. Everything else (wording, line-number citations, style, polish, follow-on improvements) is deferrable.

Package kinds:

- `change` (default): delivered only with new commits.
- `verify_only`: the work is already on the branch (inherited) or needs no change. It may end with zero commits; it is delivered by a verification note vibe writes (`.vd-verify.md`, collected into the run dir) and approved only if its gates pass, where its own `tests` run as extra gates and its `files` count as touched, so the gates cannot pass on nothing. A zero-commit verify-only package is integrated without a merge.

Review: the outcome is the workflow's, from the findings and the gates: the verdict only matters for reject. A high-risk package (`high_risk: true`, set by plan review for concurrency, security or data-integrity work) is reviewed by Fable instead of Sonnet, so it still gets exactly one review. There is no adjudication.

Final states: `integrated`, `failed`, `blocked` (vibe reported the spec's premise false; no continuation), `rejected`, `blocking_open`, `review_failed`, `policy_violation`, `blocked_dependency` (a `depends_on` package was not integrated, so it never ran), `integration_failed`, `integration_gates_failed` (the merge was undone), `blocked_integration` (undoing a failed merge did not work, so the integration branch is unusable and the scope stops for the owner). Every package that is not `integrated` is listed in the result's `dropped` and filed in `followups`; none is dropped silently. A scope whose base merge conflicts ends `plan_failed` before planning.

Follow-ups are mandatory and visible: every deferrable finding and every package that was not integrated becomes one dated line naming the scope, package, branch and finding, tagged `[vd:<scope>/<package>]`. MR prep writes them into the profile's `bookkeeping.followup_file` and the MR description's "Deferred / follow-ups" section. The MR merge stage makes sure that section holds them and greps the branch for every tag (`followups_recorded`; a missing one is reported, never a stop). The result returns them as structured `followups[]`.

MR MERGE always ships what was integrated. It stops with `needs_owner_decision`, and opens no MR, only when one of these holds:

- a policy violation in the scope: a package or MR prep pushed to the default branch or opened an MR, or the integration branch holds files outside every shipped package, the bookkeeping and the inherited work (full gates' `out_of_scope`); also when MR prep's policy check could not run, since MR prep is the stage that pushes;
- the full gates are not ok apart from the profile's `known_master_failures` (or did not run because MR prep did not deliver);
- the gated head differs from the head MR prep ended on;
- the profile has no remote, or lacks `merge.open_command`/`merge.command`;
- no package was integrated (nothing to ship; everything is in `followups`).

The scope also stops before MR prep when the integration branch is unusable (`blocked_integration`).

## Mechanical checks (why they exist)

- **Delivered** is computed by `vibe-run.sh`: the commit expectation (change: new commits; verify-only: any number, plus the verification note), a clean tree, no file outside the package's `files`, no blocked note, and no policy violation. No agent's word counts. (A v1 driver reported "failed" while vibe went on to commit; another package was dropped although its work existed.)
- **Base**: every vibe run passes `--base <package fork sha>`, which the workflow knows (it forks each wave from the integration head it tracked) instead of taking it from an agent. `--base` is required; it no longer defaults to HEAD at start. The scope check is `git diff --name-only <base> HEAD` plus every path `git status` reports, matched against `files`: work already on the base (inherited commits, the plan entry, earlier packages) is in both trees and never counts; only changing such a file, including reverting it, is out of scope. "New commits" are counted from `--commits-since`: the fork for a package's first runs, the reviewed head for a fix round, so a fix round must add commits of its own.
- **Blocked**: vibe writes `.vd-blocked.md` when the spec's premise is false (the work is already there, a named file does not exist, it cannot be done within `files`). The package stops as `blocked` with the note, instead of vibe inventing work or a continuation retrying it.
- **Prompt fidelity**: the workflow builds every vibe prompt and passes its byte size; `vibe-run.sh start` refuses a prompt file of another size (`PROMPT_MISMATCH`), and the wrapper is re-run.
- **Policy guards**: after each run, `vibe-run.sh` re-fetches the default branch and fails the run if it now contains a commit the run made, and runs the profile's `mr_exists_command` to fail it if an MR exists for its branch. (v1 drivers opened and self-merged MRs before review, one with a fabricated claim.)
- **Waiting**: vibe and the gates run detached; wrappers wait with `wait --max-wait 540` (under the 10-minute shell cap), so no agent returns while vibe is still working. If a wrapper dies or garbles the copy, the workflow sends a collector that only waits on the same out dir; it never starts a second run.
- **Environment**: vibe leaks its bundled `LD_LIBRARY_PATH`, which breaks the system `nix`. `vibe-run.sh` starts vibe under `env -u LD_LIBRARY_PATH` with a `nix` shim first on PATH, stdin from `/dev/null` (vibe `-p` hangs on an open stdin), and fresh `GOCACHE`/`GOLANGCI_LINT_CACHE`/`TMPDIR` under the run dir, deleted afterwards. Prompts also forbid text-only turns, which end a `-p` session.
- **Shared resources**: packages with `needs_vm` hold an exclusive flock (`~/.cache/vibe-delivery/locks/<vm.lock>.lock`) for their whole vibe run, which serializes VM use across scopes, repos and sessions. Worktree paths are unique (`wt.sh` refuses collisions). Shared bookkeeping files are staged hunk by hunk.
- **Plans**: `check-plan.sh` rejects duplicate ids, `depends_on` that is not in an earlier wave, overlapping same-wave file scopes, file scopes outside the repo, packages whose `repo_path` is not the scope's repo, verify-only packages without test commands, and (with `--inherited`) change packages whose spec asks to cherry-pick, re-apply or recreate an inherited commit.
- **Verification is not repeated**: the plan review is the only ground-truthing of specs; each package is reviewed once, and a fix round gets a re-check of its blocking items only, not a second review; the gates are the only builds (reviewer and re-checker read their logs); integration skips the gate re-run only when `HEAD^1` is the package's fork and the merge tree equals the gated package tree, both checked with git (`scope-branch.sh merge` reports this as `tree_equal`); MR prep does not run the full gates itself, the workflow runs them once.

## 1. Pre-flight

Run these before launching. Stop and tell the owner when one fails.

0. **Authorization.** vibe runs with `--trust --yolo` (permission-bypassing). Get the owner's explicit go-ahead for this delivery before launching.
1. **Profiles.** Each scope's repo has `.claude/vibe-delivery.yaml` that validates against `$SK/profile.schema.json` (`prepare-args.sh` checks this). If a repo has none, write one with the owner; see "Profile" below.
2. **/tmp and leftovers.** `bash $SK/tmp-check.sh` prints nothing when fine. Otherwise clear finished runs' leftovers first; /tmp is often a RAM-backed tmpfs shared by every session.
3. **Remote.** For each repo: `git -C <repo> remote get-url <remote>` and `git -C <repo> fetch <remote>`. A repo without a remote must say `no_remote: true`; its scope then ends ready for a local merge by the owner.
4. **Local lag.** `git -C <repo> rev-list --count <default>..<remote>/<default>`. Report it. The workflow always builds on `<remote>/<default>`, never on the local checkout, and never touches the main checkout's working tree.
5. **VM.** If any scope may need the profile's VM: confirm nobody holds it (`flock -n ~/.cache/vibe-delivery/locks/<vm.lock>.lock true`), and over ssh that no leftover clusters are running.
6. **Known master failures.** For each entry in the profile's `known_master_failures`, run its `recheck` command from a checkout of the default branch (for example a detached worktree at `<remote>/<default>`; for Go, `recheck` is one targeted `go test -count=1 -run '^<id>$' ./<package>` on one of its ids). If it passes, the failure is fixed or its cause is gone: remove the entry from the profile before launching, or a regression would pass as known. An entry without `recheck`: reproduce one of its ids by hand the same way, then add the command.
7. **vibe.** `vibe --version`; never use `vibe --worktree` (the scripts use `--workdir` on their own worktrees).

## 2. From request to launch

Agree with the owner, per scope: a short key, the repo, a brief (what "done" means, constraints, links to backlog entries), an integration branch name (`<type>/<slug>`), and optionally an existing branch to build on. Every scope ships what was integrated; there is no partial-ship question. Then write a request file in the session's job dir (not /tmp):

```json
{
  "run_tag": "2026-10-04a",
  "today": "2026-10-04",
  "jobdir": "/path/to/the/session/job/dir",
  "scopes": [
    { "key": "short-slug", "repo_path": "/abs/path/to/repo", "brief": "...", "integration_branch": "fix/short-slug" }
  ]
}
```

Optional per scope: `build_on_branch`, `profile_path` (a profile that is not on the checked-out branch yet), `followups` (entries from an earlier run's result, see Post-run). Optional top level: `max_vibe_runs` (3: continuation runs when a vibe run ends undelivered), `max_turns` (150), `integrator` (`"sonnet"`, the default, or `"script"`: a mechanical `merge --no-ff` with Sonnet only on a conflict). `ship_partial` and `max_fix_rounds` are gone (`prepare-args.sh` refuses them): every scope ships what was integrated, and a package gets one fix round.

`build_on_branch` (one branch per scope) is merged into the new integration branch before planning, with the base ref merged on top. Its commits are inherited: the plan verifies them (verify-only packages) and adds only what is missing. If the merge conflicts, the scope stops before planning; rebase the branch first. To build on two unrelated leftover branches, use two scopes.

```sh
bash $SK/prepare-args.sh request.json > /dev/null   # writes <jobdir>/vd/<run_tag>/args.json and prints it
```

Launch with the args file's content as an actual JSON value (not a string), and the absolute script path:

```
Workflow({ scriptPath: "<home>/.claude/skills/vibe-delivery/workflow.js", args: <contents of args.json> })
```

`run_tag` must be new for every launch: it names the run dir and the planner worktrees. Integration branch names must be new too, never a branch that ever had a merge request: the merge stage requires that no MR, in any state, exists for the branch before it opens one. To continue earlier work, use a new integration branch with `build_on_branch` pointing at the old one.

## 3. Monitoring

Check in every 20 to 30 minutes, not more often:

- `bash $SK/tmp-check.sh` (quiet when fine).
- A Haiku digest agent, read-only: "Summarize progress of the vibe-delivery run in `<rundir>`: for each `<scope>/<package>/run*/result.json` and `gates-*/gates.json`, report delivered/ok, blocked, reasons, policy violations; for runs without result.json, report the age of `vibe.log`'s last write and whether its `pid` is alive. Flag a run whose vibe.log has not grown for 20 minutes. Do not modify anything."
- Do not touch a running vibe process, its worktree or its out dir. A stuck run ends at `--timeout-min` (120 by default) and is then handled by the workflow.

## 4. Post-run

1. Read the result: `summary`, then for each scope `status`, `blockers`, `dropped`, `followups`, `followups_recorded`, `owner_questions`, `gates_full`.
2. For `needs_owner_decision`: put the blockers to the owner with plain options. A policy violation is reported first and prominently; the owner must look at what happened before anything else. Zero integrated packages: everything is in `followups`; propose the next run below.
3. Follow-ups: list them grouped by scope, deferred findings apart from packages not integrated (with final state, reason, open items, branch). For `blocked`, quote the blocked note (`<rundir>/<scope>/<pkg>/run<N>/.vd-blocked.md`): usually the plan was wrong, not vibe. If `followups_recorded` is false (or null because the scope stopped before the merge stage), file the entries listed in `followups_missing` (or all of them) in the profile's `followup_file` by hand, in a small bookkeeping commit. Verify-only packages' notes are listed in the result (`verification_note`).
4. Feeding follow-ups into the next run: copy the relevant entries of `result.followups` into a new scope's `followups` in the next request file (a new integration branch, as always). For one or more `not_integrated` entries of one package, set that scope's `build_on_branch` to the entry's `branch`, so the work and its evidence carry over and the planner plans the open items around it. Deferred findings of shipped work need no `build_on_branch`. The planner and the plan reviewer get the entries verbatim and must cover each one or say why not. Each entry's `[vd:<scope>/<package>]` tag finds its bookkeeping line, which the next MR prep ticks.
5. Clean up: for each `worktrees_to_clean` entry marked finished, `bash $SK/wt.sh remove --repo <repo> --path <path>`; keep the worktrees of packages filed as follow-ups: their branches are the evidence the next run builds on. Then `du -sh <rundir>` (the scripts delete caches; logs stay) and `bash $SK/tmp-check.sh`.
6. Final report: per scope the status, MR link and merge commit, packages and their final states, gates (naming any known failures hit), follow-ups (and whether they were recorded), and open owner questions.

## Profile (`.claude/vibe-delivery.yaml`)

Schema: `$SK/profile.schema.json`. Fields:

- `version: 1`, `repo`, `default_branch`, `remote` (or `no_remote: true`), `worktree_root` (`~` allowed).
- `bookkeeping`: `files` (shared tracking files, hunk-staged), `plan_entry_file` (where SETUP writes the plan-of-record entry), `followup_file` (where MR prep files follow-ups, usually the backlog), `convention` (how entries are written and ticked, and where follow-ups go in `followup_file`).
- `merge`: `open_command` (`{source}`, `{target}`, `{title}`, `{description_file}`), `command` (`{iid}`, `{sha}`), `mr_exists_command` (`{branch}`; prints a count), `notes`.
- `vm` (optional): `ssh`, `lock` (use the same lock name in every profile that shares the machine), `use_for`, `notes`.
- `gates[]`: `name`, `cmd` (`{touched_dirs}`/`{touched_files}` placeholders), `paths` (bash patterns, `*` spans `/`), `level` (`package` per package and after each integration, `full` at MR prep, `both`), `timeout_min`, `failure_patterns` (ERE; capture groups make the failure id), `fatal_patterns` (any match makes a failure real).
- `known_master_failures[]`: `id`, `ids` (failure ids as the patterns extract them), `signature`, `reason`, `verified` (where and when it was reproduced on the default branch), `recheck` (one targeted command that fails while the failure persists; pre-flight step 6 runs it).
- `re_corpus` (optional): `path`, `rule` for prior-art research during planning.
- `dev_stack_rules[]`, `house_rules[]`: carried into every agent and vibe prompt.

Minimal example (placeholders):

```yaml
version: 1
repo: my-service
default_branch: main
remote: origin
worktree_root: ~/worktrees/my-service
bookkeeping: {files: [TODO.md], plan_entry_file: TODO.md, followup_file: TODO.md, convention: "- [ ] task, ticked - [x] with a date; follow-ups at the end"}
merge:
  open_command: glab mr create --source-branch {source} --target-branch {target} --title {title} --description "$(cat {description_file})" --yes
  command: glab mr merge {iid} --sha {sha} --yes
  mr_exists_command: glab api "projects/:id/merge_requests?source_branch={branch}&state=all" | jq length
gates:
  - {name: test, cmd: "make test", paths: ["src/*"], failure_patterns: ['^--- FAIL: ([^ /]+)']}
known_master_failures: []
```

Split an aggregate target such as `make verify` into its parts when it stops at the first failure: a known test failure would otherwise hide whether the later steps pass.

## Scripts

| Script | Use |
|---|---|
| `workflow.js` | the Workflow script; args only from `prepare-args.sh` |
| `scope-branch.sh create/refresh/record/merge` | the integration branch: create it before planning (build-on merge, inherited-commit list), merge the base ref again after a wait, commit the plan-of-record entry and push, and (integrator `script`) merge a package mechanically, aborting on conflict and reporting `tree_equal` |
| `prepare-args.sh REQUEST.json` | resolves and validates profiles, embeds `plan.schema.json`, writes `args.json` |
| `vibe-run.sh start/wait/run/check` | one vibe session; `--base` required; `result.json` with `delivered`, `new_commits`, `out_of_scope`, `blocked`, `policy_violations` |
| `gates.sh start/wait/run` | the profile's gates for touched paths (plus `--verify-paths`/`--extra-cmd` for verify-only packages); `gates.json` with `ok`/`clean`/`ran` and known-failure classification |
| `wt.sh create/remove` | unique worktrees; refuses collisions; never removes the main checkout |
| `check-plan.sh PLAN.json [--inherited FILE]` | schema plus structural plan checks |
| `tests/run.sh [PROFILE.yaml]...` | every offline check: `bash -n`, shellcheck, `node --check`, the schemas against the metaschema, profile validation, the mock harness (`tests/harness.mjs`: the workflow with stubbed agents, one case per outcome, agent counts per package) and the dry runs (`tests/dry-run.sh`: the real scripts against throwaway repos with `tests/fakevibe`). Runs no workflow and no real vibe |
| `tmp-check.sh` | quiet unless /tmp is above the threshold or holds leftovers: any directory over 100 MB, untouched for an hour, with no file open in it (checked like `lsof`, from /proc) |

`wait` prints `DONE` plus one compact JSON line, `STILL_RUNNING` (exit 75), or `DIED` (exit 70; `vibe-run.sh check --out DIR` recomputes the result from the worktree). Every script drops `LD_LIBRARY_PATH` first, so vibe can call them. Tools come from nixpkgs (`VD_PREFER_PATH=1` uses PATH instead).
