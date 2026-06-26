---
description: Distill a tool or command into a Pi extension
argument-hint: "[extension description]"
---
Distill a tool or command into a Pi extension.

Extension description from user:

$ARGUMENTS

Steps:

1. Use the `skill-architect` skill (bundled in Pi) to design the extension structure. Verify `pi-harness-learning` is available (bundled) for the store-vs-implement decision.
2. Identify the repeatable goal, inputs, outputs, success criteria, and user corrections from the session.
3. Draft an `index.ts` extension factory with valid tool/command definitions. Include inline docs and error handling.
4. Call the `extensionify` tool with your draft to scaffold it, run an isolated smoke test (does not write to disk), and return diagnostics. If the smoke test fails, fix the draft and re-run until it passes. Never propose broken code.
5. Present the draft, smoke-test results, registered tools/commands, proposed path, and diagnostics to the user. Ask for explicit confirmation before writing anything.
6. Only after the user confirms, write `~/.pi/agent/extensions/<name>/index.ts` and load it. Tell the user it's now available and emphasize that new extension code is activated only on their explicit approval. Suggest `/reload` if needed.

Activating new extension code is gated on the user's explicit approval. This runs in the main session only — do not spawn subagents.
