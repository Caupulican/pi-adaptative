---
name: pi-harness-learning
description: "Use when reflecting on agent behavior, explaining why Pi did something, capturing a repeatable workflow as a skill, or improving user-level Pi skills/extensions/prompts after overcoming a challenge. Helps decide what to store in Automata Mind versus what to implement in the harness."
---

# Pi Harness Learning

## How to use the skill

Use this skill to turn hard-won session experience into durable memory and better
Pi harness behavior. Keep changes global/user-scoped unless the user explicitly
asks for project-local `.pi/`, `.agents/`, `.codex/`, or `.omx/` assets.

### When to Use

- Reflecting on Pi/agent behavior after a correction, repeated friction, tool failure, or successful new workflow.
- Deciding whether to store Automata memory or improve a user-level skill, prompt, extension/tool, role agent, or core harness behavior.
- Running learning/provider sweeps, skill audits, or Auto Learn review loops.

### Do Not Use For

- Product code implementation without a reusable harness lesson.
- Storing transient task progress, logs, or one-off status as durable learning.
- Package-managed skills/extensions unless the user explicitly asks to modify that package source.

## North Star

Retain a lesson where it can improve the next comparable task. Use memory for a
durable fact or preference, and a discoverable skill for a repeatable procedure.

## Core Sections

### Safety boundaries

- Do not reveal hidden chain-of-thought. Explain operational reasoning at a high
  level: inputs considered, instruction sources, tool evidence, and trade-offs.
- Do not copy proprietary source or prompts verbatim from external harnesses.
  Extract reusable patterns and reimplement them in Pi-native wording.
- Do not store transient task state in Automata Mind. Store only durable
  preferences, constraints, corrections, reusable fixes, stable locations,
  concise facts/pointers, or future ideas.
- Prefer a skill or prompt template for procedural guidance. Use an extension
  only when the behavior needs events, UI, tools, background work, or automatic
  runtime intervention.

### Introspection workflow

Use when the user asks why the agent behaved a certain way or wants an
`/introspect`-style analysis.

1. Identify the behavior or decision being analyzed.
2. List the instruction/context sources that plausibly influenced it:
   - system/developer instructions,
   - `AGENTS.md` and loaded skills,
   - Automata Mind memories,
   - user prompts,
   - tool outputs and repo files.
3. Explain the high-level decision path without hidden chain-of-thought.
4. Call out ambiguities, conflicts, missing context, or stale memory risk.
5. Recommend concrete improvements:
   - memory to record,
   - skill/prompt wording to refine,
   - extension/tool guardrail to add,
   - validation to create (a test only if the owner explicitly asked for tests).
6. If a durable lesson is clear, follow the Automata recording workflow before
   or after proposing harness changes.

### Learning-review and continuous-learning extensions

If the `learning-review` extension is loaded, use these commands for session-level
learning passes:

- `/learning-cues` shows recent user-correction/tool-error cues detected in the
  session.
- `/learning-cues clear` clears the cue status after review.
- `/learning-review [focus]` starts a dry-run review. It may inspect/query for
  overlap, but must not write Pi assets or record Automata memories.
- `/learning-review --apply [focus]` is the explicit approval path for minimal
  user-level Pi asset changes or Automata records when the durable lesson is
  clear and non-duplicative.

If the `continuous-learning` extension is loaded, prefer its indexed tools before
reading large raw histories or adding skills:

- `/learning-scheduler status|run|run-apply|run-dry|review|sweep|skills|smoke-test|e2e-test|e2e-test-apply|scheduler-test|enable|disable` manages the scheduled learning loop. Enabling the scheduler also enables autonomous high-confidence cue drain; use `run-dry` for proposals-only validation and `scheduler-test` to validate the actual timer path and fail-closed idle checks. `e2e-test-apply` remains dry-run unless `CONTINUOUS_LEARNING_ALLOW_PROD_TEST_WRITES=1` is set.
- `learning_provider_sweep` indexes Pi sessions plus `.codex`, `.claude`, and `.gemini` history conversations into capped learning candidates. Pass explicit `searchRoots` for recursive discovery; default sweeps avoid broad cwd recursion.
- `learning_run_auto` runs the deterministic executor. Its `applyHighConfidence` flag is the explicit approval path for trusted user-authored Automata records; otherwise it writes reports/proposals only.
- `learning_skill_audit` checks for trigger overlap, name collisions, and 90%-similar skills before creating or splitting skills.
- `learning_notify_agents` sends durable learning-update notices only to running background agents whose task/agent/cwd metadata matches the update tags. Non-dry tool delivery requires a recent outcome id with confirmed non-dry Automata changes; automatic rounds notify only after such changes.

