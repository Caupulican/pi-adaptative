# Consolidate thinking-level validation for skill metadata and settings

Fixed in the working tree. This issue record is local because GitHub Issues is disabled on the origin repository.

At `470f3ada4` the skill loader maintained its own eight-value list in `VALID_SKILL_THINKING_LEVELS`. Its comment justified the copy by describing an import cycle through the settings manager. A dependency-light validator already existed in `core/thinking-level.ts`, while `core/settings/settings-rules.ts` owned an identical list. A future addition to only one list could cause a skill hint and a settings value to be accepted differently.

## Acceptance criteria

- Skill metadata and settings validation consume one authoritative set of thinking levels without an import cycle.
- Non-string and unknown inputs keep their existing rejection behavior. Previously accepted settings and skill hints continue to load.
- Preserve public exports that callers use, and cover agreement between the skill and settings readers.

## Resolution

Skill metadata and settings now use the CLI and model resolver’s existing `isValidThinkingLevel` guard. Its input accepts unknown values so both callers can use it directly. Settings re-exports its existing names for compatibility. The regression covers all eight levels, an unknown string and a non-string frontmatter value.

Affected sources include the [skill loader](../../packages/coding-agent/src/core/skills.ts), the [shared validator](../../packages/coding-agent/src/core/thinking-level.ts) and the [settings rules](../../packages/coding-agent/src/core/settings/settings-rules.ts).
