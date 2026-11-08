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
  running attempts, the ledger's stall reading) and System One's judgments (`JEV-004`: work
  remaining, missing work class, evidence sufficient, semantic progress, strategy repetition, context
  stale, independent worker required, capability escalation, capability gap suspected, completion
  plausible).
- `objective_shadow`: the legacy continuation drives; the route is evaluated for disagreement
  telemetry only.
- `legacy_goal` (default without System One): the legacy continuation alone.

An explicit SDK `executionLoopMode` keeps its selected mode and required-binding checks when
System One is disabled. In particular, `objective_primary` requires an explicitly supplied objective
controller or construction fails; it never silently changes to `legacy_goal`. Supplied objective
controllers and diagnostic readiness ports remain bound independently of System One. Disabling
System One still prevents semantic controller/steering bindings and evaluator calls.

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

System One has the operator's two levers over every worker, and every directive is an operator
event. The root's own turn stays the operator's to cancel or steer:

- **Cancel** fires immediately: the worker's lane is cancelled.
- **Steer** is either queued for the worker's next model turn (a running worker takes it mid-run, an
  idle one wakes on it) or delivered now: the worker's attempt is interrupted, the directive queued
  on its mailbox, and the attempt resumed.

Ordinary tool admission asks System One about a call only when code cannot decide it: a shell or code call, or a
write outside the task (see [The shell-command gate](#the-shell-command-gate)). Every admitted call is also
recorded with an intent built from its own arguments (`bash command=…`, `edit path=…`) and its terminal
(`succeeded` or `failed`) is written on the same `call_id`, so postflight judges the step's relevance and scope
over real events. Preflight and postflight System One packs run only with a live objective; the claim check and
the duplicate review run in every session. After a turn, the answer's claim check and the objective's postflight
wait on System One together.
Only the operator's interruption stops the objective loop; System One holds no cancel over the root's
own turn. The worker supervisor redirects a
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
checkpoint must come from calibrated System One or mechanical `none` — `synthetic_self_report` cannot
satisfy it.

Every System One stage hydrates `ExecutionStore` from the live goal, durable task evidence and open
verification obligations before it evaluates. That store is a projection, not a second authority.
Completion cannot pass an empty or disconnected objective, empty required criteria on a real
objective, or unresolved verification.

Production owners: SteeringPlane JEV-001..003 for admission, JEV-004 for routing, JEV-024 and the
completion transaction for objective-loop completion (JEV-025/026 ask the same packs only when no
transaction verdict exists: a mechanical or reviewer profile, an evaluator exception, or a plane without a completion transaction), JEV-041.. for semantic dedup. The goal tool first proves its
deterministic requirements and checks, then asks `SystemOneController` to evaluate the same canonical
completion view without persisting a terminal state. Every completion request reruns current proof;
a previous rejection never latches an owner question. Received completion findings take priority in
the receiving agent's own lane: verify against current evidence, revise confirmed failures, and
recheck before continuing affected work. Failed requirement checks and unresolved findings refuse
completion. Evaluator outages retain their actual diagnostics without inventing a defect.
The objective loop sends no postflight steering requests of its own after a step: the step's System One
postflight and the next route evaluation judge it.

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
count, not only the output tail and the stall flags. The semantic judgment starts at five tool calls (the smallest count it was measured on; a live run showed that
assessing at the first call called a healthy worker stalled), and the deterministic churn check covers early
work. A worker that fails three evaluations on an attempt
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
and passes after it, within the owner's authorized verification mode. The claim remains open until the evidence settles it. It replaces the former stand-alone patch-review
stage, which no code called and which saw only file paths and diff hashes.

Code checks everything it can: that the account exists, that every changed path is explained, that every
requirement or file a change serves exists, that every cited id exists, that each claim rests on at least one
verified piece of evidence, and that a bug fix states its cause. System One then decides each stated claim
against the diff or the cited evidence with the same fixed pair of questions the unsettled ladder asks (does the
evidence show it, does it contradict it), all in one request beside the evidence-matrix questions: it never guesses
what a diff means, and the model never authors a question. A contradicted claim refuses completion and names the
claim; a claim the evidence does not settle keeps completion open. Repeating the same account never turns an
unresolved claim into support. After two judged passes over the claim the guidance changes, while the failure remains;
an unchanged resubmission is replayed (below) and does not count as a pass. A failure in the account opens no verification obligation: it
is answered with evidence, not with a hold on every other operation. An account missing or incomplete is one
refusal that lists what is missing and the evidence ids the model can cite.

Before System One is asked, code runs everything it can on current state: the goal's requirement checks are
rerun, a malformed account is refused with every location that departs from the schema (one per JSON path, at
most 12, then the count) and the account's compact shape with a minimal valid account, and the account,
obligation and deterministic gates are checked. When all of those pass, the transaction computes a digest of
what the judgment reads (the cold completion projection with each observation keyed by what it says rather than
its id, the account claims with their evidence text, the whole work diff, the bug-fix flag and the thresholds).
If System One already refused completion over the same digest in this session, that refusal is replayed and
System One is not asked again; the refusal says so. Only a refusal System One judged in full is replayed: an
evaluator outage, an external gate or hook, and any code-only refusal are decided again every time. A
requirement check's run is keyed by its requirement, not by its output: a failing check is refused before the
judgment, so every latest run has passed and its output tail (durations, counts) would otherwise change the digest
on every request. A failed run between two judged requests does not change the digest when the work and the
latest run are unchanged.

Every completion refusal ends with an `r` line: a JSON list with one remedy per failed gate (`gate`, `kind`,
`next`, and `requirementId` for a requirement check). The kind comes from a closed table over the gate ids:
`fix_work`, `attach_evidence`, `revise_claim`, `revise_account`, `resolve_obligation`, `wait_evaluator`
(an outage, not a production finding) and `ask_owner`; an id outside the table is `follow_next`, meaning
do what its next step says. The goal records the sorted set of failed gate ids with each refusal and counts
refusals in a row by that set, so a probability that moves between attempts does not reset the count.

A lint or type-check suppression the patch adds (a `ts-ignore`, `eslint-disable`, `biome-ignore`, `noqa` or `nolint` comment, an
`allow` attribute, or a cast to `any` in a script file) hides what a check found, so code requires each one to be accounted for:
an assumption in the account must name the changed file and cite verified evidence that the silenced rule does not apply there.
That assumption is judged like any other, and System One reads which suppression it answers, never the author's own comment.
Removing the suppression and fixing its cause also satisfies the check. Prose files (`.md`, `.mdx`, `.txt`, `.rst`, `.adoc`)
are skipped, because they describe a directive and never apply one. The scan reads the whole work diff, not the bounded
patch the model sees: the content of new untracked files and every change past the patch limit are scanned (at most 500
hits are kept).

Changed-file diffs are bounded excerpts, and a large patch can omit later files. Fresh authoritative observations and
passing harness checks cited in `changes[].evidenceIds` supplement the change reason, requirement link and dependency
link alike. Stale or unverified observations cannot supply that supporting text. Clipped file excerpts identify the omission.

The count of unsettled claims is kept in the decision ledger per session for recovery guidance, never as proof. The completion's
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
| Which route next | `JEV-004` | objective loop |
| Is the goal complete, is each claim shown | `JEV-024`, completion transaction (`JEV-025`/`JEV-026` without one), completion account | goal completion |
| Does the answer's claim stand | claim check | after every answer |
| Does new code duplicate existing code | `system-one:code_duplicate` | edit review |
| Which tool results to keep when compacting | `retention_eval_v2` | compaction |
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

## Thresholds and readings

System One makes the judgment; code makes the decision. Every cut lives in
`core/decision/thresholds.ts`, next to the readers that apply it. A measured value carries its measurement
there; the rest are starting points kept until an evaluation on this harness's own answers says otherwise.

| Answer | Family or risk | Cut | Notes |
|---|---|---|---|
| yes/no | `gating` | hard pass 0.93, soft pass 0.85, hard fail 0.2 (mirror 0.07 / 0.15 / 0.8) | measured on the owner-words screen; a soft pass may continue a step, never authorize |
| yes/no | `advisory` | pass 0.7, fail 0.3 | no soft band; between is undecided and gets its own outcome |
| yes/no | `operation_effect` | effect absent at or below 0.5, established at 0.8 | probed live on common commands; absence looser than 0.10 by written reason (below) |
| yes/no | `operation_request` | asks at 0.8, clearly does not at 0.2 | |
| yes/no | `plan_review` | defect steers at 0.8, sound at or below 0.5 | probed live on planted plan defects; absence looser than 0.10 by written reason (below) |
| yes/no | `completion` | outcome holds at 0.7, defect absent at or below 0.5, claim supported at 0.5 | measured on the completion eval set, 2026-09-25 |
| yes/no | `orchestration` | accept 0.9, absence at or below 0.1 | no soft band: between is `open`; plan graphs, briefs, pair sufficiency, routing doubts; unmeasured |
| yes/no | knowledge | 0.9 | admission and grounding |
| Choice | `reversible` | P(option) 0.7 | |
| Choice | `route` | P(option) 0.88, lead 0.15 | preflight and postflight route |
| Choice | `consequential` | P(option) 0.9 | |
| Choice | `authority` | P(option) 0.93, lead 0.2 | owner intent, optional-tool standing |
| Choice | `destructive` | P(option) 0.9, then a confirmation step | identifying the intent never performs it |
| Choice | follow-up | decide at 0.9, ask a narrower question from 0.8 | the authority line |
| Score | any | confidence at least 0.5, then 0.7 of the mass on one side of the boundary | below the floor a Score decides nothing |

`operation_effect` and `plan_review` share one presence band and accept absence at or below 0.5, looser than
the 0.10 the owner's rule sets for requiring absence. The written reason: an absence reading in either family
authorizes nothing beyond what runs without System One. A plan review only steers or annotates a plan the model
keeps working from; an effect absence lets a shell call run under the edge policy that already governs it. At
0.10, every routine command whose effect reads between 0.10 and 0.5 would become unsettled, refused in a worker
and asked of the owner at the root. The measurement owed: a labelled set per question (effect-free and effectful
operations; sound and planted-defect plans), answered once and re-decided offline from the saved answers
(`typesafe-review decide`), placing the absence cut where no labelled effect or defect reads below it. Both
readers take their cuts from `noulBand` over the family's band; neither keeps a local copy.

How an answer is read:

- **yes/no** is P(true). `noulBand(p, direction, family)` places it in `hard_pass`, `soft_pass`, `ambiguous` or
  `hard_fail` for the question's required end. `readNoul` adds `unasked` for a missing or non-probability answer,
  so a question that was not answered is never read as a default probability.
- **Choice** readers (`choiceProbability`, `choiceAct`, `choiceGate`) read the probability of the option code
  acts on, never `confidence`, which for a Choice is only a transform of the top probability. These Choice
  reads use them: the step route, the action policy, model pools, route choice and its narrowed pass, worker
  task fitness, peer strength (0.95), tool intent, claim provenance (`consequential`, 0.9), verification resolution proof and
  evidence-gap closure, the LFM3 media judgment, and knowledge admission and grounding (at the knowledge floor,
  0.9). The structured model engine, used when System One is not bound, reports one verbal confidence per
  answer instead of a distribution; it reads as P(selected), with the rest of the mass spread evenly over the
  other options, so a Choice decides on the same value it did on confidence. The runner-up margin applies only
  where a close second changes what code does.
- **Score** is read confidence first, then on boundary mass (`scoreSettled`).
- The decision action policy reads a yes/no by its band (`ambiguous` is uncertain, and so is `soft_pass` at
  critical consequence) and a Choice through `choiceAct` (`reversible` at low and medium consequence,
  `consequential` with the 0.15 lead at high and critical). Only a missing result or a disallowed provenance
  sends the router to another engine; an answer below a cut returns as `gather_more`.

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
is always classified in full. A queued owner input (`steer()`, `followUp()`, or a prompt queued behind a
running turn) is classified in full once, when it is submitted, and joins the queue with that judgment
when the run delivers it, never when it is taken back, cleared or held; it is not screened or classified
again. A judgment superseded by a newer owner input is carried the same way, since classifying the older
words again would be refused as stale. Only an input whose judgment System One could not give, or one
superseded by words with no submission order, is screened and classified at the queue. A failed classification keeps the messages it did not reach. Notes the
classification produces (a rule conflict, a settled rule) reach the model at the start of the next turn.
Delivered words survive cancellation of their original turn. A later reader classifies them under its
own settle signal; an aborted originating signal cannot permanently cancel retained instructions.
A cancelled reader takes no new batch or further classification work. Its unreached words return to
the queue for the next live reader; cancellation is not reported as an evaluator outage.

Only the words the owner typed carry authority. Text pasted into the interactive editor (an email, an
issue, a web page, another agent's output) is material the owner showed, never an instruction the owner
gave: a pasted "never push", "you may run curl" or "from now on do X" grants no capability, sets no
delivery limit, hands nothing off, changes no model pool, forbids no tool, records no durable owner rule
and gives the goal tools no start authority. Every
question that reads the owner's words for authority (the classification, the screen, the model pool and
optional-tool questions, the operation gate's `request_authorizes`, the acquisition gate's need, excess and
source questions, and plan review's coverage question) receives the whole message with each pasted span
inside the untrusted boundary (`<untrusted_content source="owner-paste">`). Only when the text a question
judges carries such a span does the question add an instruction that a directive stated only there binds
nothing; a request the owner's own words make about the material ("run this", "apply this") stays the
owner's, and the material only shows what it refers to. That paste-aware wording is a separate pack
(catalog version `1.5.1+owner-paste.1`); a message with nothing pasted is asked the 1.5.1 questions
unchanged, so the measurements below and their thresholds still describe it, while the paste-aware wording
has not been measured live. A message with no typed words is never queued or classified, so it costs no
System One request. An extension's message (a peer agent's, say) is not the owner's at all: it is never
classified and grants, hands off, binds or lifts nothing. An explicit chat goal starts only from typed goal
words, with a token budget only from typed words; its objective is read from the whole message, so "set a
goal: implement the spec below" keeps the pasted spec. A long paste is shortened inside its fence so the owner's typed words
always reach the judgment whole. The same fenced request is what the gates, plan review and owner
questions read as the turn's request. Paste provenance survives take-back to the editor, a failed send-now,
a restart (the durable queued-input record keeps it), history recall and the external editor (an edit that
reaches into pasted text leaves what it rewrote pasted). Programmatic submitters (RPC, print, SDK,
extensions) pass no ranges, so their words count as typed.

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

Before a fresh unbound native worker starts, the host asks System One once to select a profile from the
existing account routing candidates and their supported effort settings. The host compiles every
offered profile through worker admission with the same tools, paths, permissions and budget.
The request favors medium effort for clear coding tasks and higher supported effort for complex
reasoning or strict JSON tasks. This policy applies across providers.

Only a supplied profile with a valid Choice answer and confidence at least 0.90 can replace the
host default. The optional profile-selection preview retains that default when its answer is
unavailable or the request exceeds its 4,000-character budget. A separate mandatory admission
judgment then checks the complete task, parent objective, exact model and effort. It accepts only
an `adequate` answer at confidence at least 0.90; uncertainty or an unavailable evaluator cannot
authorize the worker. Exact accepted inputs are cached within a bounded session owner.

Authored model and effort, model pins and configured profiles select the binding but do not bypass
task fitness. Reused attempts and parent continuations use the same check. An inadequate explicit
binding returns guidance to select a stronger model or narrow the task; it is never silently replaced.
Admission rechecks session identity, objective and model after the judgment. Model selection never
widens tools, paths, permissions or budgets. Worker concurrency and independent-work requirements
remain governed by their existing host admission policy.

When System One or the model router is explicitly disabled, deterministic configured routing
continues without these semantic calls or an assertion of semantic fitness. SDK, settings and
environment disablement apply even when a controller remains retained for later re-enablement.
Disabling System One preserves existing verification obligations.

## Explicit peer review

The root model uses the native `peer` peer for plans with material uncertainty and delivery review.
It remains the executor; the peer receives only the supplied snapshot and has no tools or inherited
foreground history. This review uses the host's configured provider connections and spends tokens on
the chosen peer. Workers cannot launch a peer review: they send findings and questions to their parent.
Peer calls never spawn another peer or a worker.

Choose the peer in **`/settings` → Peer**. The submenu provides Enabled, Model,
Thinking and Save scope controls. Selecting a model enables the peer. Save globally, for this
project, or for the directory profile; the highest configured scope replaces the entire lower-scope
peer configuration. The selector shows the effective selection and warns when another scope masks
a change. Selecting or enabling a peer does not purchase a review: the root requests each review.
Independent review works with System One off.

An explicit model choice is honored even outside router favorites without changing those favorites.
Explicit `--models`/SDK scope, model-pool policy, configured authentication, quota and the distinct-lead
check still apply. An unavailable choice produces a warning and refuses review instead of substituting
another model. A fixed Thinking choice is enforced exactly. **Agent chooses** permits the root to
request a supported effort; an omitted effort uses the model default. Selecting a different model
clears an incompatible effort override. Changing the effective preference cancels an active peer
request when possible and prevents its stale result from satisfying the new selection.

Call `peer` with `{"action":"options"}` to discover exact `provider/model` references and
all supported `thinkingLevels`, plus the strictly higher `strongerThinkingLevels` for explicit
stronger review. Options reflect the configured peer choice and its supported effort. Without a
saved choice, they use the host routing pool. Authentication, quota and model scope apply in both
cases. Options do not assert strength.
Ordinary independent review works at equal effort, including when the root is at maximum effort.
Effort is never silently clamped.

Then call `peer` with `action: "review"` and a `review` object containing:

| Field | Content |
|---|---|
| `peer` | Exact reference disclosed by `options`; omit when a peer model is configured. A conflicting model is refused. |
| `thinkingLevel` | Omit to use a configured fixed effort or the model default. Otherwise choose a disclosed supported level; stronger review needs higher effort. A conflicting fixed effort is refused. |
| `selection` | Optional `independent` (default) or `stronger`. |
| `recover` | Optional explicit recovery of a previously unavailable attempt after its cause was addressed. Completed reviews cannot be rerolled. |
| `stage` | `plan` or `delivery`. |
| `objective` | Requested outcome, up to 2,000 characters. |
| `artifact` | Relevant complete plan or change snapshot, up to 24,000 characters. |
| `evidence` | Source with references, checks, adverse findings and limitations, up to 48,000 characters. |

Independent review needs no System One model-strength judgment and works with System One disabled.
The root's branch journal and repository fingerprint own its lifetime. Repository discovery or
fingerprint errors refuse the review; an actual non-repository task is identified as a supplied-snapshot
review. It requires
`workflow.delegate`; stronger selection and proof resolution additionally require `semantic.judge`.

`peer status` returns bounded durable review receipts, including pending/unavailable attempts,
full findings and limitations. Identical live requests coalesce; repeated requests reuse their result
without charging their usage again. A restarted session retains the attempt and requires explicit
recovery instead of silently paying for it again. Review receipts bind the root objective, requirement
definitions, candidate, mode and session branch. Pending or failed attempts never mean review passed.
Disabling the peer preserves `peer status`, earlier findings and their resolution paths. It only
prevents new paid reviews; it does not erase an outstanding obligation.

If a completed paid review could not save its receipt, its bounded result remains available in the
current process. Inspect `peer status` for its `reviewKey`, fix storage, then call `peer` with
`action: "recover_result"` and `attempt: {reviewKey, reason}`. This republishes the retained result
without another model call, including when the peer is now disabled, exhausted or configured
differently. Recovery requires the original session and a branch that owns the same pending receipt:
the original branch remains eligible after navigating away and back, and a descendant may recover a
receipt it explicitly inherits. Unrelated branches cannot inspect or recover the retained report.
Navigation during recovery is fenced by the fresh recovery context. The retained in-memory result
is not a durable review receipt and can be lost on process exit until it is successfully saved;
the original tool result also disclosed the report.
The journal retains at most 32 entries and refuses new admission when it cannot evict a settled or
superseded entry; unresolved same-objective advice is not discarded to make room.
For a non-running pending or unavailable attempt, use `dispose_attempt` with
`attempt: {reviewKey, reason}` after inspecting its failure. This records the reason and current
candidate and releases capacity while preserving the original non-reviewed outcome. It works with
System One on or off, cannot dispose reviewed findings or an active request, and does not satisfy
the delivery-review requirement.

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
With System One enabled, findings and stated limitations open durable obligations in the receiving
lead's own lane: reproduce, revise confirmed
failures, and recheck before affected work continues. The session branch journal retains the full
bounded finding, candidate identity and scope across reopening. A trusted fork carries active
findings into its receiving lane and discards parent proof receipts.
`no_findings` never clears an earlier unresolved directive or certifies completion. Missing evidence,
malformed or truncated output, cancellation and service failures grant no validation. Reported peer
usage is retained even when its response is unusable. Permissions and approval remain host-owned.

With System One off, the same findings remain root-owned advice. After investigating them, use
`action: "acknowledge"` with `acknowledgement: {reviewKey, evidence}`. This records the root's concrete
evidence and decision, with the current candidate identity; it is labeled `root_decision_only`, never
System One validation. A repair may change the candidate before the root acknowledges the original
finding. An older unresolved finding does not disappear because a later review is clean. When System One
is on, `acknowledge` is unavailable: use the canonical receipt-based resolution below. A configured but
unavailable evaluator is not treated as off. A default, never-configured session with no credentials
uses deterministic operation without requiring a System One login.

The `mechanical_plus_reviewer` completion profile consumes the root's current delivery-review receipt
through the same peer owner; it does not dispatch a paid review automatically. Missing, stale,
incomplete or unresolved review evidence returns instructions to the root and keeps that requested
stage open. Mechanical criteria and current obligations still apply, and the completion coordinator
rechecks its candidate after consulting the peer. Default deterministic completion does not require
this optional profile or turn System One on.
With a configured peer model or fixed effort, reviewer-required completion needs a current receipt
matching that selection. Switching the peer does not clear older unresolved findings.

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
append-only) holds every stage transition, every System One evaluation and every route with its executor. The
objective's recent routes are a history block in the state the judge reads; "repeated without new
evidence" is one route on one evidence marker, twice. The root reads the ledger with
`decision_ledger_read` (`sessions`, `stages`, `evaluations`, `replay`); workers never do.

An evaluation may carry its decision trace: the decision code took, the gates it checked, the judgments
behind it (P(true) and band for a yes/no, P(chosen option) and the runner-up for a Choice, and whether each
drove the decision), short facts, the exit code took, and whether the answer came from the certificate cache.
Each yes/no judgment also carries the family and direction its consumer read it under, and its band is the
consumer's reading, not the engine's generic stamp: the operation gate (`operation_effect`, `operation_request`)
and plan review (`plan_review`) record theirs, so a trace shows the cut that actually decided. The recorder bounds
it (8 gates, 16 judgments, 8 facts, 120 characters per string) and redacts secrets before it is kept. A caller
attaches it with `noteTrace(evaluationId, trace)`, taking the id from `audit.evaluationId` of the recorded
evaluation; it works on an open evaluation, a settled one, and one no longer held in memory. The trace is
stored in the nullable `trace` column of `semantic_evaluations`, added to existing databases in place; a row
whose trace does not parse is read without one.

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
The host records this owner-model decision separately from the System One evaluation. A newer judgment
reopens its question; stale identities, questions explicitly scoped to a foreign root session and
failed journal writes cannot acknowledge it. Missing scope on a legacy evaluation remains unknown
and does not acquire root provenance during hydration. This advisory disposition does not alter System One
evidence or discharge mandatory same-lane verification, and grants no permission, certificate proof
or finding resolution. Independent authorized work continues while evidence is gathered.

## Verification

See `docs/doctrine.md`, section "System One", for the invariants; the tests that pinned them were removed on 2026-10-04 and are rebuilt by area.

## Where a judgment may stop work

`system-one/authority-line.ts` is the one table. Reversible work, and an operation code could not classify, proceeds past a doubt or an outage
with the doubt visible; an ambiguous judgment asks for evidence at most `GATHER_MORE_LIMIT` (2) times
per evidence revision. Received nonpassing JEV-024..028 judgments require verification in the
receiving lane in both policy modes. They keep completion open without dispatching a substitute
verifier or opening an owner-question latch. A bound completion transaction holds if either evidence-matrix stage or
the account evaluator is unavailable, in either steering mode. The diagnostic remains an evaluator problem; it neither
clears existing completion findings nor queues production repair tasks.
An irreversible or outward operation goes to the
operator, or is refused for a worker; an established outward effect the request does not ask for is refused. A Choice
is gated on P(chosen option) (`choiceGate`) and a Score on its confidence (`confidenceGate`); a Noul's
probability is its certainty (see Thresholds and readings).

Semantic project-rule judgment is opt-in per rule. System One judges an instruction-file bullet only when
the bullet carries the marker `<!-- system-one: phase=<mutation|task_postflight|completion> consequence=<low|medium|high|critical> -->`
(both fields optional; the defaults are `mutation` and `medium`). The marker is removed from the rule text, and the
rule's phase and consequence come from the marker alone. Bullets naming one of the mechanical checks (such as inline
imports) stay code checks. Every other bullet is guidance: the model reads it, and nothing judges a change against it.
Durable owner policies are process rules, so they are judged at task postflight and completion, never on a single edit.
Each phase sends one request (`rule_program_v2`) with one `violate::<rule id>` question per judged rule. The rules are
named state (`rules[i].text`) and so is the change (`change`): the edit's own unified patch, the content of a file the
write tool created, or the proof state at postflight and completion, bounded to 24 KiB with truncation flagged.
A settled "violates" is a candidate the receiving agent verifies. An undecided answer, a missing answer, an evaluator
outage or a session with no engine leave the rule in doubt, and every doubt gets the same handling. A mutation is kept
and its tool result names the rules to check (an outage also reports its operator diagnostic). At postflight and
completion the doubt is a verification obligation in the receiving lane, like a settled candidate. Current
verification receipts reach the recheck. Neither a doubt nor a candidate queues repair tasks.
Deterministic instruction violations retain their corrective work and transition checks.