### Longitudinal auto-evolution protocol

Use when improving Pi's tooling capabilities or agent behavior from stored chat
history. This is not single-session summarization.

1. Sweep indexed history first: Pi sessions plus `.codex`, `.claude`, `.gemini`,
   and other configured provider histories. Use bounded tools such as
   `learning_provider_sweep`; do not load raw histories wholesale.
2. Extract only improvement candidates about tooling capability, routing,
   validation behavior, skills/prompts, extensions/tools, memory use, or core
   harness limits.
3. Require longitudinal evidence before changing behavior: at least two trusted
   user-authored stored sources by default. The current session can explain
   urgency but must not be the only source for tooling/behavior evolution.
4. Cluster variants into one candidate, e.g. "forgot /cl", "missed changelog",
   and "broken release flow" become one release-workflow candidate.
5. Pick the smallest useful layer: Automata memory, skill, prompt template,
   role agent, extension/tool, then core source only when lower layers cannot
   solve it.
6. Automatic reflection is root-only: at most one durable cue is pending for
   the orchestrator and projected transiently into its next ordinary provider
   request. Accepting that request consumes the cue. Disabling reflection
   dismisses it; re-enabling cannot resurrect its evidence. Reflection never
   launches a second, background, or isolated model request. Workers do not
   reflect or mutate durable memory; they return evidence to the orchestrator.
7. An explicit `/auto-learn run` may launch one bounded background learner with
   the selected active/in-use model. Learners must share the Auto Learn state
   file, use per-session tenant leases, renew/complete their lease, and avoid
   colliding with learners from other sessions. A learner is a read-only worker
   (read, grep, find, ls): it never writes memory, skills, extensions, settings
   or source. It returns one bounded `<auto_learn_proposals>` block as untrusted
   evidence; its exit is the terminal signal, and the main session validates the
   block, applies eligible entries through its own owner paths, persists a
   bounded handoff record, and notifies the session. Entries it cannot apply
   (ineligible, malformed, extension or source changes) are recorded as
   findings, never as success.
8. Memory confrontation happens in the main session. If Automata/user memory is
   enabled and contains rules, preferences, corrections, or project facts, main
   checks every learner memory proposal against it at apply time, so duplicates
   and conflicts are held as proposals instead of written.
9. Apply policy gates: memory may be auto-applied only after overlap checks;
   safe low-risk user-level skill/prompt changes may be applied when the current
   request or standing grant authorizes self-improvement. A direct request to
   fix or improve the harness is authorization for scoped source changes; do
   not ask for duplicate approval at each layer transition. Settings,
   credentials, destructive actions, executable authority expansion,
   publishing, pushing, tagging, and releases still require specific approval.
10. Leave an audit artifact with evidence sources, recurrence count, chosen
   layer, action/approval need, expected benefit, risk, and validation.

### After-action learning workflow

Use after overcoming a nontrivial challenge, repeated failure, confusing tool
behavior, bad assumption, or user correction.

1. Summarize the challenge in one or two evidence-backed sentences.
2. Separate outcomes into buckets:
   - **Memory**: durable preference/rule/correction/fact/idea for Automata.
   - **Skill**: repeatable procedure or domain-specific workflow.
   - **Prompt template**: reusable one-shot prompt such as review, debug, or
     introspection.
   - **Extension**: event-driven behavior, UI, custom tool, background watcher,
     or safety gate.
   - **No action**: transient state or already-covered guidance.
