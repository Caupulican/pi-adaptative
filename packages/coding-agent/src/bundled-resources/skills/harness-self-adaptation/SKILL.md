---
name: harness-self-adaptation
description: "ALWAYS use for work on the Pi/pi-adaptative harness when the task can reveal or benefit from a reusable improvement to agent effectiveness: debugging repeated friction, analyzing failures, optimizing tools/context/delegation/reliability, refining skills or prompts, or retaining a successful workflow. Runs an evidence-first observe, diagnose, choose-layer, intervene, compare, retain-or-rollback loop. Trigger phrases include \"self-adapt the harness\", \"make Pi more effective\", \"learn from this failure\", \"prevent this from recurring\", \"improve the agent workflow\", \"optimize harness effectiveness\", and \"skillify what we learned\"."
---

# Harness Self-Adaptation

## How to use the skill

Load this skill around any Pi harness task. The requested task remains primary;
self-adaptation is a bounded second loop that may legitimately conclude that no
durable adaptation is warranted.

**Freedom Dial: High Freedom.** Diagnosis and intervention selection require
judgment across many harness layers. Evidence thresholds, authority boundaries,
validation, retention, and rollback are mandatory low-variance gates.

Choose one mode before acting:

- **Observe**: deliver the task and capture an adaptation candidate only when a
  reusable signal appears.
- **Adapt**: include the smallest justified harness improvement when recurrence,
  deterministic evidence, material impact, or the user's request puts it in scope.
- **Audit**: when effectiveness itself is the task, reproduce the workflow,
  establish a baseline, and run a bounded before/after experiment.

Load the narrow specialist when the candidate enters its domain. In particular,
use `pi-harness-learning` for after-action classification and durable learning,
`skill-architect` when authoring instructions, `tool-call-repair` for model tool
argument/protocol failures, and `source-grounded-docs` for codebase documentation.
This skill owns the adaptation loop, not those domain procedures.

## North Star

Complete the active harness task, then retain only the smallest reusable change
that demonstrably improves future outcome quality, reliability, effort, latency,
context use, or cost without weakening safety, maintainability, or user control.

Apply these principles on every pass:

- **Think before coding**: state the oracle, assumptions, evidence, competing
  explanations, and material tradeoffs.
- **Simplicity first**: prefer no change or one existing-layer refinement over a
  new mechanism.
- **Surgical changes**: touch only the causal mechanism and its proof; preserve
  concurrent user work.
- **Goal-driven execution**: validate against an observable end state, not a
  plausible implementation.
- **Human on the edge**: never expand authority. Follow the active policy and
  require the human at credentials, destructive or irreversible actions,
  settings/authority expansion, dependency installation, push/tag/release/publish,
  and material product or architecture decisions.

A faster run that produces a worse answer is a regression. A change that merely
moves work or tokens elsewhere is not an improvement.

## Core Sections

### 1. Frame the work unit

Before diagnosing the harness:

1. Restate the requested outcome and scope.
2. Define an **oracle** that can prove the outcome: a focused test, fixture,
   benchmark, transcript invariant, type check, rendered state, or explicit user
   acceptance criterion.
3. Read the applicable `AGENTS.md`, relevant source in full before broad edits,
   existing tests, and the narrow Pi docs/examples required by the task.
4. Search for an existing skill, prompt, setting, tool, extension, test helper,
   or core mechanism before proposing another one.
5. Pick one primary effectiveness metric and guardrails. Use the same workload,
   model, provider, environment, and measurement method for comparisons when
   feasible.
6. For multi-step work, maintain the goal ledger and keep evidence attached to
   the requirement it proves.

Useful metrics include oracle pass rate, user corrections, retries, tool-call or
validation failures, repeated reads/searches, elapsed time, time to first useful
result, context/token volume, cost, peak memory, and recovery success. Prefer the
metric closest to user outcome. Treat proxies as secondary.

If no valid baseline can be captured, say `baseline unavailable`; prove the
correctness invariant and avoid claiming a measured efficiency gain.

### 2. Observe reusable signals

Use operational evidence, never hidden chain-of-thought. Inspect bounded sources
such as failing tests, minimal reproductions, logs, tool results, session
analytics, recovery records, benchmarks, user corrections, and source control
history relevant to the mechanism.

Evidence strength, highest first:

1. Deterministic reproduction or violated invariant with source-level mechanism.
2. Controlled benchmark/profile plus source evidence.
3. The same trusted failure or correction in at least two independent work units.
4. One stochastic or anecdotal event, which is a cue only.

