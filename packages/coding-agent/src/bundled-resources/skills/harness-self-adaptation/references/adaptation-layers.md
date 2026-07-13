# Adaptation Layer Selection

Use this reference after diagnosing the owning mechanism and before proposing a
durable change. The order is a pressure toward the smallest enforcing layer, not
a reason to hide a defect below its owner.

## Decision rule

Ask these questions in order:

1. Is the signal transient, already covered, or unsupported by reproducible or
   corroborated evidence? Use **no durable change**.
2. Is it a stable user/project fact, preference, correction, or constraint? Use
   **memory**, subject to the active memory-write policy.
3. Is it an explicit one-shot workflow the user chooses to invoke? Use a
   **prompt template**.
4. Is it reusable judgment or a procedure that should be loaded by task context?
   Refine or create a **skill**.
5. Is it a repeatable delegated role with a bounded tool and file surface? Use a
   **role/worker profile**.
6. Is it a user-selected policy, resource set, model route, or operating mode?
   Use a **setting/resource profile**, subject to approval and authority policy.
7. Does it need runtime enforcement, a new tool, events, UI, state, background
   work, or automatic intervention? Use an **extension/tool**.
8. Is a shared harness invariant, lifecycle, orchestration, persistence,
   reliability, performance, or safety mechanism wrong or missing? Change
   **core source**.
9. Is the behavior specific to a provider wire protocol, event stream, usage
   semantics, authentication flow, or model capability? Change the **provider
   adapter/model metadata** rather than global core behavior.

A regression test, benchmark, fixture, or telemetry counter accompanies the
owning layer. It is evidence, not a replacement behavior layer.

## Layer matrix

| Layer | Use when | Typical artifact | Required proof | Reject when |
| --- | --- | --- | --- | --- |
| No durable change | One-off, transient, already covered, or weak evidence | Task report only | Active task oracle | A deterministic defect or trusted recurrence exists |
| Memory | Stable fact, preference, correction, constraint, or concise pointer | User/project memory record | Overlap query plus future-decision relevance | The content is a procedure, runtime behavior, secret, log, or transient status |
| Prompt template | User explicitly invokes a reusable one-shot transformation | `prompts/*.md` | Expansion/invocation example | Routing should be contextual or behavior automatic |
| Skill | On-demand procedure, judgment, review doctrine, or domain constraints | `skills/<name>/SKILL.md` plus references | Discovery, trigger separation, example, self-check, overlap audit | A code defect or runtime enforcement is required |
| Role/worker profile | Repeatable isolated role with bounded authority and validation | Agent/profile definition | Capability/UAC test and independent result validation | A simple skill suffices or authority would broaden |
| Setting/resource profile | User policy, resource selection, route, or operating mode | Settings/profile state | Round-trip, reload, precedence, and rollback tests | It papers over incorrect implementation or changes authority silently |
| Extension/tool | Runtime event, tool API, UI, state, automation, or enforcement | Extension/tool source | Focused behavior test, lifecycle cleanup, permission check | Static instructions can reliably solve it |
| Core source | Cross-cutting invariant or mechanism no lower layer can enforce | Agent/AI/coding-agent/TUI source | Regression plus package validation and blast-radius review | A lower existing seam owns the behavior |
| Provider adapter/model metadata | Provider-specific protocol, usage, auth, stream, or capability semantics | Provider source, fixtures, generated metadata source | Captured/first-party evidence and provider regression fixture | Evidence comes from only a different provider or serving stack |

## Metric selection

Choose one primary metric nearest to user value and keep diagnostic metrics
secondary.

| Goal | Prefer | Guard against |
| --- | --- | --- |
| Better outcomes | Oracle pass rate, fewer user corrections, task completion | Longer hidden retries, unsafe shortcuts |
| Better reliability | Failure/recovery rate, bounded retry success, no leaked state | Masked errors, infinite fallback ladders |
| Faster work | End-to-end elapsed time, first useful result | Lower answer quality or skipped validation |
| Lower context/cost | Provider-bound tokens/bytes, paid cost, cache reuse | Moving tokens to workers or losing required context |
| Better tool use | Valid execution rate, fewer repair bounces, correct side effects | Over-broad coercion or schema weakening |
| Better delegation | Useful accepted results, queue latency, bounded context/cost | Late transcript injection, excess authority, duplicate work |
| Better maintainability | Smaller causal diff, reduced duplication, clear ownership | Abstraction count as a proxy for quality |

When a metric can shift work between foreground, workers, caches, retries, or
persistence, measure the whole system boundary rather than one component.

## Evidence and trial notes

- Keep baseline and treatment inputs equivalent. Record unavoidable differences.
- Warm caches consistently or report cold and warm runs separately.
- For performance claims, choose input sizes that expose complexity and report
  absolute values as well as ratios.
- For model behavior, use multiple trials and preserve provider/model/protocol
  identity; serving-stack behavior is part of model identity.
- A deterministic correctness or safety invariant can justify retention without
  a numeric speedup. Label any unmeasured efficiency benefit as unconfirmed.
- Do not tune the oracle after seeing the treatment result.

## Escalation examples

- Missing release steps in repeated reviews: refine the release skill; do not add
  a core hook unless runtime enforcement is required.
- Tool arguments arrive as a stringified object: repair at shared validation with
  strict guards; do not edit every tool or model prompt.
- A provider reports nested terminal errors: fix that provider's parser and add a
  captured fixture; do not change global retry semantics first.
- Old extension listeners survive reload: fix lifecycle ownership in extension
  runtime/core and test teardown; a skill warning cannot enforce cleanup.
- One user prefers terse summaries: memory or no change; not a bundled default.
