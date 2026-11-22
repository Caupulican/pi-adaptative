# Self-Adaptation

Pi can turn something you just did into a durable, reusable capability. When a session reveals a repeatable workflow, Pi can draft a new **skill** or **extension** for it, check it for overlap with what you already have, validate it, and — once you approve — make it live the same turn. No restart, no hand-authoring boilerplate.

This keeps a human on the edge of the loop: Pi proposes, you confirm, then it activates.

## Table of Contents

- [Commands](#commands)
- [How proposal and activation are separated](#how-proposal-and-activation-are-separated)
- [Skillify](#skillify)
- [Extensionify](#extensionify)
- [Learn](#learn)
- [Harness self-adaptation](#harness-self-adaptation)
- [Duplicate detection](#duplicate-detection)
- [Going live](#going-live)

## Commands

| Command | Purpose |
|---------|---------|
| `/skillify` | Capture a repeatable workflow from the session and draft a new skill. |
| `/extensionify` | Scaffold a new extension (a tool or command) from the session. |
| `/learn` | Reflect on the session, classify the lesson, and route it to the right outcome. |

The same analysis is also available to the model as the `skillify`, `extensionify`, and `skill_audit` tools.

## How proposal and activation are separated

Authoring has a hard boundary between *drafting* and *committing*:

- **Proposal** is non-destructive. The `skillify` and `extensionify` tools analyze the session, generate a draft, validate it, and return it. They never write to disk and never reload anything, so they are safe for the model — or a subagent — to call.
- **Activation** is human-gated. The persistent write and the live reload happen only at the `/skillify` and `/extensionify` commands in your main session, and only after you confirm the draft.

Because activation lives only at the interactive layer, a subagent can at most produce a proposal — it can never persist or activate a capability on its own.

## Skillify

`/skillify` builds a [skill](skills.md) from what the session demonstrated:

1. It captures the repeatable process — goal, inputs, outputs, success criteria, and any corrections you made along the way.
2. It applies skill-authoring doctrine (a focused, one-job skill with clear frontmatter).
3. It drafts the `SKILL.md` and validates the name and description.
4. It runs [duplicate detection](#duplicate-detection) against your loaded skills.
5. It shows you the draft. On your confirmation, it writes the skill to `~/.pi/agent/skills/<name>/` and reloads it so `/skill:<name>` works immediately.

The doctrine skills it leans on (`skill-architect`, `pi-harness-learning`) ship with Pi as bundled skills, so skillify works out of the box. Like any bundled resource, they can be overridden by your own versions or filtered out with a [resource profile](resources.md).

## Extensionify

`/extensionify` scaffolds an [extension](extensions.md) — an `index.ts` factory that registers a tool or command, plus an optional `package.json` manifest.

Before anything is offered for activation, the candidate is **smoke-tested in isolation**: Pi runs the generated factory against a throwaway runtime, never the live one. If it throws, times out, or fails validation, the proposal comes back rejected with diagnostics, and activation refuses to write or load it. Only a clean isolated load — and your explicit confirmation — lets the real extension be written to `~/.pi/agent/extensions/<name>/` and loaded live.

## Learn

`/learn` is the broader post-session pass. It summarizes the durable lesson and classifies it: is this a memory, a refinement to an existing skill, a brand-new skill, a prompt, an extension, or nothing worth keeping? It then routes the lesson to the matching proposal — `skillify` or `extensionify`, a targeted edit, or a note — and surfaces the result for you to activate.

`/learn` orchestrates; it never writes or activates on its own. Long-term memory storage is handled outside Pi; `/learn` routes to it rather than implementing it.

## Harness self-adaptation

For work on Pi itself, the bundled `harness-self-adaptation` skill keeps the active task primary and wraps it in a bounded improvement loop: define an observable oracle, capture a baseline or correctness invariant, diagnose the owning mechanism, choose the smallest enforcing layer, validate a focused intervention, then retain or roll it back. A task with no reusable evidence ends with no durable adaptation rather than a speculative change.

The skill treats tests, benchmarks, telemetry, and before/after measurements as retention evidence. It keeps code defects in their owning code, routes procedures to skills or prompts, and reserves extensions or core changes for behavior lower layers cannot enforce. It composes with `pi-harness-learning` for after-action capture and `skill-architect` for instruction authoring. Pi can load it when the task description matches, or you can force it with `/skill:harness-self-adaptation`.

## Comparing a shorter skill

Auto Learn records the rationale and predicted effect of a proposed skill edit. If an automatic update shortens a loaded project skill, Pi keeps the current body while Pi collects a comparison for the same project, model, reasoning level, skill and pair of revisions. You choose whether the sampled tasks cover the instructions being changed. The skill description must still match. The usual session permissions and skill version check apply when Pi writes the change.

1. In the session that received the proposal, enter `/auto-learn export-comparison RUN INDEX` using the identifiers in the handoff. Pi writes the two bodies to a new private directory and prints the command for your shell.
2. Run that command from a Pi source checkout when you want to spend hosted-model quota. Each revision gets the same coding tasks, foreground tools and selected model. The independent grader checks the work and a read-only public-status task containing a synthetic private field. The latter gets one submission. You can inspect the paired results in the study’s private output directory.
3. Enter `/auto-learn comparison RUN INDEX` to see the exact tasks, reasoning level and outcome. If those tasks cover the behavior you need this skill to preserve, use the displayed `/auto-learn reoffer-comparison RUN INDEX STUDY_ID` in the owning session. Applying the shorter body requires the candidate to pass every graded task, add no corrections on any pair and consume fewer total measured tokens. A known regression for those revisions takes precedence over a passing subset. Missing measurements, changed source, changes to the skill description, and shared skills stay available for review.

The private comparison history retains up to 128 studies per project. Each receipt identifies the model, both body digests, evaluator source, corpus and measured outcome. A score applies to the sampled tasks and selected model. A separate model requires its own evidence. Recent native edit decisions can inform the next learner in the same session, with applied and held decisions distinguished from measured task outcomes.

## Duplicate detection

The `skill_audit` tool guards against accumulating near-identical skills. Given a draft's name, description, and body, it scans your loaded skills and scores keyword overlap. Matches above the similarity threshold are flagged so you can **merge or refine** an existing skill instead of adding a redundant one.

It runs entirely locally — no network call, no embedding model — so it is safe and instant. You can also call it on its own to audit an existing set of skills for overlap.

## Going live

Activation finishes by hot-reloading the new capability through the same live load/unload path the [Resources hub](resources.md#manage-library) uses. A skill or extension you just approved is usable the moment it is written — the ingest → author → live loop closes in a single turn.