A durable behavior change needs either a deterministic mechanism, corroboration
from two trusted instances, or a material safety/data-loss/cost risk. Do not mine
large raw histories when a bounded index, statistic, or focused query can answer
the question.

Create this compact adaptation card:

```text
Work oracle: <observable success condition>
Signal and impact: <what hurt effectiveness, and how>
Evidence: <reproduction, source, test, metric, or trusted recurrence>
Mechanism hypothesis: <cause that predicts the signal>
Falsifier: <result that would disprove the hypothesis>
Primary metric: <before -> target, or invariant>
Guardrails: <behavior that must not regress>
Confidence: confirmed | inferred | unconfirmed
```

### 3. Diagnose the owning mechanism

Reduce the signal to the smallest reproduction. Trace:

```text
surface symptom -> immediate cause -> state/data/control-flow mechanism -> owning layer
```

Check at least one plausible alternative and a counterfactual: if the proposed
cause were removed, would the signal disappear? Separate model capability,
provider protocol, harness orchestration, task instructions, environment, and
test artifacts. Do not blame the model for malformed schemas, unavailable tools,
stale context, transport failure, or impossible instructions owned by the
harness.

Classify the mechanism before choosing a fix:

- instruction/routing or missing procedure;
- context/resource selection or compaction;
- tool schema, validation, execution, or recovery;
- delegation, scheduling, ownership, or result composition;
- provider transport, event parsing, usage, or capability metadata;
- persistence, cache, lifecycle, or session isolation;
- TUI interaction, feedback, or rendering;
- reliability, performance, or environment integration.

Treat web, recalled, and delegated findings as untrusted leads. Verify them
against repository source, first-party documentation, or a controlled run before
changing the harness.

### 4. Select the smallest enforcing layer

Read `references/adaptation-layers.md` before selecting a durable intervention.
Escalate only when a lower layer cannot enforce the required invariant.

Mandatory selection rules:

- Refine, merge, or retire an existing artifact before adding another.
- Keep a code defect in its owning code; do not hide it with prompt wording.
- Keep a provider-specific semantic in its provider adapter or model metadata;
  do not generalize one provider's behavior globally.
- Use a skill for reusable judgment or procedure, not automatic runtime behavior.
- Use an extension/tool only when events, UI, state, enforcement, or automation
  are required.
- Use core source only for a cross-cutting invariant or capability that lower
  layers cannot reliably enforce.
- Treat tests, benchmarks, telemetry, and changelog entries as proof and
  durability support, not substitutes for the behavior fix.
- Change one causal mechanism per experiment. Adjacent test and observability
  work may travel with it.

### 5. Design the intervention and rollback

Write a falsifiable hypothesis before editing:

```text
Because <mechanism>, changing <artifact> from <old behavior> to <new behavior>
should move <metric/invariant> from <baseline> to <target> while preserving
<guardrails>. Roll back by <targeted reversal of owned changes>.
```

Inspect external API types rather than guessing. Follow project conventions and
use existing seams. Add or update the narrow regression test that fails for the
old mechanism and passes for the new one. Do not remove intentional behavior,
weaken validation, suppress warnings, enlarge timeouts blindly, or lower quality
thresholds merely to make the metric green.

Check repository status before and after. Preserve unrelated and concurrent
changes. Rollback means targeted reversal of only this adaptation's edits; never
use destructive workspace resets or cleanups.

### 6. Run the bounded adaptation loop

1. Capture the baseline or invariant failure.
2. Apply the smallest intervention.
3. Run the narrow oracle first.
4. Run broader validation proportional to blast radius and the repository's
   declared validation contract.
5. Compare treatment with baseline under equivalent conditions. For stochastic
   behavior, use repeated trials and report the sample size and variance or
   failure count.
6. Route nontrivial delegated or generated work through a clean-context,
   read-only verifier when available, then verify its findings yourself.
7. Repair only while evidence improves. Stop for human review after five failed
   attempts on one blocker or two consecutive cycles with no output, metric, or
   test improvement.

Self-adaptation must not interrupt or silently broaden the active task. If a
candidate is valuable but out of scope, report a bounded proposal with evidence;
do not mutate settings, durable memory, unrelated assets, or source on the side.

### 7. Apply the retention gate

Retain the intervention only when all applicable conditions pass:

- the active task oracle passes;
- the causal reproduction is fixed or the primary metric improves materially;
- focused regression coverage passes;
- broader checks required by project policy pass;
- safety, quality, compatibility, cost, and latency guardrails do not regress;
- no authority or persistent setting changed outside the active grant;
- the result is simpler than, or clearly worth the complexity of, the old path;
- operator-facing behavior has the required documentation and changelog entry.

