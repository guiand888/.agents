# Testing Standards

## Purpose
Define testing methodology for code quality assurance.

## Scope
TDD, BDD, spec-driven development, test automation, and validation.

## Rules

### Always
- Write behavioral specs (Gherkin Given/When/Then) before writing any implementation code
- Treat the spec as the contract: implementation must satisfy the spec, not the other way around
- Review and approve the spec before starting implementation
- Map every spec scenario to one or more test cases
- Update the spec when requirements change; re-run the full test suite after spec changes
- Write tests before writing code (Red-Green-Refactor)
- Automate tests in CI/CD pipeline
- Cover unit, integration, and acceptance levels
- Write acceptance criteria before development
- Run tests via `nix develop` when a `flake.nix` is present at the repo root (see root `AGENTS.md`)
- Build minimal, clearly-marked throwaway scaffolding when an environment gap blocks live verification
- Revert verification scaffolding to its pre-change state before committing

### Never
- Implement functionality without an approved spec
- Write implementation code before the spec exists
- Treat tests as after-the-fact documentation rather than as the primary design artifact
- Skip test automation
- Assume test success without verification
- Skip live verification because the environment makes it inconvenient
- Leave throwaway verification scaffolding in a commit
- Install test dependencies, runners, or packages on the bare-metal OS when a `flake.nix` is present — install inside the Nix shell/flake environment only
