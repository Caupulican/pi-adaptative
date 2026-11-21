---
description: Distill a repeatable process into a Pi skill
argument-hint: "[process description]"
---
Capture the repeatable process from this session as a Pi skill.

Process description from user:

$ARGUMENTS

Steps:

1. Identify the repeatable goal, inputs, outputs and user corrections. Use `pi-harness-learning` if the lesson could belong in memory, a skill or code.
2. Search the requested scope for the skill that already owns this job. Use `skill-architect` to refine its instructions or design a new skill when there is a gap.
3. Follow `skill-creator` for package layout, worker eligibility and validation. Scaffold only a new package.
4. Call the `skillify` tool with your draft to validate and audit it. The tool returns validity, errors, near-duplicate audit (prefer refining an existing skill), and proposedPath. If the tool is unavailable, use the installed skill audit/validator or bounded structural checks and disclose the missing optional check rather than blocking.
5. Fix verified errors and overlap problems, then re-run the available audit. Stop after five failed repairs of the same defect or two cycles with no changed draft or improved result; report the precise blocker instead of looping indefinitely.
6. Use the destination the user requested. For Pi harness skills, edit the bundled source identified by `skill-creator`. For an ordinary personal skill, use the proposed user-level path unless an existing skill in scope owns the job. Treat the request as authorization to create or refine the skill in that scope. Do not ask for duplicate confirmation. Ask only if the change would alter settings, expand executable authority, require credentials, delete data, or publish/push/release.
7. Write the validated skill there. Report the path, validation evidence and an ordinary request that should find it. Include `/skill:<name>` for explicit invocation. Suggest `/reload` only when the current runtime requires it; do not make reloading a completion gate.

This runs in the main session. Follow the session's `delegation` ledger rule for independent work; the parent owns integration and activation.
