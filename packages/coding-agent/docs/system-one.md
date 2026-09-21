# System One

System One is the objective controller: while a goal is active it owns CONTROL, decides the next
transition and is the only thing that can say the objective is done. Jev is its semantic evaluator, a
judge over supplied state, never an authority and never a model chooser. The root model and the
workers execute what System One routes.

## Loop modes

`systemOne.loopMode` (settings) or the SDK's `executionLoopMode`:

- `objective_primary` (default whenever System One is bound): each continuation pass evaluates one
  objective route and executes it. The route comes from deterministic facts (cancellation, budget,
  running attempts, the ledger's stall reading) and Jev's judgments (`objective-route-v2`: task
  kind, work remaining, missing work class, worker can continue, independent worker required,
  capability escalation, external blocker, progress, context stale, strategy repetition).
- `objective_shadow`: the legacy continuation drives; the route is evaluated for disagreement
  telemetry only.
- `legacy_goal` (default without System One): the legacy continuation alone.

## Routes and executors

| Route | Executor |
|---|---|
| `implement`, `investigate`, `replan` | one root turn carrying the route brief (`System One route: … (reasons). Target requirements: …`) |
| `retrieve`, `deterministic_test`, `verify` (not independent) | the root, unless a dedicated retrieval or verifier executor is bound |
| `verify` (independent), `review`, `escalate_capability` | a worker chosen by expert selection, or a synthesized specialist or capability |
| `continue_current_worker` | the running worker |
| `wait_for_worker`, `wait_for_tool` | wait on the running attempts' agents (the goal's worker-wait bound) |
| `completion_candidate` | the completion coordinator with the assurance profile (`systemOne.completionProfile`, default `semantic_enhanced` under a plane, `mechanical` without) |
| `owner_required`, `blocked_external`, `cancel`, `unrecoverable` | terminal: the goal follows it |

The goal follows the objective's terminal: `complete` completes the goal when every requirement is
satisfied and otherwise blocks it naming the unsatisfied ones; `cancelled` cancels; `budget_exhausted`
marks it budget-limited; every other terminal blocks with its reason codes. A continuation pass stops
on a wait, a terminal, the turn or wall-clock limit, or two cycles that executed nothing.

## Levers

System One has the operator's two levers over every executor, and every directive is an operator
event:

- **Cancel** fires immediately: the running turn aborts under `system_one:<reason>`, like Esc. A
  worker's lane is cancelled.
- **Steer** is either queued for the next model turn (a running worker takes it mid-run, an idle one
  wakes on it) or delivered now: the root's turn is interrupted and the queue sent once the foreground
  is idle; a worker's attempt is interrupted, the directive queued on its mailbox, and the attempt
  resumed.

The tool gate does not pull the cancel lever: a `replan` verdict refuses that one call (the rest of
the batch and the operator's turn continue; the verdict is ledger evidence the objective loop routes
on at its next cycle), records the event as `refused` (never `allowed`), and a `confirm` verdict
queues a scope steer and allows the call. After the call runs, the same `call_id` is updated to
`succeeded` or `failed` so postflight sees the terminal, not admission. Relevance is judged only
against a real plan step or goal; a plain session with no objective is never asked whether a call is
relevant to nothing, and preflight/postflight Jev packs are skipped when there is no live objective.
Inside the objective loop a System One cancel of the root's own turn is a re-route (the next cycle
routes again); only the operator's interruption stops the loop. The worker supervisor redirects a
worker judged off the mission now, steers a stalled one at its next turn, and reroutes a repeated
stall.

Preflight outcomes other than `allow` skip the current root turn and become the next
`composeObjectiveRoute` input (`retrieve`, `replan`, `deterministic_test`, `escalate_capability`,
`blocked_external`). Postflight outcomes similarly select the next route (`verify`, `retrieve`,
`replan`, `completion_candidate`, `blocked_external`); they are not discarded.

`objective_primary` without a live `ObjectiveExecutionController` fails closed and names that
binding; it never continues on the legacy loop. Under `system_one_required`, a required steering
checkpoint must come from calibrated Jev or mechanical `none` — `synthetic_self_report` cannot
satisfy it.

Every System One stage hydrates `ExecutionStore` from the live goal, durable task evidence and open
verification obligations before it evaluates. That store is a projection, not a second authority.
Completion cannot pass an empty or disconnected objective, empty required criteria on a real
objective, or unresolved verification.

Production owners: SteeringPlane JEV-001..003 for admission, JEV-004 for routing, JEV-024/025/026
for completion, JEV-041.. for semantic dedup. `SystemOneController` stage packs for intake, claim
check, duplicate logic, patch review and drift remain callable for tests/hooks; they are not a
second production control path.

## The decision ledger

`state/decision-ledger.sqlite` (one per agent directory, keyed by session id and working directory,
append-only) holds every stage transition, every Jev evaluation and every route with its executor. The
objective's recent routes are a history block in the state the judge reads; "repeated without new
evidence" is one route on one evidence marker, twice. The root reads the ledger with
`decision_ledger_read` (`sessions`, `stages`, `evaluations`, `replay`); workers never do.

## Verification

Pinned by the [primary loop tests](../test/goal-session-primary-loop.test.ts), the [session objective
runtime tests](../test/session-objective-runtime.test.ts), the [foreground control tests](../test/system-one-foreground-control.test.ts),
the [worker control tests](../test/system-one-worker-control.test.ts) and the
[ledger route tests](../test/ledger-route-checkpoints.test.ts); see `docs/doctrine.md`, section
"System One".
