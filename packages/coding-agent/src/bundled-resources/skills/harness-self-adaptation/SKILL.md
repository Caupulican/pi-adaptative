---
name: harness-self-adaptation
description: "Audit and repair recurring friction in the Pi harness, including unnecessary owner steering, premature stops, repeated work and failures across memory, routing or delegation. Use when asked to improve harness effectiveness or retain a workflow supported by observed failures."
---

# Harness Self-Adaptation

## How to use the skill

Use the owner's requested outcome to choose the depth of the audit. A routine harness edit can proceed directly. An observed failure can justify a focused repair in the same task.

- **Observe**: deliver the task and capture an adaptation candidate only when a
  reusable signal appears.
- **Adapt**: include the smallest justified harness improvement when recurrence,
  deterministic evidence, material impact, or the user's request puts it in scope.
- **Audit**: when effectiveness itself is the task, establish a baseline from
  available evidence. Compare outcomes when comparable observations exist or a
  new experiment is authorized. Identify any effect that remains unmeasured.

Load the narrow specialist when the candidate enters its domain. In particular,
use `pi-harness-learning` for after-action classification and durable learning,
`skill-architect` when designing instructions, `skill-creator` when packaging a
Pi skill, and `tool-call-repair` for model tool argument or protocol failures.
For codebase documentation, cite the implementation or recorded run supporting each behavior claim.
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
- **Authority**: apply the active policy to the specific action, target, and
  conditions. Reuse a matching current grant. Ask when a necessary grant or
  decision is missing, or when the policy requires fresh confirmation.

A faster run that produces a worse answer is a regression. A change that merely
moves work or tokens elsewhere is not an improvement.

## Core Sections

### 1. Frame the work unit

Before diagnosing the harness:

1. Restate the requested outcome and scope.
2. Define an **oracle** that can prove the outcome: a fixture, benchmark,
   transcript invariant, type check, rendered state, or explicit user acceptance
   criterion. Choose evidence for the claim under review. Keep regression
   coverage with the change. Local test execution requires an explicit request
   for the current task. CI and the maintainer’s live gate have separate scopes.
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

When the owner asks how often they have to steer, count follow-ups to visible
agent replies. Check the original request, the reply and the correction. Count
repeated instructions, avoidable handoffs and corrections of a demonstrated
mistake. Record new scope, genuine decisions and ambiguous nudges separately.
For several clients, report each client's reviewed numerator and denominator,
dates and coverage. Exclude worker traffic, copied turns and fixtures. Input
history alone can establish wording; a correction rate needs the exchange.
For a repeatable sample, rank eligible follow-ups per client by a fixed hash of
the client, session and turn index. Save the method, date range, source digest,
rank and per-turn verdict in the existing audit database. Derive the totals from
those rows. Keep backup cohorts separate and omit raw messages and session paths
from shared reports.

For a recovery audit, grade the answer the owner received and read the
completion state for the same request. Record both when they disagree. Compare
the evidence served to the foreground, the stop judge and the independent
grader. Identify reconstructed inputs. When testing a change to judgment,
include a correct answer, a superseded correction, an unrelated or incomplete
result, and a revoked request. Label a replay of a recorded decision separately from a fully live run.

When a remembered preference appears in a provider prompt but the answer ignores it,
inspect the classification stored for that exact revision and the requirements exposed
to the reviewer on that turn. Record whether the independent review actually ran,
what action the host reserved and what the owner received. A successful classifier
request can persist an uncertain result. Replaying the reviewer alone skips that failure.

If no valid baseline can be captured, say `baseline unavailable`; prove the
correctness invariant and avoid claiming a measured efficiency gain.

Match verification to the active grant. A local-only audit can use historical
exchanges and static checks. Record pending CI or live evidence for any claim
that depends on it. Publishing a revision or launching trials requires its
own authorization.

### 2. Observe reusable signals

Use operational evidence, never hidden chain-of-thought. Inspect bounded sources
such as failing checks or CI journeys, minimal reproductions, logs, tool results, session
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
Evidence: <reproduction, source, check or CI journey, metric, or trusted recurrence>
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

For a reported autonomy delay, trace the first handoff or repeated judgment.
Record the decision, the evidence already available, and what the extra turn
contributed. If the agent could choose either reversible method within its
authority, check whether the handoff delayed the first useful edit. If a
requirement, permission or material fact was missing, identify which step
supplied it. Use the same completion criterion when comparing traces.

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
- Treat the repository's static checks, the CI-run journeys, the owner-run live
  gate, benchmarks, telemetry, and changelog entries as proof and durability
  support, not substitutes for the behavior fix.
- Change one causal mechanism per experiment. Keep related observability and
  regression coverage with the fix.

