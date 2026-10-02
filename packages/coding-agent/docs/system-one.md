# System One

System One is the provider-neutral semantic judgment system. Jev is its current judgment model;
TypeSafe and OpenRouter are provider adapters. The agent-facing tool and bundled skill are named
`systemone`; changing the provider does not change their contract.

The root owns assignments, integration and the owner conversation. Workers choose their local
investigation, implementation and focused checks within their admitted task and authority. Peers
review supplied snapshots and return findings to the root. System One supplies typed judgments;
the host applies routing policy, state transitions, admission, permissions and cancellation.
Deterministic goal requirements remain the goal ledger's mechanical proof. An advisory doubt
returns to the responsible model for evidence or a decision; it does not suspend independent work.
Mandatory findings require receiving-lane reproduction, repair when confirmed, and rechecking.

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
marks it budget-limited. An unsettled completion in explicit required mode keeps the goal active and
routes one decision to the native question panel or the handoff follow-up ledger; continuing schedules
a fresh continuation mission, while an explicit owner acceptance completes the goal. Other terminals
block with their reason codes. A continuation pass stops on a wait, a terminal, the turn or wall-clock
limit, or two cycles that executed nothing.

## Levers

System One has the operator's two levers over every executor, and every directive is an operator
event:

- **Cancel** fires immediately: the running turn aborts under `system_one:<reason>`, like Esc. A
  worker's lane is cancelled.
- **Steer** is either queued for the next model turn (a running worker takes it mid-run, an idle one
  wakes on it) or delivered now: the root's turn is interrupted and the queue sent once the foreground
  is idle; a worker's attempt is interrupted, the directive queued on its mailbox, and the attempt
  resumed.

