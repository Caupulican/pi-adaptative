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

## Worker supervision

Every executed worker tool call is one observation of its attempt. It runs beside the worker, not in front
of it: the worker's next call does not wait for the assessment, one observation per attempt is in flight at
a time (the next is dropped, its window is already the newer one's), and a verdict that settles after its
attempt ended is fenced at the control boundary. A steer then reaches the worker at its next turn boundary
(`steer_once`, queued) or interrupts it now (`steer_now`, off-track work).

A deterministic check runs first: repeated broad validation with no new implementation is steered, then
rerouted after a grace window of three calls. Otherwise one System One request asks eight closed questions
(progress, stuck, off-track, repeating strategy, needs independent verification, specialist gap, capability
gap, external block), each with criteria and examples in several languages, and code maps the answers to an
action; only a decisive answer moves a worker. Which answer is adverse is declared once: each question carries
its required end (`direction`) in the program, the engine bands every answer against it (`hard_fail` is the
decisive opposite), and the supervisor, the steering plane and the evaluation ledger read the band through
`isAdverseAnswer` instead of re-deriving cutoffs from the probability (a boundary gate keeps the supervisor
from importing the band arithmetic). An undecided answer is never adverse. The ledger row for a supervision
judgment names the questions that came back adverse. A steer names the mission it steers toward and leaves
the approach to the worker; steering is advisory, one steer and a grace window before a reroute, and a
reroute needs an observed stall, repetition or failure. The same evidence is not assessed again, but the evidence is
everything the questions read: the tool-call count (every four calls), the failures and the changed files
count, not only the output tail and the stall flags. A worker that fails three evaluations on an attempt
stops being assessed and keeps running.

Every verdict, `continue` included, is a row in the decision ledger's `supervision_actions` table with its
outcome (`applied`, `failed` when the control surface refused, `stale` when its attempt had moved on), so how
often supervision intervenes and whether it landed is measurable.

Measured on live System One with the production decision code: on 48 states written independently of the
wording (seven healthy implementers, five explorers, four verifiers, five hard negatives, six stuck, six
repeating, six off-track, five finished, four externally blocked; eight non-English) the earlier wording
chose the expected action for 37 (strategy repetition 0 of 6, finished work 0 of 5, because
`needs_independent_verification` never cleared the 0.8 bound); the criteria wording chose it for 47, with no
false intervention on the 21 healthy states. In a live run a worker told to repeat broad validations was
observed, steered, received the steer as a worker-control message from the session root, and stopped.

Limits: a worker is observed at tool-call boundaries only, so one stuck inside a single long call or a
silent model turn is not seen until its next call; and a worker that finishes without saying so can be
missed by the verification question.

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

## The completion account

What needs reasoning about a change belongs to the model that made it. When a goal changed the repository,
`goal complete` (and `update_goal` with `status: "complete"`) carries `account`:

- `changes`: every changed file, what the change does, and which requirement ids (or which other changed file)
  it serves, with `evidenceIds` when its diff alone does not show it achieves them;
- `assumptions` and `regressions`: each assumption the change relied on, and each behavior it could break, with
  the evidence ids (from `get`) that establish it or the checks that exercise it; empty when there are none;
- `cause`, for a bug fix: the defect's cause and how the change removes it, with evidence ids.

For a bug fix, code also adds one derived claim to the same System One request: that the diff changes the mechanism the stated
cause describes (a change that only suppresses the symptom does not), read against the cause's cited evidence and the diff. It costs no extra call. A
contradicted claim refuses completion until the model reproduces the defect against the current code, revises the change so
it removes the cause, runs the check again and cites that run; an unsettled one asks for a run that fails before the change
and passes after it, with the same two-pass bound as every other claim. It replaces the former stand-alone patch-review
stage, which no code called and which saw only file paths and diff hashes.

Code checks everything it can: that the account exists, that every changed path is explained, that every
requirement or file a change serves exists, that every cited id exists, that each claim rests on at least one
verified piece of evidence, and that a bug fix states its cause. System One then decides each stated claim
against the diff or the cited evidence with the same fixed pair of questions the unsettled ladder asks (does the
evidence show it, does it contradict it), all in one request beside the evidence-matrix questions: it never guesses
what a diff means, and the model never authors a question. A contradicted claim refuses completion and names the
claim; a claim the evidence does not settle asks for better evidence, twice for the same claim over the same
evidence, after which it stands as a recorded doubt. A failure in the account opens no verification obligation: it
is answered with evidence, not with a hold on every other operation. An account missing or incomplete is one
refusal that lists what is missing and the evidence ids the model can cite.

A lint or type-check suppression the patch adds (a `ts-ignore`, `eslint-disable`, `biome-ignore`, `noqa` or `nolint` comment, an
`allow` attribute, or a cast to `any` in a script file) hides what a check found, so code requires each one to be accounted for:
an assumption in the account must name the changed file and cite verified evidence that the silenced rule does not apply there.
That assumption is judged like any other, and System One reads which suppression it answers, never the author's own comment.
Removing the suppression and fixing its cause also satisfies the check. Prose files (`.md`, `.mdx`, `.txt`, `.rst`, `.adoc`)
are skipped, because they describe a directive and never apply one. The scan reads the whole work diff, not the bounded
patch the model sees: the content of new untracked files and every change past the patch limit are scanned (at most 500
hits are kept).

The count of unsettled claims is kept in the decision ledger per session, so a resumed session continues it. The completion's
evidence-matrix stages and the account's claims wait on System One together, in one round trip's time.

The account is held for the session: the objective loop's completion reads the latest one, and a changed path it
does not explain asks for an update. The evidence-matrix questions (is each required outcome shown, is each
claim supported, is a requirement missing) are unchanged and still judged through the measured completion bounds.

## Decision engineering in this harness

The rule: text stays with the model, a label goes to System One, and the branch on the label is code.
A step that answers with one word from a fixed list (yes or no, one option of a few, a score) is a
decision; it is not asked of the generative model, and what happens after the label is never a second
model call. The harness applies the rule at these sites; the last block lists the decisions that are still
heuristic.

| Decision | Program | Where |
|---|---|---|
| Is this operation harmful or off-request | `JEV-OPERATION-EFFECT` | shell-command gate |
| Which route next | `JEV-004`, `objective-route-v2` | objective loop |
| Is the goal complete, is each claim shown | `JEV-024..026`, completion account | goal completion |
| Does the answer's claim stand | claim check | after every answer |
| Does new code duplicate existing code | `system-one:code_duplicate` | edit review |
| Which tool results to keep when compacting | `retention_eval_*` | compaction |
| Which model pool or model | `system-one:route_choice` | model router |
| Does an owner message grant, limit or hand off | `system-one:intake` | owner words |
| Which file holds what the model is looking for | `system-one:locate` | `systemone locate` |

How a new decision is written here, from the practice's own rules:

- **Closed question, facts as state.** The state carries the evidence (an excerpt, a diff, a list of
  candidates), never a conclusion the model already reached; questions cannot see each other's answers.
- **Batch what shares a state.** Questions about one snapshot go in one request (up to 25 questions, 24 KiB
  of state), and independent requests run in parallel under the machine-scaled concurrency bound.
- **Code owns the threshold and the branch.** A hard decision needs the 0.93 hard pass; an unsure answer is
  never treated as a yes or a no: it takes the fuller path (a full classification, the lexical order, the
  operator) and an outage returns the deterministic result marked unjudged. A judgment orders, annotates
  and routes; it never refuses work the model could do another way.
- **The label is not proof.** A located file is read before it is edited, an "allowed" operation is verified
  by its own result, and completion is proven by the goal's checks, not by a confident label.
- **The option list is rebuilt every turn** from the live tools, workers and candidates.
- **Wording is measured, not guessed.** System One reads the supplied text and pattern-matches; a question
  that scores below the floor on a clear case is a badly formed question. Every question in the catalog is
  checked on labelled messages in more than one language before it ships (see Owner words).

Constraints this harness adds to the practice: the sent prefix is frozen for the prompt cache, so a
relevance filter acts on the compaction summarizer's input or on fresh tool output and never rewrites
history already sent; compaction's own verification (gated facts, read paths, open errors) must still
hold, so a keep or drop never removes an entry the verifier requires; and nothing here reduces the model's
freedom, a judgment only reorders what it sees.

Decisions that are still heuristic, ranked by expected gain, each to be moved only with a measurement
first (precision on a labelled set, requests, latency, tokens against the baseline):

1. Compaction's keep or drop per tool pair already batches, but the judge sees only the tool name and call
   id, never the result; giving it a bounded excerpt of each result and chunking the request is the
   largest unused lever.
2. `context-gc` decides a stale tool result by size, recency and "latest read per path"; "is this result
   still relevant to the current task" is a closed question per entry, run in parallel on the summarizer's
   input.
3. `grep` and `find` rank by lexical score and cap hits per file; ranking the capped remainder by "does this
   excerpt do what is being looked for" is the same question `locate` asks.
4. `context_scout` runs a generative read-only subagent to find candidate files; a choice over the
   candidate list from `locate` is a cheaper first step.
5. Memory recall ranks by token overlap; "does this memory bear on the task" per page.
6. Test failure triage ("flake or real regression") over the failure text and the recent diff.

## File location

`systemone locate` answers "which file holds X" for the session owner (workers do not have it). The caller
states what it is looking for (`target`) and 1 to 8 literal or regex `queries` of its own choosing; the host
does the rest, in code except for the judgment:

1. The queries run through the managed `rg` (ignore rules, scope and protected credential files respected)
   and are united by file. Files are ordered by how many distinct queries they match, then hit count.
2. The top 24 files each become a card: the leading comment, up to ten declared names, and three lines
   around the best hit, redacted like any other System One state.
3. One closed Noul per card ("is this the code the target asks about") goes out, up to 25 per request, in
   parallel under the machine-scaled bound; the answers rank the files by probability, path ascending on a tie.
4. The model gets a short ranked list with `path:line`, the matched line and the probability, the files
   below the floor topped up to three and labelled, and a count of files not judged. It still reads the
   file it will edit: a label is not proof. An outage returns the lexical order marked `unjudged`.

Measured on 20 targets written down before any run (hold-out, two identical runs): the file the model was
looking for is first in 85% of calls (lexical order of the same candidates: 35%; a plain `rg` ordered by hit
count: 20%) and among the first three in 95% (65%; 30%). A call takes 1.15 System One requests, about 6.7k
judged input tokens and 465 ms of wall time, and returns about 170 tokens; the baseline the model would
otherwise read is the hit lines (about 3.6k tokens capped, 340k uncapped) plus the top files. Judgments
tuned on a separate 30-target set reached 83% and 93%. The expected file is among the 24 judged candidates
in 95% of targets; the misses are generic queries, so wording the queries from identifiers lifts recall.
Labels, every run and the method are in the release's audit directory.

## Owner words

An owner message is classified by System One where its outcome is read, never in front of the turn. The
classification answers what the words do to standing policy: grant capabilities, limit git delivery, lift
a limit, override a written rule, hand decisions off, change model pools, forbid an optional tool. A
message is queued on arrival (`OwnerPolicyQueue`) and the queue is settled at the first reader:

- the first tool call of a turn, before any gate reads grants, a delivery limit or a tool forbidding, and
  before the shell-command gate decides whether the operator's standing grant applies (the settle starts
  when the model begins its first tool call, so it runs while the arguments finish);