The completion evaluation requires planted gaps to refuse completion and reports diagnostic notices separately.
An incomplete semantic assessment or evaluator error never counts as detecting a planted gap.

## Claims against deliveries

After every turn the final answer's claims (tests pass, committed, pushed, published, files changed)
are asked of System One one atomic question each, and each settled "the answer states X" is combined in code
with the turn's receipts: test verification records, git commit/push and publish exit status, and
successful edits. A contradicted claim buys one correction turn; an unbacked one is a warning.
The turn is found from the message it opened with, so a compaction inside the turn does not shift it: when the
compaction summarized that message, the turn is read from that checkpoint's summary on, without what the rebuild
carried forward from before the turn.

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
3. What stays open remains in the worker claim for parent investigation or a worker follow-up.
   At the turn boundary, the host separately classifies whether an item requires an owner-reserved
   decision. Only a decisive owner-reserved judgment creates an owner question; under a handoff it
   is written to `<agentDir>/follow-ups/<sessionId>.md`. Technical unknowns and unavailable or
   uncertain classifications remain parent-owned. None closes an objective or authorizes an
   irreversible action.

Settled items return to the parent as `System One settled: …` and no longer hold the claim for
review. Collaboration and herdr workers, whose transcripts the host cannot read, mark such findings
with `INCONCLUSIVE:` lines in their report; those enter the same parent-review and owner-decision
routing in step 3 without the host claiming to have inspected the worker's evidence.

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
from the owner's request, which code checks is in the owner's own words of the request (case, punctuation
and spacing folded; text the owner pasted does not count) and System One judges backs the answer; or on its own judgment, which stands only when System One decisively finds
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
