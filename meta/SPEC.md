# .agents/ Specification

This file defines how to write, organize, and maintain `.md` instruction files within the `.agents/` directory.

---

## Purpose

The `.agents/` directory contains machine-readable instruction files that guide AI agents in their workflows. This specification ensures consistency, maintainability, and effectiveness across all agent instruction files.

---

## Directory Structure

```
.agents/
├── AGENTS.md          # Root index (routes to correct file)
└── meta/
    └── SPEC.md         # This file (specification for .agents/)

# Additional scope folders may exist:
# └── <scope>/
#     └── AGENTS.md
```

---

## Scope Types

| Scope | Directory | Purpose |
|-------|-----------|---------|
| Root | `.agents/AGENTS.md` | Index/router - directs to correct file |
| Meta | `meta/` | Specification for `.agents/` directory files (this file) |
| Custom | `<scope>/` | Any scope-specific agent rules |

---

## File Naming Rules

- **Instruction files in scope folders**: **Always** use `AGENTS.md` (tool compatibility)
- **This specification file**: `SPEC.md` (distinguishes it as meta-documentation for `.agents/`)
- **Directory names**: lowercase, descriptive, singular or plural as appropriate

---

## Content Standards

### Required Sections (in every AGENTS.md)

1. **Purpose** - One sentence describing the file's intent
2. **Scope** - What this file applies to (common, specific scope, project scope, etc.)
3. **Rules** - Rules in Always/Never/Ask Before format

### Writing Principles

- **Machine-first**: Prioritize agent readability over human readability
- **Actionable**: Every rule must be directly executable
- **Specific**: Use exact versions, commands, paths (no ranges, no "latest")
- **Concise**: Each file < 200 lines; split into multiple files if longer
- **Explicit**: When in doubt, make it explicit

### Optional Extended Form

A scope file whose rules require justification to be applied correctly may use the extended form: each Always/Never bullet carries a short rationale clause after an em-dash, and one or more reference sections may follow `## Rules` (a lookup table, a worked recipe, a `- [ ]` verification checklist, a `Sources:` citation list). Do not mix forms within one file — a file is either terse imperatives throughout or extended throughout. The 200-line cap applies either way.

---

## File Organization

### When to Create a New Scope Folder

Create a new `<scope>/` folder with AGENTS.md when:
- You have recurring tasks in that scope
- The rules are specific to that scope
- The rules differ from general guidelines

### When to Update meta/SPEC.md

Update this file when:
- The standard for writing `.agents/` files changes
- New content patterns emerge for `.agents/` directory
- The directory structure convention evolves

---

## Maintenance Rules

### Update Triggers

- When a **new pattern** emerges that should be standard
- When an **agent makes a preventable mistake** (add preventive rule)
- When **tooling changes** (new agent capabilities, new version)
- **Quarterly** - Review all files for relevance

### Root Index Maintenance
- Always update `.agents/AGENTS.md` when adding or removing scope folders

### Versioning

- No version numbers in filenames
- Track changes via git history
- Reference external versions explicitly (e.g., "version 1.2.3", not "version 1.2")

### Deprecation

- Mark outdated files: Rename with `DEPRECATED-` prefix
- Add header: `> **DEPRECATED**: [Reason]` at top of file
- Remove after 6 months if no references remain

---

## Hierarchy & Precedence

Agents load files in this order (later overrides earlier):

1. `.agents/AGENTS.md` (root router - always checked first)
2. `.agents/<current-scope>/AGENTS.md` (if in a scope folder)
3. `.agents/meta/SPEC.md` (this specification - fallback for `.agents/` files)

**Rule**: More specific context overrides more general context.

---

## Creating New Files in .agents/

### Decision Flow

```
Is this about how to write/organize files within .agents/?
├── Yes → meta/SPEC.md (update this file)

Is this scope-specific agent rules?
├── Yes → Create <scope>/AGENTS.md

Otherwise → Reconsider if needed
```

### New AGENTS.md File Checklist

- [ ] Named `AGENTS.md`
- [ ] Has **Purpose** section
- [ ] Has **Scope** section
- [ ] Has **Rules** section (Always/Never/Ask Before)
- [ ] Follows writing principles (machine-first, actionable, specific, concise)
- [ ] < 200 lines
- [ ] No sensitive information (API keys, passwords, tokens)
- [ ] Tested with at least one agent

---

## Example: Minimal AGENTS.md

```markdown
# AGENTS.md

## Purpose
[One sentence describing what this file instructs agents to do].

## Scope
[What this applies to: a language, a task type, a project, etc.].

## Rules

### Always
- [Actionable rule 1]
- [Actionable rule 2]

### Never
- [Prohibited action 1]
- [Prohibited action 2]

### Ask Before
- [Action requiring consultation]
```

---

**Standard Rule**: When in doubt, make it explicit. Agents thrive on clarity, fail on ambiguity.
