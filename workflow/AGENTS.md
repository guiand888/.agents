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
- Record multi-phase work in the project's durable, checked-in task file before implementing it
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