3. Query Automata Mind for overlap before recording:

   ```bash
   automata-mind query --topic "<topic>"
   ```

4. Record with the narrowest appropriate command:

   ```bash
   automata-mind record preference --user default --category <category> --key <key> --value <value> --reason <reason>
   automata-mind record rule --project <project> --category <category> --rule <rule> --reason <reason>
   automata-mind record correction --session <session> --doing <doing> --wrong <wrong> --should <should> --category <category> --severity <severity> [--project <project>]
   automata-mind record idea --help
   ```

5. If a skill/prompt/extension should change, make the most important evidence-backed user-level change and validate it. Do not default to preserving existing daily workflows; rewrite, merge, or retire them when evidence shows that is the better evolution. Do not alter project-local config unless requested.
6. For peer-validation tasks, do not treat review as complete until bridge replies or non-responses are captured in artifacts, each peer finding has a fixed/deferred disposition with validation evidence, final peer PASS/no-blockers is recorded when available, and `update_task` is called only after those artifacts are saved.
7. Report exactly what was stored or changed, with file paths.

### Turning a lesson into a skill

Describe the outcome in the words a user or delegating agent would use to find
it. Search the existing skills for that job. If one fits, refine it in its
owning scope. Use `skill-architect` for the instructions and review criteria,
and `skill-creator` for the package, worker eligibility and validation.

### Pi-native implementation guide

- Prompt templates: `~/.pi/agent/prompts/*.md`; good for explicit slash-command
  workflows with arguments.
- Skills: `~/.pi/agent/skills/<name>/SKILL.md`; good for specialized procedures
  that should load on demand.
- Extensions: `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/<name>/index.ts`;
  good for commands, tools, UI widgets, event hooks, or background automation.
- Role agents: `~/.pi/agent/agents/*.md`; good for reusable delegated worker
  personas with bounded file ownership and validation expectations.

### Session-bounded UX/state mandate for Pi assets

When changing or creating Pi extensions, tools, role agents, skills, task lists,
agent-runtime surfaces, notifications, or TUI widgets:

- Default all live state to the creating session tenant. Same-folder sessions must
  not display, mutate, or receive another session's live stack/tasks/agents/tools
  unless the user explicitly requested a shared/user-global surface.
- Detached/background work may survive the foreground session, but it must retain
  an owner-session pointer and report completion/status through that owner-scoped
  state/artifacts, not by broadcasting into unrelated sessions opened in the
  same cwd.
- Compact TUI must be minimal, grouped, and width-aware. For team work, show only
  grouped team/owner names with clear markers/separators in a single line; never
  list every worker/task in the compact widget. Full task/worker data belongs in
  a slash command/panel or explicit `verbose=true` tool output.
- Routine completion notifications must be grouped/debounced by team/owner and
  delivered through immediate TUI/status updates plus durable state. Avoid
  delayed transcript messages for routine completions because they can arrive
  after later user input and mislead the user.
- Validate these invariants by reading the code and, only when the owner asked for
  tests, with same-cwd/two-session tests and width-constrained render tests, whenever
  the asset touches UI, notifications, task state, agents, tools, or background processing.

## Anti-Patterns

Copying one user's repository rule into a bundled skill turns a local preference
into a default for other projects. Keep that rule in its authorized scope.

## Examples

A comment-audit skill declares an external write for filing issues. Pi filters
it out of the worker's skill list even though the audit and repair happen in
the checkout. Capture the eligibility lesson in skill authoring and have the
comment skill return the issue draft to the parent for authorized filing.

## Self-Check

Identify the evidence, why this owner fits and how to find the result again.
Use this format for a learning pass.

```text
Learning pass:
- Memory: <stored/skipped + reason>
- Skill/prompt/extension: <changed/proposed/skipped + path>
- Evidence: <key files, commands, or user correction>
- Next harness idea: <optional>
```

## Known Gaps

Stored history and the active tool surface vary by session. Report which sources
were available and distinguish a proposed improvement from an applied edit.