Ordinary tool admission asks System One about a call only when code cannot decide it: a shell or code call, or a
write outside the task (see [The shell-command gate](#the-shell-command-gate)). Every admitted call is also
recorded with an intent built from its own arguments (`bash command=…`, `edit path=…`) and its terminal
(`succeeded` or `failed`) is written on the same `call_id`, so postflight judges the step's relevance and scope
over real events. Preflight and postflight System One packs run only with a live objective; the claim check and
the duplicate review run in every session. After a turn, the answer's claim check and the objective's postflight
wait on System One together.
Inside the objective loop a System One cancel of the root's own turn is a re-route (the next cycle
routes again); only the operator's interruption stops the loop. The worker supervisor redirects a
worker judged off the mission now, steers a stalled one at its next turn, and reroutes a repeated
stall. A delayed result must still name the observed objective, task and live attempt when applied;
a terminal attempt cannot steer or cancel a newer task on the same persistent worker.

Preflight never skips the owner's turn. Its outcomes other than `allow` are recorded as a control directive
and become the next `composeObjectiveRoute` input (`retrieve`, `replan`, `deterministic_test`,
`escalate_capability`, `blocked_external`); a preflight failure leaves the turn running. Postflight outcomes
similarly select the next route (`verify`, `retrieve`, `replan`, `completion_candidate`, `blocked_external`);
they are not discarded.

`objective_primary` without a live `ObjectiveExecutionController` fails closed and names that
binding; it never continues on the legacy loop. Under `system_one_required`, a required steering
checkpoint must come from calibrated Jev or mechanical `none` — `synthetic_self_report` cannot
satisfy it.

Every System One stage hydrates `ExecutionStore` from the live goal, durable task evidence and open
verification obligations before it evaluates. That store is a projection, not a second authority.
Completion cannot pass an empty or disconnected objective, empty required criteria on a real
objective, or unresolved verification.

Production owners: SteeringPlane JEV-001..003 for admission, JEV-004 for routing, JEV-024/025/026
for objective-loop completion, JEV-041.. for semantic dedup. The goal tool first proves its
deterministic requirements and checks, then asks `SystemOneController` to evaluate the same canonical
completion view without persisting a terminal state. Every completion request reruns current proof;
a previous rejection never latches an owner question. Received completion findings take priority in
the receiving agent's own lane: verify against current evidence, revise confirmed failures, and
recheck before continuing affected work. Failed requirement checks and unresolved findings refuse
completion. Evaluator outages retain their actual diagnostics without inventing a defect.
Other `SystemOneController` stage packs for intake, claim check, duplicate
logic, patch review and drift remain callable for tests/hooks.

## The shell-command gate

Code decides everything it can before System One is asked: the capability envelope, path bounds, the edge
classes and the external-acquisition screen. What remains is a shell or code call, or a write outside the task,
and System One answers two things about it: what the operation does, and whether the owner's request asks for it.

- **What it does** is four questions (leaves the machine, cannot be undone, touches files outside the task,
  acquires external code) that read only the operation: its command, resolved executable, script content, and the
  execution and task directories. That reading is remembered across turns and sessions, keyed by those facts, the
  System One model id and a digest of the questions themselves, so a new model or a reworded question never reads
  an older answer. An operation with no effect costs no System One call after its first.
- **Whether the request asks for it** is asked fresh, and only when the remembered effects are not nil.
  A System One that cannot answer it leaves an operation that has an effect to the operator.
- The calls of one assistant message are judged together, in one request, as soon as their arguments are final;
  a call the pre-warm did not cover is judged when its turn comes.
- A call still unanswered after two seconds, or a System One that is down, lets the operation run with the doubt
  shown: for a root and for a worker alike, because the edge classes were already decided by code. An established
  effect the request does not ask for is refused; an unsettled one goes to the operator (a worker is refused).
- Every decision is recorded in the decision ledger (`operation_gate_decisions`: where the answer came from,
  the verdict and the time waited), with a digest of the operation identity and never the command. The effect
  readings live in `operation_effects`.

## Deadline

A System One stage evaluation, an intake classification and the answer's claim check wait at most five seconds,
retries included. A call past that is an outage, which its consumer already handles by the authority line below.

## Route choice

A model-category choice asks its first pass and every narrower follow-up between two leading categories in one System One
request (the first pass over all offered categories, then each pair), so an ambiguous first pass costs no second round trip.
The questions are the ones a separate follow-up would ask; a judge that cannot answer several option sets at once is asked one
set at a time.

## Native worker model and effort

Before a fresh unbound native worker starts, the host asks Jev once to select a profile from the
existing account routing candidates and their supported effort settings. The host compiles every
offered profile through worker admission with the same tools, paths, permissions and budget.
The request favors medium effort for clear coding tasks and higher supported effort for complex
reasoning or strict JSON tasks. This policy applies across providers.

Only a supplied profile with a valid Choice answer and confidence at least 0.90 can replace the
host default. Uncertainty, malformed answers, evaluator outages and requests exceeding the
4,000-character judgment budget retain that default. There is no second selection question.
The host rechecks current admission before persisting the selected model and effort.
Cancellation prevents a fresh admission; stale judgments cannot authorize a changed grant.

Authored model and effort, model pins and configured profiles retain precedence. A read-only or
path-scoped request still receives model selection without widening its grant. Persistent worker
reuse and replay preserve the admitted settings without another question. Worker concurrency and
independent-work requirements remain governed by their existing host admission policy.

Pinned by the [route choice tests](../test/expert-routing/system-one-allocation.test.ts) and
[native worker admission tests](../test/suite/worker-route-admission.test.ts).

## Explicit peer review

The root model can request independent plan or delivery review with the native `peer` tool.
It remains the executor; the peer receives only the supplied snapshot and has no tools or inherited
foreground history. This review uses the host's configured provider connections and spends tokens on
the chosen peer. Workers cannot launch a peer review.

Call `peer` with `{"action":"options"}` to discover exact `provider/model` references and
all supported `thinkingLevels`, plus the strictly higher `strongerThinkingLevels` for explicit
stronger review. Options are limited to the host routing
pool, configured authentication, available quota and supported effort. They do not assert strength.
Ordinary independent review works at equal effort, including when the root is at maximum effort.
Effort is never silently clamped.

Then call `peer` with `action: "review"` and a `review` object containing:

| Field | Required content |
|---|---|
| `peer` | Exact reference disclosed by `options`. |
| `thinkingLevel` | Any disclosed supported level for independent review; a higher level for stronger review. |
| `selection` | Optional `independent` (default) or `stronger`. |
| `stage` | `plan` or `delivery`. |
| `objective` | Requested outcome, up to 2,000 characters. |
| `artifact` | Relevant complete plan or change snapshot, up to 24,000 characters. |
| `evidence` | Source with references, checks, adverse findings and limitations, up to 48,000 characters. |

Independent review needs no model-strength judgment and remains available during a strength
evaluator outage when the host verification journal and candidate fence are bound. It requires
`workflow.delegate`; stronger selection and proof resolution additionally require `semantic.judge`.

For explicit `stronger` selection, System One compares the proposed distinct peer with the lead for
this task. Admission requires higher supported effort and a `stronger` judgment at confidence at
least 0.95. This is task-specific judgment, not measured benchmark proof. Equal capability,
uncertainty, a missing judge or an evaluator outage leaves only this stronger request unavailable.
The strength question carries the complete objective, stage and model facts within the host's
4,000-character routing budget; oversized metadata is refused explicitly. The peer receives the full
accepted artifact and evidence. The same model id under another provider is not a distinct peer.
The host fixes the peer and effort for the call, rechecks admission before the provider request,
and rejects results if the lead, peer configuration, pool, authentication, quota, reviewed candidate
or session branch changes.

The bounded response contains a snapshot digest, lead and peer settings, selection, findings and
limitations. Only stronger review includes strength judgment provenance. Each finding must quote
supplied evidence and specify a reproducible check.
Findings open durable obligations in the receiving lead's own lane: reproduce, revise confirmed
failures, and recheck before affected work continues. The session branch journal retains the full
bounded finding, candidate identity and scope across reopening. A trusted fork carries active
findings into its receiving lane and discards parent proof receipts.
`no_findings` never clears an earlier unresolved directive or certifies completion. Missing evidence,
malformed or truncated output, cancellation and service failures grant no validation. Reported peer
usage is retained even when its response is unusable. Permissions and approval remain host-owned.

Use `peer` with `{"action":"obligations"}` to inspect pending findings and host-recorded tool
receipts. Resolve one with `action: "resolve"` and a `resolution` object:

| Field | Required content |
|---|---|
| `id` | Pending obligation ID. |
| `disposition` | `rejected` or `repaired`. |
| `evidence` | Receipt IDs with roles `reproduction`, `repair` or `recheck`. |

A rejection needs a passing reproduction on the current candidate. A repair needs ordered
reproduction, successful repair steps and a passing final recheck on the repaired candidate.
The host verifies the receiving lane, candidate identities, order and complete receipt payloads.
System One then judges whether those exact receipts establish the requested disposition and cover
the finding's required checks, with probability at least 0.95. This action never dispatches another
peer. Prose, a successful executor return or a later clean review cannot discharge an obligation.
Denied proof cannot be rerolled by running unrelated tools; fresh relevant evidence is required.

While findings remain open, the concrete root and worker tool executors gate affected progress,
including YOLO calls. A same-checkout Git push is refused directly. Other operations require a
decisive judgment that they investigate, reproduce, repair or recheck in the receiving lane, or
are unrelated to the finding's scope. Native evidence reads and obligation inspection remain
available during evaluator outages, as do `systemone` status, retained evidence inspection, and
owner advisory uncertainty dispositions. These actions never clear mandatory findings or create
verification receipts. Classification can retry on the next operation; resolution
can retry the same proof after an outage. Outages retain their actual cause and never resolve a
finding. Typed delivery rechecks obligations immediately before each external effect.

The journal bounds active findings to 32 and receipts to the latest 64 calls. Truncated or evicted
receipts cannot establish resolution; gather fresh proof within that evidence window.

Pinned by the [peer policy tests](../test/peer-review.test.ts),
[native session integration tests](../test/suite/agent-session-peer.test.ts),
[delivery and recovery regressions](../test/suite/mandatory-verification-delivery.test.ts) and
[verification lifecycle tests](../test/system-one/verification-obligations.test.ts).

## The decision ledger

`state/decision-ledger.sqlite` (one per agent directory, keyed by session id and working directory,
append-only) holds every stage transition, every Jev evaluation and every route with its executor. The
objective's recent routes are a history block in the state the judge reads; "repeated without new
evidence" is one route on one evidence marker, twice. The root reads the ledger with
`decision_ledger_read` (`sessions`, `stages`, `evaluations`, `replay`); workers never do.

The TUI counts unresolved questions in live System One status instead of appending a line for each
uncertain evaluation. Repeated judgments update the same question; decisive matching evidence
removes it. Worker tasks have separate question identities, retained across retries. Unrelated
judgments, cancellation and evaluator outages cannot clear an open question. The ledger restores
this live state when a session reopens; the bounded recent-history display does not expire questions.
Complete question identities and states are stored separately from the six-line preview, so a large
evaluation or truncated label cannot hide a question or prevent its matching recheck from resolving it.
These display facts do not discharge mandatory verification findings, which retain their own proof
requirements above.

The root inspects `systemone` with `action: "uncertainties"` at turn entry and before delivery.
It gathers evidence within the existing grant. For a worker-task question, it gathers evidence from
the responsible worker and may steer it to recheck; after reviewing that evidence, the owning session
may record an advisory disposition for any current question in its own journal. Use
`action: "resolve_uncertainty"` with `uncertainty` containing its exact `evaluationId`, `question`,
`disposition` (`conservative_path` or `evidence_based_decision`), `reason` and `evidence`.
The host records this owner-model decision separately from the Jev evaluation. A newer judgment
reopens its question; stale identities, questions explicitly scoped to a foreign root session and
failed journal writes cannot acknowledge it. Missing scope on a legacy evaluation remains unknown
and does not acquire root provenance during hydration. This advisory disposition does not alter Jev
evidence or discharge mandatory same-lane verification, and grants no permission, certificate proof
or finding resolution. Independent authorized work continues while evidence is gathered.

## Verification

Pinned by the [primary loop tests](../test/goal-session-primary-loop.test.ts), the [session objective
runtime tests](../test/session-objective-runtime.test.ts), the [foreground control tests](../test/system-one-foreground-control.test.ts),
the [worker control tests](../test/system-one-worker-control.test.ts) and the
[ledger route tests](../test/ledger-route-checkpoints.test.ts); see `docs/doctrine.md`, section
"System One".

## Where a judgment may stop work

`system-one/authority-line.ts` is the one table. Reversible work, and an operation code could not classify, proceeds past a doubt or an outage
with the doubt visible; an ambiguous judgment asks for evidence at most `GATHER_MORE_LIMIT` (2) times
per evidence revision. Received nonpassing JEV-024..028 judgments require verification in the
receiving lane in both policy modes. They keep completion open without dispatching a substitute
verifier or opening an owner-question latch. `system_one_optional` records evaluator outages as
diagnostics after deterministic proof; `system_one_required` retains its availability gate.
An irreversible or outward operation goes to the
operator, or is refused for a worker; an established outward effect the request does not ask for is refused. Only Choice and Score answers are gated on confidence; a
Noul's probability is its certainty.

Project-rule candidates across mutation, postflight and completion require the receiving agent to
verify them. Current verification receipts reach the recheck. An evaluator outage reports its
diagnostic without inventing a critical violation or queuing repair tasks. Deterministic instruction
violations retain their corrective work and transition checks.

The completion evaluation requires planted gaps to refuse completion and reports diagnostic notices separately.
An incomplete semantic assessment or evaluator error never counts as detecting a planted gap.

## Claims against deliveries

After every turn the final answer's claims (tests pass, committed, pushed, published, files changed)
are asked of System One one atomic question each, and each settled "the answer states X" is combined in code
with the turn's receipts: test verification records, git commit/push and publish exit status, and
successful edits. A contradicted claim buys one correction turn; an unbacked one is a warning.

Worker reports get the same check, against the worker's own transcript, whether or not the report
already needs parent review. A verifier's `accepted` is itself a claim: it is blocked when the
verifier inspected nothing or its last test run failed.

## Findings nobody could settle

A worker holding `systemone` confirms findings with atomic System One questions and lists what stays
unsettled in its result's `inconclusive`, instead of rounding it up or rewording a question to pass.
Each item climbs a ladder (`system-one/unsettled-ladder.ts`), at most two System One passes, each with
evidence the last one did not have:

1. System One judges the item against the worker's own tool results: two one-condition Nouls,
   "shown true" and "shown false". Only a `hard_pass` band settles it, either way.
2. A stronger model (the router's expensive tier) names the fact in those results that settles it;
   System One judges that the results state the fact and that the fact settles the item. The model
   finds; System One decides.
3. What stays open goes to the owner. With the owner in the loop the parent is told to ask them;
   under a handoff it is written to `<agentDir>/follow-ups/<sessionId>.md` and the run continues with
   everything that does not depend on it. It never closes an objective and never authorizes an
   irreversible action.

Settled items return to the parent as `System One settled: …` and no longer hold the claim for
review. Collaboration and tmux workers, whose transcripts the host cannot read, mark such findings
with `INCONCLUSIVE:` lines in their report; those go straight to step 3.

The root agent's own answer climbs the same ladder: a claim no receipt backs (the harness reads
receipts only from the tools it knows) is judged against the turn's tool results. Confirmed, it
stands; refuted, it is a contradiction and buys the one correction turn; still open, it goes to the
owner. What goes to the owner is delivered by the host, never relayed by a model. With the owner
present, the turn displays one `owner_items` message. During a full handoff, the host records the
items in the follow-up document without displaying a question or warning.
An ungranted irreversible operation during a full handoff is blocked and recorded there too.
The next owner message outside a handoff receives one notice pointing to newly recorded follow-ups.

An unanswered interactive question has a five-minute deadline. The dialog closes and the durable
question remains pending; the owner did not cancel or authorize anything. The root continues only
independent authorized work and records the decision in the follow-up document. A restored question
uses the remaining time from its original request; an overdue question or a headless restore is
deferred without opening a dialog.

A handed-off owner question follows the same rule. A stronger model may answer it on a basis copied
from the owner's request, which code checks is in the request (case, punctuation and spacing folded)
and System One judges backs the answer; or on its own judgment, which stands only when System One decisively finds
the question is none of the kinds the owner reserves: scope, spending, accepting a risk, an
irreversible or outward action, or a matter of taste the request does not settle.

The ladder's questions are worded from live measurement, and `npm run probe:system-one-ladder` re-measures
them against live System One with cases of known answer. It fails only when a case settles the wrong way;
a case left open reaches the owner and is reported as conservative. Re-run it when the System One model or
a question changes.

## Semantic duplicates

A successful edit or write that adds a function is checked against a semantic unit index of the
repository (files from the resident FFF index or the managed ripgrep listing, refreshed by mtime).
Candidates rank by IDF-weighted shared calls and normalized-token fingerprints; System One judges every
(new unit, candidate) pair in one request. A decisive duplicate is appended to the edit's result,
naming the function to reuse; a provisional one is a warning. `npm run scan:semantic-duplicates`
judges every production unit against its closest candidates, batched and concurrent (scaled to the
machine's cores and free memory), and prints a report.