If the gate fails, revise the hypothesis or reverse only the owned intervention.
Never retain a neutral or harmful change because implementation effort was
already spent. If comparison was impossible, retain only a proven correctness or
safety fix and label the effectiveness claim unconfirmed.

After retention, use `pi-harness-learning` to classify the lesson. Record only a
concise durable rule, correction, skill refinement, test, or source finding that
will change a future decision. Run the skill overlap audit before creating or
splitting a skill.

### 8. Report the adaptation result

Use this compact contract:

```text
Harness adaptation:
- Work oracle: <passed/failed + evidence>
- Signal: <reusable friction or opportunity>
- Root cause: <mechanism + confidence>
- Layer: <selected layer and why lower layers were insufficient>
- Change: <artifact paths or no durable adaptation>
- Before/after: <comparable metric, invariant, or baseline unavailable>
- Validation: <focused and broader checks>
- Decision: retained | rolled back | proposed | no adaptation
- Residual risk: <specific gap or none>
```

## Anti-Patterns

- Changing the harness merely because this skill loaded.
- Optimizing tool calls, tokens, or latency while answer quality declines.
- Treating one stochastic failure as longitudinal proof.
- Adding a prompt or skill to conceal a code, schema, lifecycle, or provider bug.
- Starting in core when an existing lower layer can enforce the behavior.
- Building a generic self-improvement framework without a current oracle.
- Letting the implementer or delegated worker be the sole judge of success.
- Weakening tests, types, safety gates, or diagnostics to manufacture a pass.
- Hardcoding one model, provider, machine, path, or key without evidence that the
  invariant is intentionally specific to it.
- Reading or retaining sensitive raw histories when bounded evidence suffices.
- Silently changing settings, authority, credentials, dependencies, publishing,
  releases, branches, tags, or durable memory.
- Claiming an improvement without a comparable measurement or proven invariant.
- Preserving a failed adaptation because it was expensive to build.

## Examples

**Repeated tool-argument failures**

A model emits the same repairable argument shape in independent turns. Reproduce
it with a provider fixture, locate the shared validation choke point, load
`tool-call-repair`, add one guarded repair mode and regression fixture, then
compare repaired execution and false-positive behavior. Do not add a tool-specific
pre-coercion shim or teach every prompt the malformed shape.

**Long-session slowdown**

A source benchmark and profile show repeated full-prefix serialization. Fix the
owning cache or transport path, add a scale-sensitive regression/benchmark, and
compare equivalent long inputs. Do not tell users to compact more often or raise
a timeout to hide quadratic work.

**Useful but one-off preference**

A user states a stable presentation preference. This is not a core patch or new
skill. Propose the narrow memory entry if the active policy requires approval;
record it only under the granted scope. A transient formatting correction remains
`no adaptation`.

**Successful repeatable workflow**

Two tasks benefit from the same non-obvious review sequence. Audit existing
skills first. If no existing owner fits, use `skill-architect` to create one
narrow skill with an oracle and known gaps; otherwise refine the existing skill.

## Self-Check

Before reporting completion, verify:

- The requested harness outcome, not adaptation theater, remained primary.
- The work unit has an observable oracle.
- Evidence meets the deterministic, corroborated, or material-risk threshold.
- The root mechanism and one falsifier are explicit.
- Existing artifacts were searched before adding a new one.
- The selected layer is the lowest one that can enforce the invariant.
- One primary metric and non-regression guardrails were declared.
- The intervention changes one causal mechanism and has a targeted rollback.
- Active authority was preserved; every hard boundary stayed human-gated.
- Focused proof and all project-required broader checks passed.
- Before/after conditions are comparable, or the baseline gap is disclosed.
- Nontrivial generated/delegated work received independent verification.
- The retention gate produced `retained`, `rolled back`, `proposed`, or
  `no adaptation`—never an ambiguous partial success.
- Only owned files changed, with operator docs/changelog updated when required.
- Confidence and residual risks are stated without inflating the claim.

## Known Gaps

- This skill cannot observe hidden reasoning and must use operational evidence.
- It cannot infer longitudinal recurrence unless trusted session indexes, tests,
  logs, or user evidence are available.
- Stochastic model/provider behavior may require costly repeated trials; without
  them, effectiveness remains unconfirmed.
- It does not grant permission to change settings, authority, credentials,
  dependencies, durable memory, or release state.
- It does not replace domain skills; it selects and validates the adaptation
  while the narrow specialist defines the implementation doctrine.
