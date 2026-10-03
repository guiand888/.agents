# Workflow Standards

## Purpose
Define development workflow methodology.

## Scope
Batch sizing, incremental delivery, MVP approach, durable task tracking, and multi-agent execution.

## Rules

### Always
- Deliver features in one week or less
- Work in small increments for fast feedback
- Ensure features are useful subsets delivered incrementally
- Record multi-phase work in the project's durable, checked-in task tracker before implementing it — a committed task file or the project's issue tracker, whichever its AGENTS.md designates
- File a newly scoped phase at scoping time, not at completion
- Run subagents in parallel, targeting ~5 concurrent, when their file scopes and contexts are genuinely disjoint
- Confirm scope disjointness against the working tree (`git status`/`git diff`) before dispatching parallel agents
- Assign a single architectural seam to a single agent, however large
- Consult an advisor at decision points: before committing to an approach, at phase boundaries, when stuck, and before declaring large work done
- Dispatch an independent verifier for every substantive delivery, including small fixes
- Have the verifier re-run build, tests, and lint itself and re-derive claims from the committed diff
- Review already-pushed commits periodically with a third-party agent, run from an isolated worktree, and record severity-ranked findings in a written report
- Redirect stdin from `/dev/null` when invoking an agent CLI non-interactively
- Check `git status --short` for uninstructed changes after every permission-bypassing agent run

### Never
- Build large features without intermediate delivery
- Track a multi-commit phase only in an ephemeral, uncommitted plan file
- Accept a worker agent's self-report as proof that work is done
- Run a review agent in a worktree where other work is in flight

### Ask Before
- Running any agent with permission-bypassing or autonomous flags

## Multi-scope delivery with a coding CLI

When an external coding CLI writes the code and agents plan, review and merge (the `vibe-delivery` skill, configured per repository by `.claude/vibe-delivery.yaml`):

- Decide delivery mechanically: new commits beyond the run's base (the sha the package forked from, passed explicitly, never "HEAD at start"), a clean tree, nothing outside the package's declared files, and gates run by a script. Never on an agent's report. The one exception to "new commits" is a verify-only package checking work that is already on the branch: it is delivered by a written verification note and its own test commands passing as gates.
- When building on an existing branch, create the integration branch before planning and tell the planner, from git, which commits it already holds; plan verification around them, never a package that recreates them.
- Do not double the coding CLI with agent work: the plan review is the only ground-truthing of specs, the gates are the only builds, one reviewer reads each round, and a senior adjudicator is called only on a disputed or high-risk package.
- Run the CLI detached, with stdin from `/dev/null`, and wait in bounded chunks below the shell time cap; never let a supervising agent return while the CLI is still running.
- Validate plans before review: unique package ids, dependencies only on earlier waves, disjoint file scopes within a wave, every package in the scope's own repository.
- Start a package only after the packages it depends on are integrated; mark it blocked, not run, when one was dropped.
- Allow a bounded number of fix rounds per package, then report it as unapproved. Report every package that did not ship, with its reason.
- Let only the final merge stage open or merge a merge request, and only on the gated head; fail any earlier run that opened one or moved the default branch.
- Stop for the owner on a partial ship, failing gates beyond the repository's documented known failures, or a repository without a remote.
- Keep site-specific facts (hosts, forges, paths, gate commands, known failures) in the repository's profile, never in the shared skill.