### 5. Design the intervention and rollback

Write a falsifiable hypothesis before editing:

```text
Because <mechanism>, changing <artifact> from <old behavior> to <new behavior>
should move <metric/invariant> from <baseline> to <target> while preserving
<guardrails>. Roll back by <targeted reversal of owned changes>.
```

Inspect external API types rather than guessing. Follow project conventions and
use existing seams. Use the public path that exercises the mechanism. The
repository’s static gate is `npm run check:static`. When reporting a release,
use the CI result for that revision and the applicable maintainer gate
(`npm run accept:harness-live`). Do not remove intentional behavior,
weaken validation, suppress warnings, enlarge timeouts blindly, or lower quality
thresholds merely to make the metric green.

Check repository status before and after. Preserve unrelated and concurrent
changes. Rollback means targeted reversal of only this adaptation's edits; never
use destructive workspace resets or cleanups.

### 6. Run the bounded adaptation loop

1. Capture the baseline or invariant failure.
2. Apply the smallest intervention.
3. Check the narrow oracle within the current grant.
4. Check the interacting paths the change affects. For an unpublished
   checkout, identify the source tested. Record any outstanding release gates
   alongside claims that depend on them.
5. Compare treatment with baseline under equivalent conditions. For stochastic
   behavior, use repeated trials and report the sample size and variance or
   failure count.
6. Check the artifacts against the oracle. Apply the independent review required
   by the owner or host. If a material claim still needs a separate judgment,
   give a read-only reviewer that question and inspect the evidence it returns.
7. Repair only while evidence improves. Stop for human review after five failed
   attempts on one blocker or two consecutive cycles with no output, metric, or
   check improvement.

Self-adaptation must not interrupt or silently broaden the active task. If a
candidate is valuable but out of scope, report a bounded proposal with evidence;
do not mutate settings, durable memory, unrelated assets, or source on the side.

### 7. Apply the retention gate

Retain the intervention only when all applicable conditions pass:

- the active task oracle passes;
- the causal reproduction is fixed or the primary metric improves materially;
- evidence supports the claimed behavior on the identified source, and
  applicable release gates pass before claiming release readiness;
- safety, quality, compatibility, cost, and latency guardrails do not regress;
- no authority or persistent setting changed outside the active grant;
- the result is simpler than, or clearly worth the complexity of, the old path;
- operator-facing behavior has the required documentation and changelog entry.

If the gate fails, revise the hypothesis or reverse only the owned intervention.
Never retain a neutral or harmful change because implementation effort was
already spent. If comparison was impossible, retain only a proven correctness or
safety fix and label the effectiveness claim unconfirmed.

After retention, use `pi-harness-learning` to classify the lesson. Record only a
concise durable rule, correction, skill refinement, check, or source finding that
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
`tool-call-repair`, add one guarded repair mode, prove it with the static checks
and the CI journeys, then
compare repaired execution and false-positive behavior. Do not add a tool-specific
pre-coercion shim or teach every prompt the malformed shape.

**Long-session slowdown**

A source benchmark and profile show repeated full-prefix serialization. Fix the
owning cache or transport path, measure with a scale-sensitive benchmark, and
compare equivalent long inputs. Do not tell users to compact more often or raise
a timeout to hide quadratic work.

**Useful but one-off preference**

A user states a stable presentation preference. This is not a core patch or new
skill. Propose the narrow memory entry if the active policy requires approval;
record it only under the granted scope. A transient formatting correction remains
`no adaptation`.

**Successful repeatable workflow**

Two tasks benefit from the same non-obvious review sequence. Audit existing
skills first. If no existing owner fits, use `skill-architect` to design one and
`skill-creator` to scaffold and validate it as a
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
- Each action used its active grant or the confirmation required by policy.
- Each verification claim names the checkout or released revision and the
  checks that ran. Outstanding checks and their effect on the rating are visible.
- Before/after conditions are comparable, or the baseline gap is disclosed.
- The evidence covers the claimed outcome and any required independent review.
- The retention gate produced `retained`, `rolled back`, `proposed`, or
  `no adaptation`—never an ambiguous partial success.
- Only owned files changed, with operator docs/changelog updated when required.
- Confidence and residual risks are stated without inflating the claim.

## Known Gaps

- This skill cannot observe hidden reasoning and must use operational evidence.
- It cannot infer longitudinal recurrence unless trusted session indexes, CI
  journey history, logs, or user evidence are available.
- Stochastic model/provider behavior may require costly repeated trials; without
  them, effectiveness remains unconfirmed.
- It does not grant permission to change settings, authority, credentials,
  dependencies, durable memory, or release state.
- It does not replace domain skills; it selects and validates the adaptation
  while the narrow specialist defines the implementation doctrine.
