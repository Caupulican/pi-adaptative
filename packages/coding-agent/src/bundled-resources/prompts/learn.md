---
description: Classify and route a lesson to the appropriate Pi harness asset
argument-hint: "[challenge or lesson]"
---
Run a Pi harness learning pass for this challenge or lesson:

$ARGUMENTS

Use the `pi-harness-learning` and `skill-architect` skills if available (bundled in Pi).

Workflow:

1. Summarize the reusable lesson in one or two evidence-backed sentences.
2. Classify the outcome as: skill refinement, new skill (use `/skillify` discipline), extension/tooling (use `/extensionify` discipline), memory, prompt update, or no action per `pi-harness-learning`.
3. Before any write, always require explicit user confirmation.
4. Route to the appropriate discipline:
   - **New skill**: Call `/skillify` with the process description (it will guide you through skill authoring).
   - **Skill refinement**: Edit the existing `~/.pi/agent/skills/<name>/SKILL.md`, validate it, show the diff, and confirm before writing.
   - **Extension**: Call `/extensionify` with the extension description (it will guide you through extension authoring).
   - **Memory**: External (not written by this prompt) — note it for manual recording.
   - **Prompt**: Propose a new `~/.pi/agent/prompts/<name>.md`, show the draft, and confirm before writing.
   - **No action**: Report why.
5. After any write, validate the result: skill edits need discovery/frontmatter checks; extension writes need a fresh load or smoke test.

Report paths and exact changes made or skipped, and evidence for the classification.

This runs in the main session only — do not spawn subagents.
