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
4. Call the `extensionify` tool with your draft to scaffold it, run an isolated smoke test (without writing), and return diagnostics. If the tool is unavailable, use the installed extension validation path or a bounded source review and disclose the missing optional check rather than blocking.
5. Fix verified failures and rerun the available smoke test. Stop after five failed repairs of the same defect or two cycles with no changed draft or improved result; report the precise blocker instead of looping indefinitely.
6. Treat this explicit `/extensionify` request as authorization to write and activate the safe, scoped user-level extension described by the user. Do not ask for duplicate confirmation. Ask only if the extension would add credentials, arbitrary executable paths, package installation, network exposure, destructive behavior, settings changes, publishing, or broader authority than the request grants.
7. Write `~/.pi/agent/extensions/<name>/index.ts`, load it when the current runtime supports safe loading, and report the path, smoke-test evidence, and registered tools/commands. Suggest `/reload` when needed; do not leave the task waiting for an approval already conveyed by the command invocation.

This runs in the main session. Delegate only a bounded independent review when it materially improves confidence; delegation is never required for progress.
