# ADR 0001. Discover skill metadata separately from activation

Accepted. This records the behavior of the skill loader and vault.

## Context

Package resolution, prompt loading and vault search need to agree on which files represent skills. Reading every skill body at startup makes discovery depend on the size of installed instructions. Interpreting a path match as a request to load a skill would let ordinary file work change the instructions in a session.

## Decision

- Use `discoverSkillFiles` for package resolution and loading. A directory with `SKILL.md` is a skill root. Use the discovery mode to recognize standalone Markdown files. Canonical paths identify duplicate physical files, including symlink aliases. Different files that declare the same name produce a collision diagnostic and the first admitted definition wins.
- Apply the profile's file-admission predicate before reading metadata. `readSkillFrontmatterFile` bounds the read by the metadata limit, stops once it sees the closing delimiter, and checks the opened file's version. `inspectSkillFile` reads a bounded body for inspection without consuming an active slot.
- Keep compatibility with project layouts that use standalone Markdown. A standalone file without a description is skipped silently. A declared skill needs a description, and other validation warnings can accompany a loaded definition. `includeProjectDefaults` inherits `includeDefaults` when omitted.
- Treat the effects declaration as the boundary for worker visibility. An absent or empty declaration means no effects. A worker can discover and load only skills that declare none. Unknown declarations produce diagnostics. The root agent can discover skills with declared external effects. Actual actions follow the authority granted for the task.
- Use bounded, working-tree-relative globs as ranking hints. Commas inside a brace expression belong to the pattern. Invalid and excess patterns produce diagnostics. `skillWorkPathsFromToolCall` expands path aliases and takes explicit in-tree paths from path-scoped tools. Directory defaults and paths outside the tree provide no ranking signal. A match improves a search result's rank. Loading remains a separate action.
- A skill's `thinking` field is a hint to consumers. The loader exposes it as metadata. A skill has no execution interval in which the loader could reliably change and restore session effort. The `promoted` field identifies reflection-generated skills to the curator.

## Consequences

Installing a large skill body need not increase discovery reads beyond the bounded prefix. Following a path or inspecting a file leaves active instructions untouched. The SDK exposes effect, path and file-admission contracts to callers. Three short declaration comments are retained for that published interface.

See the [skill reference](../../packages/coding-agent/docs/skills.md) and the [loader](../../packages/coding-agent/src/core/skills.ts).
