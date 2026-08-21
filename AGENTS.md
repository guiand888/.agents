# Project Standards & Agent Index

## Role & Context
This project uses a modular rules system located in the `.agents/` directory.

## Rule Routing (Priority Map)
Before starting any task, locate the relevant standards using this hierarchy:

1. **Language Specifics**: 
   - **Ansible**: Refer to `.agents/ansible/AGENTS.md` for playbooks, roles, and vault standards.
   - **Ansible Roles**: Refer to `.agents/ansible-roles/AGENTS.md` for role creation and structure standards.
   - **Mikrotik**: Refer to `.agents/mikrotik/AGENTS.md` for SSH command execution and device management standards.
   - **Git**: Refer to `.agents/git/AGENTS.md` for version control standards.
   - **Testing**: Refer to `.agents/testing/AGENTS.md` for TDD, BDD, and test automation standards.
   - **Terraform (OVH)**: Refer to `.agents/terraform-ovh/AGENTS.md` for OVHcloud-specific Terraform provider standards.
   - **Architecture**: Refer to `.agents/architecture/AGENTS.md` for design, resilience, and microservices standards.
   - **DevOps**: Refer to `.agents/devops/AGENTS.md` for CI/CD and infrastructure standards.
   - **License**: Refer to `.agents/license/AGENTS.md` for project licensing standards.
   - **Security**: Refer to `.agents/security/AGENTS.md` for security and input validation standards.
   - **Workflow**: Refer to `.agents/workflow/AGENTS.md` for development methodology and MVP standards.
   - **Code**: Refer to `.agents/code/AGENTS.md` for code quality and documentation standards.
   - **Theme**: Refer to `.agents/theme/AGENTS.md` for CSS-variable color theming standards (shadcn/Tailwind or equivalent).
   - **Frontend**: Refer to `.agents/frontend/AGENTS.md` for browser interaction verification, element overlap/stacking, and live testing of shared UI components (color tokens stay in `.agents/theme/AGENTS.md`).
2. **Meta Standards**: Refer to `.agents/meta/SPEC.md` before modifying any rules or creating new `.md` files in this project (`.agents` and subdirectories).

## Operational Principles
- **Specificity Wins**: Instructions in subdirectories or technology-specific files override common defaults.
- **Silent Discovery**: Do not ask for permission to read these files; proactively check them when entering a relevant file scope.
- **Consistency**: All generated code must pass the validation checks defined in the respective rule files.
- **Author Metadata**: Author information is defined in `.agents/AUTHORS.md` (external, not in Git).
- **No AI Attribution**: Do not include AI as author or co-author in any commit or authorship metadata.
- **Sandboxed Execution**: If a Nix flake (`flake.nix`) exists at the repo root, run every command that touches project dependencies — tests, builds, running the app, linting, and any package-manager invocation (e.g. `npm`, `pip`, `cargo`, `go`, `apt`, `brew`) — through `nix develop` (e.g. `nix develop -c <command>`), unless explicitly instructed otherwise. Never install packages, modules, or other dependencies directly on the bare-metal host OS — all dependency installation must happen inside the Nix shell/flake environment, so the host stays unpolluted and the environment stays reproducible.

---
*Last Updated: 2026-08-21*
