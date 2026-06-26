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
4. Call the `skillify` tool with your draft to validate and audit it. The tool returns validity, errors, near-duplicate audit (prefer refining existing skills), and proposedPath — it does NOT write.
5. If the audit shows errors or near-duplicates, fix the draft and re-run `skillify` until clean. Never propose broken code.
6. Present the draft, audit results, and proposed path to the user. Ask for explicit confirmation before writing anything.
7. Only after the user confirms, write `~/.pi/agent/skills/<name>/SKILL.md`. Tell the user it's now available as `/skill:<name>` and suggest `/reload` if needed.

This runs in the main session only — do not spawn subagents.
