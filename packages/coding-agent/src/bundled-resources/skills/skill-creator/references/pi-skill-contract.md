# Pi skill package contract

## Required layout

```text
<skill-name>/
  SKILL.md
  scripts/       optional deterministic automation
  references/    optional selectively loaded knowledge
  assets/        optional output ingredients
```

The directory name and frontmatter `name` are the same lowercase hyphen-case
identifier. Pi bundled skills are provider-neutral; do not add an `agents/`
directory or `openai.yaml`.

## Required frontmatter

```yaml
---
name: narrow-skill-name
description: "What it does and the concrete requests or contexts that load it."
---
```

Use one `name` and one quoted, non-empty `description`. Keep the description
under 1,000 characters and focused enough that adjacent skills do not route.

## Required spine

Use these headers once and in order:

1. `## How to use the skill`
2. `## North Star`
3. `## Core Sections`
4. `## Anti-Patterns`
5. `## Examples`
6. `## Self-Check`
7. `## Known Gaps`

The main file must be under 500 lines. Prefer references over a large main file,
but do not create empty documentation merely to satisfy a layout convention.

## Resource rules

- Reference links are relative to the skill directory and must not escape it.
- `scripts/` must be deterministic, bounded, non-destructive by default, and
  portable across supported platforms or explicit about its platform.
- `assets/` are copied/read as data; never hide executable instructions there.
- Do not duplicate the same rule across the main file and references. The main
  file routes to the authoritative detail.
- Do not embed credentials, host-specific paths, provider tokens, or generated
  runtime state.

## Validation layers

1. `validate-skill.mjs`: package shape, safe name, quoted frontmatter, line
   bound, required header order, provider neutrality, and linked-resource paths.
2. Discovery test: a blank Pi profile finds the bundled skill and its source
   scope is correct.
3. Content contract: the critical behavior and linked resources are present.
4. Script tests: success, malformed input, traversal, collision, and platform
   behavior.
5. Forward routing: positive, adjacent negative, and ambiguous prompts.
6. Package smoke: built/released Pi includes and loads the resources.

## Ownership boundary

`skill-creator` owns package creation and structural validation.
`skill-architect` owns instruction architecture and content quality.
`pi-harness-learning` decides whether a recurring lesson belongs in memory,
skill, prompt, extension, or core source. `deduplicate-by-evidence` resolves
overlap between competing skills.
