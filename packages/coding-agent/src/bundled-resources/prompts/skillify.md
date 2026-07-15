---
description: Distill a repeatable process into a Pi skill
argument-hint: "[process description]"
---
Capture the repeatable process from this session as a Pi skill.

Process description from user:

$ARGUMENTS

Steps:

1. Use the `skill-architect` skill (bundled in Pi) to design the skill structure. Verify `pi-harness-learning` is available (bundled) for the store-vs-implement decision.
2. Identify the repeatable goal, inputs, outputs, success criteria, and user corrections from the session.
3. Draft a `SKILL.md` with valid frontmatter: `name` (kebab-case, ≤64 chars) and `description` (≤1024 chars).
4. Call the `skillify` tool with your draft to validate and audit it. The tool returns validity, errors, near-duplicate audit (prefer refining an existing skill), and proposedPath. If the tool is unavailable, use the installed skill audit/validator or bounded structural checks and disclose the missing optional check rather than blocking.
5. Fix verified errors and overlap problems, then re-run the available audit. Stop after five failed repairs of the same defect or two cycles with no changed draft or improved result; report the precise blocker instead of looping indefinitely.
6. Treat this explicit `/skillify` request as authorization to write the resulting safe user-level skill or refine the matching user-level skill. Do not ask for duplicate confirmation. Ask only if the change would alter settings, expand executable authority, require credentials, delete data, or publish/push/release.
7. Write the validated skill to the audited path, then report the final path, audit evidence, and invocation (`/skill:<name>`). Suggest `/reload` only when the current runtime requires it; do not make reloading a completion gate.

This runs in the main session. Delegate only a bounded independent audit when it materially improves confidence; delegation is never required for progress.
