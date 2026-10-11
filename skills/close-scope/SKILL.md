---
name: close-scope
description: Close a large scope end to end with multiple agents. Decompose into parallel blocks, interview the owner once on what evidence cannot answer, then per block plan (cross-model consensus), implement, adversarially review, open an MR and merge, looping on newly found production bugs until none remain. Use when the user runs /close-scope or asks to close a scope or epic autonomously. Costs many agent calls; only on explicit request.
---

# close-scope: decompose, ask once, deliver, merge

One scope per run. Two workflows with the owner's interview between them, because workflow agents run in the background and cannot ask anything.

Files here: `scope-decompose.workflow.js` (A), `close-scope.workflow.js` (B). Both are launched with `Workflow({scriptPath, args})`. Nothing else: no runner script, no profile file. Repo rules come from the repo's `CLAUDE.md` (every subagent already receives it); gates, MR and merge commands come from there or from the repo's docs.

## 0. Pre-flight (you, inline, minutes)
- `df -h` on home and the worktree root; stop above 85%. `git fetch`; B builds on `origin/<default>`, never the local checkout.
- Verify the CLIs once: `codex`, `vibe`, `opencode`, `glab` on PATH. Codex plugin script: `~/.claude/plugins/cache/openai-codex/codex/<ver>/scripts/codex-companion.mjs` (update `CODEX` in B if the version moved).
- Live-checked 2026-10-11: `codex adversarial-review --model gpt-6.1-sol --base <ref>` ~12 s, has no `--effort` flag (uses `~/.codex/config.toml`); `codex task --model gpt-6.1-sol --effort high` works but ~2 min latency, so use it once per plan, never in a loop; `vibe -p` reads without `--trust`/`--yolo`; `opencode run --model openrouter/xiaomi/mimo-v2.6-pro --variant high` works.
- Settle `repo`, `worktreeRoot`, `epic`, `branchPrefix`, optional `reCorpus` with the owner.

## 1. DECOMPOSE (workflow A)
`Workflow({scriptPath: <this dir>/scope-decompose.workflow.js, args: {scope, reCorpus}})`. One Sonnet/high agent cuts blocks (declared files, `depends_on`, `risk` high|low) and drafts strategy questions. The **evidence gate** then answers what it can: three researchers per question (repo decisions, RE corpus, official docs/gold standard), one verifier re-opens every citation; plain code decides. Returns `{blocks, questions, ledger}`.

## 2. INTERVIEW (you, inline, once)
- Show the **ledger** first ("decided by evidence, not asked"), so the owner can veto in one answer.
- Ask only `questions`, max 4 per call: plain-English (ELI20) explanation, pros/cons per option, one recommendation that is never a pruned option. Pruned options are shown with the citation that killed them.
- Always include: authorization for `--yolo` (only if some stage needs write access; none in the default design), merge timing (`as-ready` recommended, serial lane; or `end`), and "when later evidence contradicts an answer: park the block (recommended) or follow the evidence".
- Check answers against the ledger. An answer that contradicts a verified ledger item is raised once ("this supersedes ADR-X, confirm?") and, if confirmed, adds an ADR step to the affected blocks.

## 3. DELIVER (workflow B)
`Workflow({scriptPath: <this dir>/close-scope.workflow.js, args})`. Per block, ~5 lanes in parallel:
1. **Plan.** Sonnet/xhigh. `low` risk: stop at one call. `high` risk: <=4 parallel grounding lookups, one align call, one codex opinion (run and resolved by the same agent), vibe tie-break on disputed points only.
2. **Implement.** Sonnet/high in its own worktree, tests first, inside the declared files. A block with `depends_on` starts only when every dependency is `mr_open` and (with `as-ready`) merged; otherwise it ends `blocked_by_dependency` with the dependency's reason. After implementing, a cheap check confirms the worktree is listed and the branch has commits ahead of base, else `impl_failed`.
3. **Review loop** (<=3 rounds). Gates and codex adversarial review run concurrently; later rounds review only the fix diff and re-check only open blocking items. Disputes go to vibe once. Scope is diffed against the merge-base (`base...HEAD`) after a fetch. A review that did not run (`ran=false`) is retried once and never counts as a round; if it still cannot run the block ends `review_unavailable`, not clean and not `blocking_open`.
4. **MR**, then a **serial merge lane**: sync default branch, re-run only what the merge changed (nothing if the default branch has not moved), merge pinned to the head sha.
5. **Triage** per round: dedupe against open issues; promote only production-critical/meaningful findings tied to scope as next-round blocks (<=3 rounds); the rest is one consolidated backlog issue per theme.
6. **Close-out critic** works from the run's own ledger, not by re-reading code. Done = every acceptance criterion evidenced on the default branch, every MR merged, no such issue open.

## Token and speed rules (why it is shaped this way)
- Evidence is gathered once (A) and inherited; blocks never re-research the ledger.
- Rigor is tiered by `risk`; each external opinion is called once and bounded; re-review is incremental; findings seen are never re-litigated.
- Prompts are byte-stable so `resumeFromRunId` caches a killed run. No timestamps in prompts.
- A worker's report is never evidence; gates and diffs are run by a separate agent.

## Lessons that cost hours before
- vibe `-p` hangs without `< /dev/null`; vibe leaks `LD_LIBRARY_PATH` and breaks nix (`env -u`). Both are baked into the relay commands.
- Parallel worktrees share one dev stack: a live-suite failure can be cross-lane contention; re-run isolated before trusting it.
- Never `glab api` unfiltered (leaked a runner token once). Search issues before filing.
- Worktrees, caches and temp files live under the owner's cache/worktree root, never `/tmp`; clean each block's worktree after it merges.
- No shell heredocs (`cat > f <<EOF`, `git commit -F - <<EOF`, `python3 - <<EOF`) in agent Bash: each one raises a permission prompt that interrupts a long unattended run. Agents write files with the Write/Edit tools, pass commit messages with `git commit -F <file>` or `-m`, and run multi-line scripts from a file. Baked into the `HOUSE` constant of both workflow files.
- Validate each merge against current master; stacked textually-clean merges have broken the build before.