- the next turn's routing, so a model pool change made in an earlier tool-free turn holds for that
  allocation;
- the end of a turn that left items for the owner, where a handoff decides delivery.

A turn that uses no tool never settles it: a greeting costs no System One request and no wait. Messages
left over from earlier tool-free turns are screened together in one request, one closed question per
message ("only small talk or a request to understand something, with no instruction"). A message is set
aside only on a hard pass of that question; an unsure answer or an outage classifies it in full, in the
order the owner wrote it, because a delivery limit and its lifting are order dependent. The newest message
is always classified in full. A failed classification keeps the messages it did not reach. Notes the
classification produces (a rule conflict, a settled rule) reach the model at the start of the next turn.

Measured on 70 messages in ten languages (English, Portuguese, Spanish, French, German, Chinese, Japanese,
Russian, Arabic, Hindi; seven kinds each) against the live model: the full classification answered the
same in every language as in English (each language 21 to 23 of 25 expected answers at the 0.93 floor, the
misses being the same borderline readings in English). The screen at the 0.93 hard pass lost no
instruction and set aside 14 of 30 small-talk and explanation messages; the closest instruction scored
0.84 (a German handoff), so the margin is real but narrow, and the screen is weakest in Chinese, Russian,
Arabic and Spanish. The first wording of the screen (a "does it carry an instruction" question read at a
0.2 cut-off) lost a Japanese handoff; asking for the safe-to-skip case and requiring a hard pass did not.
The question that decides whether a message directs work was reworded after the same kind of measurement: the old wording reached the 0.93 hard floor for 2 of 15 plain directives (13 scored 0.59 to 0.92, so most directed work did not grant the edge capabilities), the new one scores all 15 at 0.97 or higher and a directive in each of the ten languages at 0.98 to 0.99, with no greeting, thanks, explanation, hypothetical or hold-back message above 0.15.
The task-relation question for optional tools is asked only when the previous intent holds a tool decision;
it was otherwise a judgment that could fall below the floor and leave the whole intent unresolved.

## Optional tools

A tool that is not built in or bundled (an extension or an integration) runs unless the owner forbade it. Each owner message
is classified once per such tool as asking for it, forbidding it, or saying nothing about it; only a forbidding blocks, and it
stands for the task until the owner asks for the tool again or the task ends. A classification in flight, an outage and an
uncertain judgment block nothing, and the forbiddings of the task being continued stay in force while new words are classified.
`secret_store` status, list and discover stay available after a forbidding; activation and migration do not.

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
available during evaluator outages, as do `systemone` status, retained evidence inspection,
owner advisory uncertainty dispositions, and the tools that neither change the candidate nor advance
the work (`ask_question`, `self_compact`, `typesafe_review`). These actions never clear mandatory findings or create
verification receipts. Classification can retry on the next operation; resolution
can retry the same proof after an outage. Outages retain their actual cause and never resolve a
finding. Typed delivery rechecks obligations immediately before each external effect.

The journal bounds active findings to 32 and receipts to the latest 64 calls. Truncated or evicted
receipts cannot establish resolution; gather fresh proof within that evidence window.

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

See `docs/doctrine.md`, section "System One", for the invariants; the tests that pinned them were removed on 2026-10-04 and are rebuilt by area.

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
