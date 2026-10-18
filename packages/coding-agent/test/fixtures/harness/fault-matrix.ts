/**
 * The recovery fault matrix: one frozen row per recovery behavior the harness witnesses or still has to witness.
 *
 * A covered row names the production owner whose recovery it proves, the journey and phase that force its fault, the existing
 * assertion that witnesses the recovery (`witness`) and the existing normal-order control (`control`). Each of those two assertion
 * points calls `world.faultMatrix.witness(id, { control })` right after the assertion passes. At close, every covered row of the
 * world's journey that declares the world's System One mode must hold both marks, the same way every armed IO and SQLite fault
 * must have fired. A row whose witness or control runs in only one mode declares only that mode.
 *
 * An open row names what is missing: a harness extension (X1..X9 of the fault census), a witness the harness can force today but
 * no journey asserts, a normal-order control no journey asserts with certainty, or the marks in a file this registry does not
 * edit. Open rows take no marks.
 *
 * `estSeconds` is an estimate of the wall time the row's fault and control cost one journey run in one mode (both modes count
 * twice), from the census cost basis: a virtual-timer witness about 0.3 s, a fresh owner with one scripted delegation about 1 s,
 * a restart cut 3 to 5 s, and real backoff waits at their asserted lower bounds. It is not a budget and nothing gates on it.
 */

export type FaultMatrixJourney = 1 | 2 | 3;
export type SystemOneMode = "on" | "off";
/** The harness extensions of the fault census that open rows wait for. */
export type HarnessExtension = "X1" | "X2" | "X3" | "X4" | "X5" | "X6" | "X7" | "X8" | "X9";

export type FaultMatrixGap =
	/** The fault cannot be forced until this harness extension exists. */
	| { readonly kind: "extension"; readonly extension: HarnessExtension; readonly detail: string }
	/** The harness can force the fault today, but no journey asserts its recovery. */
	| { readonly kind: "witness"; readonly detail: string }
	/** The recovery is witnessed, but no journey asserts a normal-order control for it with certainty. */
	| { readonly kind: "control"; readonly detail: string }
	/** Witness and control exist in a file this registry's marks do not edit yet; `anchors` are their assertion messages. */
	| { readonly kind: "mark"; readonly file: string; readonly anchors: readonly string[] };

interface FaultMatrixRowFields {
	readonly id: string;
	/** Production owner of the recovery, relative to packages/coding-agent/src. */
	readonly owner: string;
	readonly journey: FaultMatrixJourney;
	readonly phase: string;
	readonly fault: string;
	readonly witness: string;
	readonly control: string;
	readonly estSeconds: number;
}

export interface CoveredFaultMatrixRow extends FaultMatrixRowFields {
	readonly status: "covered";
	/** The System One modes in which both the witness and the control assertion run. */
	readonly modes: readonly SystemOneMode[];
}

export interface OpenFaultMatrixRow extends FaultMatrixRowFields {
	readonly status: "open";
	readonly needs: readonly FaultMatrixGap[];
}

export type FaultMatrixRow = CoveredFaultMatrixRow | OpenFaultMatrixRow;

const BOTH: readonly SystemOneMode[] = ["on", "off"];

const rows: readonly FaultMatrixRow[] = [
	{
		id: "R1",
		owner: "core/delegation/worker-write-reservation-coordinator.ts",
		journey: 1,
		phase: "write-reservations E13R",
		fault: "the retained release is refused until cleared; the backoff alarm climbs to its cap",
		witness: "a successful retry arms no further alarm",
		control: "no reservation diagnostic follows the cleared refusal",
		estSeconds: 0.3,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R2",
		owner: "core/delegation/worker-write-reservation-coordinator.ts",
		journey: 1,
		phase: "write-reservations E13/E13A",
		fault: "the owner process dies holding its exact lease",
		witness: "the recovery entrance releases the exact old reservation from the durable store",
		control:
			"a second owner's recovery entrance probes the live E13A owner pid with signal 0 and keeps its exact reservation durable",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R3",
		owner: "core/delegation/worker-write-reservation-coordinator.ts",
		journey: 1,
		phase: "write-reservations E13A",
		fault: "the reservation unlink fails after its effect landed",
		witness: "the E13A disposal certificate: the owner keeps its exact lease, hold and claim",
		control: "the E13 fresh owner, with no fault armed, discloses nothing at close",
		estSeconds: 0.5,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R4",
		owner: "core/delegation/worker-write-reservation-coordinator.ts",
		journey: 1,
		phase: "write-reservations E13J/E13W",
		fault: "the reservation observer close fails at teardown",
		witness:
			"the failed observer close keeps its native registration; the retained observer is cut off after the proof",
		// E13W now asserts more than one observer: the cwd and its filesystem root are distinct host workspaces, each watched.
		control:
			"the second host-workspace observer of the E13W teardown closes with no fault; only the faulted first remains",
		estSeconds: 0.5,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R5",
		owner: "core/delegation/worker-write-reservation-coordinator.ts",
		journey: 1,
		phase: "write-reservations E13",
		fault: "the required release fails at shutdown",
		witness: "the E13 disposal certificate: the retained lease, hold and claim stay the original ones",
		control: "the E13 fresh owner, with no fault armed, discloses nothing at close",
		estSeconds: 0.5,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R6",
		owner: "core/delegation/worker-recovery-coordinator.ts",
		journey: 1,
		phase: "write-reservations VU",
		fault: "a crash cut while the verifier runs",
		witness: "the verifier keeps its original grant to the end",
		control: "the settled recovery repeats no repair",
		estSeconds: 2,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R7",
		owner: "core/queued-input-persistence-controller.ts",
		journey: 1,
		phase: "host-shutdown queued quit restart",
		fault: "a crash cut after a queued owner input was promoted",
		witness:
			"cut while the promoted directive's own turn is held at before_agent_start (named by the queued record only), the restart's interrupt returns it to the queue held with one warning, and the next session restores it held, once",
		control: "the promoted directive whose turn ran and delivered it is not restored",
		estSeconds: 4,
		status: "covered",
		// The on-mode System One intake judgment set of the queued directives is not derivable by reading.
		modes: ["off"],
	},
	{
		id: "E7",
		owner: "core/delegation/worker-queued-context-recovery.ts",
		journey: 2,
		phase: "queued-recovery E7",
		fault: "a cut with a never-started queued worker behind a busy dead-owner worker",
		witness: "B resumes from its queued state and completes",
		control: "a repeated recovery repeats no B provider step",
		estSeconds: 4,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R8",
		owner: "core/delegation/session-root-mailbox.ts",
		journey: 2,
		phase: "queued-recovery E7",
		fault: "the mailbox target rename fails and its rollback rename fails too",
		witness: "the failed target leaves the root mailbox bytes unchanged",
		control: "the reply receipt is unchanged across the tail and the reply replay",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R9",
		owner: "core/delegation/worker-attempt-executor.ts",
		journey: 1,
		phase: "worker-budgets E8T",
		fault: "three transient provider failures inside one attempt",
		witness: "the second inner retry waits about twice the base",
		control: "the opaque failure announces no inner or ladder retry",
		estSeconds: 9,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "e8t",
		owner: "core/delegation/worker-recovery-coordinator.ts",
		journey: 1,
		phase: "worker-budgets E8T",
		fault: "the attempt fails transiently after its inner retries; the durable ladder alarm is armed on the orchestration timer",
		witness: "the fired ladder alarm leaves no alarm armed",
		control: "the one-attempt owner arms no ladder alarm",
		estSeconds: 0.3,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R10",
		owner: "core/memory/continuous-chat-work-queue.ts",
		journey: 1,
		phase: "continuous-chat I3",
		fault: "a transient 503 on the leaf-9 compaction",
		witness: "the combined ICM expectation: leaf9RetriedOnWorkerC",
		control: "the unfaulted leaf-3 compaction on the same summary track is served by its one script step",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R10s",
		owner: "core/memory/continuous-chat-runtime.ts",
		journey: 1,
		phase: "continuous-chat turn retry spacing",
		fault: "the leaf retry backoff spacing",
		witness: "the waiting turn retries its failed leaf after 1 s, then 2 s, and its third attempt opens the turn",
		control: "a leaf that fails with no turn waiting arms no retry alarm",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R11",
		owner: "core/agent-session.ts",
		journey: 1,
		phase: "host-shutdown compaction",
		fault: "the compaction terminal append is refused at quit",
		witness: "runCompactionCloseAppendRefused: the refused terminal is reported and nothing changes after it",
		control: "the committed entry carries the handler's summary (live compaction control)",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R12",
		owner: "core/operator-projection/decision-ledger-store.ts",
		journey: 1,
		phase: "owner-lifecycle SQLite",
		fault: "a one-shot SQLite exec failure of the ledger schema at construction",
		witness: "the schema exec failure is the scripted one; the failed construction leaves no handle",
		control: "the normal construction closes its handle",
		estSeconds: 0.1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R12a",
		owner: "core/context/sqlite-runtime-index.ts",
		journey: 1,
		phase: "owner-lifecycle SQLite",
		fault: "one-shot SQLite prepare (store factory) and run (release write) failures of the path-alias store",
		witness:
			"the prepare failure surfaces as the turn error and does not block disposal; a failed required SQL write must reject disposeAndWait",
		control: "a release without a fault must complete",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R13",
		owner: "core/human-input-controller.ts",
		journey: 1,
		phase: "owner-lifecycle ask",
		fault: "a durable cut while an ask is presented",
		witness:
			"the restored owner resumes the pending question; the terminal closes the canonical original start captured from the cut",
		control: "nothing is pending after the answer; the second resume appends no result and no terminal",
		estSeconds: 2,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R14",
		owner: "core/tool-applicability-gate.ts",
		journey: 1,
		phase: "owner-lifecycle take-back",
		fault: "an admitted input is taken back before delivery",
		witness: "the taken back input leaves the optional-tool chain as it was",
		control: "a committed revocation of the tool blocks it",
		estSeconds: 0.5,
		status: "covered",
		// The control's gate judgment exists only with System One on.
		modes: ["on"],
	},
	{
		id: "R14r",
		owner: "core/session-edge-intent-controller.ts",
		journey: 1,
		phase: "host-shutdown queued quit restart",
		fault: "a staged optional-tool intent across a quit and restart (the next session on the quit's file)",
		witness:
			"the quit holds the input its staged intent was judged for and commits no optional-tool entry, so the next session restores the input held with none",
		control:
			"the restored input, resent in the next session behind a held run, is judged afresh with the first process's question set and commits its classified intent once, at its delivery",
		// One extra gated run and its delivered turn on the restoring owner.
		estSeconds: 1,
		status: "covered",
		// A staged optional-tool intent exists only with System One on: off, nothing is judged or staged.
		modes: ["on"],
	},
	{
		id: "tab-preference",
		owner: "core/tool-applicability-gate.ts",
		journey: 1,
		phase: "owner-lifecycle tab preference",
		fault: "a queued follow-up's judgment is held at its gate until a later input's judgment supersedes it",
		witness: "the superseded inputs' owner policy is judged once each at their delivery, in owner order",
		control: "the newer input's revocation is the committed policy once it is delivered",
		estSeconds: 1,
		status: "covered",
		// Judgments are held and superseded only with System One on.
		modes: ["on"],
	},
	{
		id: "delivery-order",
		owner: "core/pending-input-queue-controller.ts",
		journey: 1,
		phase: "owner-lifecycle delivery order",
		fault: "a newer steer queued behind an older follow-up",
		witness:
			"the newer steer is delivered ahead of the older follow-up; an older delivery limit applied after a newer lift does not override the newer owner words",
		control: "newer owner words that lift the delivery limit lift it (the in-order memory-read turn)",
		estSeconds: 1,
		status: "covered",
		// The journey applies a delivery limit only with System One on: off, neither the limit nor the lift is exercised.
		modes: ["on"],
	},
	{
		id: "owner-input-crash-cut",
		owner: "core/owner-input-ledger.ts",
		journey: 1,
		phase: "owner-lifecycle delivery order",
		fault: "a cut of the session file between the queued record and the user entry",
		witness: "a delivered steer leaves the durable record only once its user entry is persisted",
		control: "the reopened session restores no queued input that was delivered",
		estSeconds: 0.1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R15",
		owner: "core/queued-input-persistence-controller.ts",
		journey: 1,
		phase: "host-shutdown queued quit",
		fault: "the quit ends a run with owner input queued behind it",
		witness: "the held run ends without an error, after no provider round for the held input",
		control: "the queued input runs as the turn after the completed reply",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R15r",
		owner: "core/queued-input-persistence-controller.ts",
		journey: 1,
		phase: "host-shutdown queued quit restart",
		fault: "the held input is restored by the next session",
		witness: "the next session restores the held follow-up, held, as its record names it",
		control: "the next session restores no queued input that was delivered",
		estSeconds: 2,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R15k",
		owner: "core/pending-input-queue-controller.ts",
		journey: 1,
		phase: "host-shutdown queued quit restart",
		fault: "owner input kept while it cannot be submitted (the interactive compaction queue) outlives its process",
		witness: "the next session restores the kept input, held",
		control: "the next session restores no kept input the owner took back",
		estSeconds: 2,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "owner-input-preflight-restart",
		owner: "core/pending-input-queue-controller.ts",
		journey: 1,
		phase: "host-shutdown queued quit restart",
		fault: "a quit while a prompt's own turn is prepared (accepted, its user entry not persisted yet)",
		witness:
			"the prompt the quit cut is not accepted, and ends held because the session closed; the next session restores the prompt the quit cut, held, and not the interrupted one",
		control: "the interrupted prompt is not accepted, and ends cancelled by the interrupt",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "owner-input-preflight-crash",
		owner: "core/queued-input-persistence-controller.ts",
		journey: 1,
		phase: "host-shutdown queued quit restart",
		fault: "a crash while a prompt's own turn is prepared (accepted, its user entry not persisted yet)",
		witness:
			"cut back to the session file and own-turn record captured while the prompt waits in its input hook, the next session restores the prompt held with its one notice",
		control:
			"the restart's interrupt ends the prompt cancelled, not accepted, and removes its own-turn record before the cut",
		estSeconds: 4,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "owner-input-kept-submit",
		owner: "core/prompt-submission-controller.ts",
		journey: 2,
		phase: "queued-recovery kept input",
		fault: "a kept input submitted after compaction, and a submission that became queued while its preemption awaited",
		witness:
			"each kept input runs as its own turn once, and the late-queued follow-up is delivered once after the leading turn",
		control:
			"a kept input taken back submits nothing, and a follow-up submitted while the turn is in flight is pending from its submission",
		// One fresh owner, five plain turns.
		estSeconds: 2,
		status: "covered",
		// The owner runs System One off in its own binding, so both world modes run the witness and the control.
		modes: BOTH,
	},
	{
		id: "goal-execution-submission-release",
		owner: "core/goals/goal-session-controller.ts",
		journey: 1,
		phase: "host-shutdown mode witnesses retry",
		fault: "a run that delivered a queued chat-goal input ends with an abandoned retry before the next prompt",
		witness:
			"the retry abandoned from its start announcement is cancelled; the next prompt begins its own goal execution after a run that ended with an abandoned retry",
		control:
			"the retry of the goal turn recovers; the next prompt begins its own goal execution after a run whose retry recovered",
		// Two fresh owners, each with three or four scripted provider turns and a 5 ms retry backoff.
		estSeconds: 1,
		status: "covered",
		// The owners run System One off in their own binding (the queued goal's authority is parsed, never judged), so both world
		// modes run the witness and the control.
		modes: BOTH,
	},
	{
		id: "R16",
		owner: "core/session-tree-navigator.ts",
		journey: 1,
		phase: "intent-and-branching S4",
		fault: "a branch summary is superseded while owner input is held",
		witness: "the held input is never admitted to the branch",
		control: "the idle reload rebuilds the current branch context",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R17",
		owner: "core/foreground-recovery-controller.ts",
		journey: 1,
		phase: "intent-and-branching E4",
		fault: "navigation while a run is active",
		witness:
			"a navigation while the run owns the history is refused with the exact text, and the leaf and entries are unchanged",
		control: "the idle navigation moves the tree to the owner parent",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R18",
		owner: "core/background-tool-task-controller.ts",
		journey: 2,
		phase: "background-and-stall",
		fault: "the background terminal delivery to the idle root is refused",
		witness:
			"the denied wake-up append leaves the completed terminal pending with no wake-up entry and one retrying warning whose cause is the session-file fence",
		control: "orchestration E aux: the same idle-root terminal with an accepting session file is recorded delivered",
		estSeconds: 1,
		status: "covered",
		// The on-mode System One judgment set for these idle-root wake-up turns is not derivable by reading.
		modes: ["off"],
	},
	{
		id: "R19",
		owner: "core/background-tool-task-controller.ts",
		journey: 2,
		phase: "background-and-stall",
		fault: "the wake-up delivery is rejected until the queue parks",
		witness:
			"nine single-alarm retries at 100, 200, 400, 800, 1600 and 4 x 3200 ms, then the park warning; no alarm is armed after the park and one denied append in all",
		control: "after the reopen, deliveries accepted at their first attempt arm no retry and add no warning",
		estSeconds: 0.5,
		status: "covered",
		// The on-mode System One judgment set for these idle-root wake-up turns is not derivable by reading.
		modes: ["off"],
	},
	{
		id: "R20",
		owner: "core/background-tool-task-controller.ts",
		journey: 2,
		phase: "background-and-stall",
		fault: "a parked queue re-armed by a task event or resume",
		witness:
			"after the session file is reopened, the next background task start re-arms the parked wake-up: it is delivered to the idle root and recorded delivered",
		control: "the re-arming task's own terminal is delivered after it, in order",
		estSeconds: 1,
		status: "covered",
		// The on-mode System One judgment set for these idle-root wake-up turns is not derivable by reading.
		modes: ["off"],
	},
	{
		id: "R21",
		owner: "core/background-tool-task-controller.ts",
		journey: 2,
		phase: "queued-recovery",
		fault: "a cut while a background task is running",
		witness:
			"cut back to the session file captured while the held echo runs, the next session records the task failed with its owning process gone and delivers that terminal to the idle root as a wake turn",
		control: "without the cut, the disposal records the running task canceled with its wake-up pending",
		estSeconds: 4,
		status: "covered",
		// The on-mode System One judgment set for the background start and the idle-root wake-up turn is not derivable by reading.
		modes: ["off"],
	},
	{
		id: "R22",
		owner: "core/background-tool-task-controller.ts",
		journey: 1,
		phase: "owner-lifecycle cleanup",
		fault: "the background shutdown grace watchdog expires for a background command that ignores its cancellation",
		witness:
			"the background shutdown grace watchdog expires for an execution that ignores its cancellation; the held command ran to its end after the shutdown",
		control: "an execution that honours its cancellation settles inside the shutdown grace",
		// Two fresh owners with one background turn each. A background command runs detached (no session lane), so the
		// session's shell release does not wait on it on either platform; the grace runs on the virtual clock.
		estSeconds: 2,
		status: "covered",
		// The owners run System One off in their own binding, so both world modes run the witness and the control.
		modes: BOTH,
	},
	{
		id: "R23",
		owner: "core/foreground-recovery-controller.ts",
		journey: 1,
		phase: "host-shutdown mode witnesses retry",
		fault: "a retryable foreground provider error (network error) and the retry-window close during its backoff",
		witness:
			"the backoff close: post-close cancellation remains durable although the session listener is already removed (Retry cancelled)",
		control: "the live retry: backoff expiry retries and live delivery persists the complete payload",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R23c",
		owner: "core/foreground-recovery-controller.ts",
		journey: 1,
		phase: "host-shutdown mode witnesses retry",
		fault: "a retryable provider error before the response starts (connect error), and one after partial frames",
		witness:
			"connect-control and partial-control: the failed response starts with its error only when the transport failed before the response began; the failed stream delivered its partial frames before its error",
		control: "the live retry (mid-stream fail() shape): the same retry, delivery and response-start assertions",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R24",
		owner: "core/foreground-recovery-controller.ts",
		journey: 1,
		phase: "intent-and-branching S4",
		fault: "a foreground idle waiter parked behind a history rewrite (a held summarized navigation) resumes when the rewrite settles",
		witness: "the parked idle waiter resumes once the navigations settle, on the foreground activity it waited for",
		control: "an idle waiter on an idle foreground starts no wait when called",
		estSeconds: 0.1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R25",
		owner: "core/provider-admission/gate.ts",
		journey: 2,
		phase: "orchestration E aux",
		fault: "a worker request meets a model quota exhaustion recorded with a reset (the foreground has no usage-limit wait: a foreground quota refusal stops its run and holds queued input, R45u)",
		witness: "the passed reset ends the wait, satisfied by the reset alarm",
		control: "the worker request before the record (the handoff reader, on worker-c) passed admission with no wait",
		estSeconds: 2,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R26",
		owner: "core/memory-controller.ts",
		journey: 2,
		phase: "continuous-chat",
		fault: "ICM recovery waits on a lease event; a settings change does not recycle the host",
		witness:
			"the settings change made while the turn held the foreground recovers the chat once, after the turn released it",
		control: "a settings change on a live ICM host does not recycle it",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R27",
		owner: "core/memory/continuous-chat-store.ts",
		journey: 2,
		phase: "continuous-chat",
		fault: "the ICM runtime lease owner is dead",
		witness: "a fresh root takes over the runtime lease its dead owner left",
		control: "runtime.lease.json blocks a second live root on the same continuous-chat store",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R28",
		owner: "core/delegation/worker-lease-heartbeat.ts",
		journey: 2,
		phase: "background-and-stall lease renewal",
		fault: "the lease renewal fails while running",
		witness: "the failed renewal aborts the lane, cancelled as worker_delegation_error, and wakes the root once",
		control: "a heartbeat inside the lease renews it, re-arms, warns nothing and keeps the worker running",
		estSeconds: 2,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R29",
		owner: "core/goals/goal-auto-continue-controller.ts",
		journey: 2,
		phase: "background-and-stall aux",
		fault: "the workerDeadline wake of a goal waiting on a bound worker fires",
		witness:
			"advancing goal-continuation by DEFAULT_GOAL_WORKER_WAIT_MS fires the wake once; its pass runs on worker_wait_timeout, and its one turn spends the owner's budget, leaving the goal budget_limited with nothing armed and no warning",
		control:
			"the idle root waits on the bound worker until boundAt plus the maximum wait, and its only goal-continuation alarm is that deadline",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R30",
		owner: "core/delegation/worker-recovery-coordinator.ts",
		journey: 2,
		phase: "orchestration E aux",
		fault: "a durable read fault when a retained worker retry comes due re-arms its retry timer (an enqueue fault takes the same retainFailedRetry backoff)",
		witness: "the failed read re-arms the retry on its first backoff",
		control: "the clear read enqueues the retry and arms nothing",
		estSeconds: 7,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R31",
		owner: "core/delegation/worker-notification-coordinator.ts",
		journey: 2,
		phase: "orchestration E aux",
		fault: "a worker terminal handoff's notify() rejects once without fencing the session (the SDK's workerTerminalDelivery interposition refuses one delivery undelivered)",
		witness: "the refused delivery arms the outbox's first retry backoff",
		control: "the idle root reads the retried terminal exactly once",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R32",
		owner: "core/delegation/worker-agent-control-coordinator.ts",
		journey: 2,
		phase: "orchestration E aux",
		fault: "a durable cancel of a queued lane fails: the store refuses its cancellation event write",
		witness: "the failed cancel leaves the queued lane durably queued",
		control: "the retained cancellation commits with the owner's reason on the next scheduler signal",
		estSeconds: 2,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R33",
		owner: "core/delegation/managed-lane-controller.ts",
		journey: 1,
		// The owner runs System One off in its own binding and its own agent directory, so both world modes run both marks.
		phase: "worker-budgets R33",
		fault: "a legacy managed lane is adopted",
		witness:
			"the first lane read adopts the running legacy tmux-worker snapshot as one running managed lane with its own reload blocker",
		control: "the terminal legacy snapshot of the same branch is not adopted",
		estSeconds: 0.5,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R34",
		owner: "core/foreground-terminal-handoff-controller.ts",
		journey: 2,
		phase: "queued-recovery",
		fault: "terminal handoffs pending across a restart",
		witness:
			"cut back to the session file and orchestration bundle captured while the ended reader's handoff waits for the held foreground, the next owner replays the pending worker-terminal receipt and delivers it once: its first root request carries the handoff, the receipt reads delivered and its branch holds one handoff post; the dying owner's optional wake is consumed or retired",
		control:
			"while another submission holds the foreground, the ended reader's terminal waits in the lease wait with its durable receipt pending and nothing posted",
		estSeconds: 4,
		status: "covered",
		// The on-mode System One judgment set of a dying-owner wake turn that may or may not run cannot be declared.
		modes: ["off"],
	},
	{
		id: "R35",
		owner: "core/foreground-terminal-handoff-controller.ts",
		journey: 2,
		phase: "background-and-stall aux",
		fault: "a handoff that wakes no turn with buffered owner items",
		witness:
			"the terminal of a worker whose goal stopped as budget_limited posts its not-woken follow-up, then flushes the ladder's buffered unsettled item as the owner items message, with no root request",
		control: "nothing reached the owner before that worker ended",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R36",
		owner: "core/owner-input-ledger.ts",
		journey: 1,
		phase: "host-shutdown queued quit restart",
		fault: "owner words judged at acceptance survive a reopen",
		witness:
			"a directive judged at acceptance and cut before its delivery is restored held by the next session, and its delivered-only effect (the owner rule) never ran",
		control: "the directive delivered before the cut is the owner's rule, and that rule survives the reopen",
		estSeconds: 4,
		status: "covered",
		// Off mode judges the queued words as skipped (the ledger still moves them to judged); the on-mode intake set is not derivable.
		modes: ["off"],
	},
	{
		id: "R37",
		owner: "core/tools/delegate.ts",
		journey: 1,
		phase: "write-reservations E13Q",
		fault: "a reused specialist's task is queued behind a retained reservation",
		witness: "the model reads the E13Q reservation wait",
		control: "the E13Q writer's unqueued start reads delegate started (running)",
		estSeconds: 0.3,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R38",
		owner: "core/objective-execution/session-objective-runtime.ts",
		journey: 3,
		phase: "continuous-chat unproven completion",
		fault: "a completed goal whose requirements lack trusted evidence reopens to active",
		witness:
			"the default loop's continuation over a persisted completed goal with an unproven requirement and no acceptance override reopens it to active with one warning and runs no turn",
		control:
			"the same continuation over a completed goal with trusted evidence keeps it completed, evaluates no route and runs no turn",
		estSeconds: 1,
		status: "covered",
		modes: ["on"],
	},
	{
		id: "R38e",
		owner: "core/goals/goal-session-controller.ts",
		journey: 3,
		phase: "continuous-chat unproven completion",
		fault: "a completed goal whose requirements lack trusted evidence reaches the legacy continuation entry",
		witness:
			"the legacy loop's continuation over a persisted completed goal with an unproven requirement and no acceptance override reopens it to active with one warning, asks System One nothing and runs no turn",
		control:
			"the same continuation over a completed goal with trusted evidence keeps it completed, asks System One nothing and runs no turn",
		estSeconds: 1,
		status: "covered",
		modes: ["off"],
	},
	{
		id: "R38l",
		owner: "core/goals/goal-session-controller.ts",
		journey: 3,
		phase: "continuous-chat unproven completion loop",
		fault: "the continuation loop starts over a completed goal whose requirements lack trusted evidence",
		witness:
			"the loop reopens it to active with one warning and runs the reopened goal's one root turn (on: the primary guard lets it through, one cycle reopens, the next admits, routes and runs the turn; off: the legacy entry reopens and the native loop runs it)",
		control:
			"the loop over a completed goal with trusted evidence stops at once with continuation_not_allowed, completed, asking System One nothing and running no turn",
		estSeconds: 2,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R39",
		owner: "core/goals/goal-auto-continue-controller.ts",
		journey: 2,
		phase: "background-and-stall goal auto-continue",
		fault: "the goal auto-continue timer fires",
		witness: "the fired wake runs one pass on the active goal, whose charge stops the goal with nothing armed",
		control: "the wake does not fire before its delay and no pass is submitted",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R40",
		owner: "utils/work-directory.ts",
		journey: 1,
		phase: "host-shutdown SDK construction",
		fault: "a refused work-directory prune",
		witness: "SDK_CONSTRUCTION_FAILURE_EXPECTED.workDirectory: retriedPrune removes the refused directory",
		control: "SDK_CONSTRUCTION_FAILURE_EXPECTED.workDirectory: leasedControl and unleasedControl",
		estSeconds: 0.5,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R40e",
		owner: "core/background-tool-task-controller.ts",
		journey: 2,
		phase: "background-and-stall",
		fault: "the terminal-task cache evicts a finished task whose output is an artifact",
		witness:
			"a wait on the evicted first task returns its saved completed record naming the same artifact, the task list no longer shows it, and the artifact's tail reads back through artifact_retrieve",
		control: "the retained second task's wait is answered from the cache with its own artifact",
		estSeconds: 1,
		status: "covered",
		// With System One on the idle root turns ask judgments no reading derives, as for R18.
		modes: ["off"],
	},
	{
		id: "R41",
		owner: "utils/work-directory.ts",
		journey: 1,
		phase: "host-shutdown SDK construction",
		fault: "work-directory acquisition race, recovery refusal, unreadable snapshot and adoption",
		witness: "SDK_CONSTRUCTION_FAILURE_EXPECTED.workDirectory",
		control: "SDK_CONSTRUCTION_FAILURE_EXPECTED.workDirectory: the control and surviving-marker entries",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R42",
		owner: "modes/interactive/signal-lifecycle.ts",
		journey: 1,
		phase: "host-shutdown signal, rpc and SDK",
		fault: "signal, rpc and SDK shutdown or construction steps fail",
		witness: "a failing quit with three causes writes no resume line; a failing dispose still releases the stream",
		control: "the quit path prints the resume command; the SIGTERM shutdown flushes the stream once",
		estSeconds: 2,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R43",
		owner: "core/memory/continuous-chat-legacy-import.ts",
		journey: 3,
		phase: "continuous-chat legacy import",
		fault: "the legacy session read is denied",
		witness: "the blocked import met the unreadable source",
		control: "after repairing the blocked session file, legacy import retries and writes migration.json",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R44",
		owner: "core/worktree-sync/git-engine.ts",
		journey: 3,
		phase: "worktree-and-gates E12",
		fault: "the epoch rename fails after main moved",
		witness: "the first reconcile appends exactly one epoch_reconciled audit event",
		control: "the second reconcile leaves the persisted epoch, transaction and audit log unchanged",
		estSeconds: 2,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R45",
		owner: "core/runtime-update-controller.ts",
		journey: 1,
		phase: "host-shutdown runtime-update stop",
		fault: "a runtime-update stop with owner input queued (the usage-limit stop is R45u)",
		witness:
			"stop: after a verified reload the agent stops the update while a steer is queued; the run ends with no round for it and holds it, complete, in the pending queue with its turn-ended notice",
		control: "complete: the same update completed instead delivers the queued steer as the next turn",
		// Two fresh owners, three and four scripted provider turns, one in-process runtime reload each.
		estSeconds: 1,
		status: "covered",
		// The owners run System One off in their own binding (the steer is admitted unjudged), so both world modes run them.
		modes: BOTH,
	},
	{
		id: "R45u",
		owner: "core/foreground-recovery-controller.ts",
		journey: 1,
		phase: "host-shutdown mode witnesses retry",
		fault: "a metered usage-limit (quota) refusal stops the run with owner input queued",
		witness:
			"usage-limit: the metered usage-limit stop gives its halt notice, then holds the queued input its run no longer delivers",
		control: "stranded-control: a failed run that is not stopped on a usage limit delivers its queued input",
		estSeconds: 0.5,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R46",
		owner: "core/pending-input-queue-controller.ts",
		journey: 2,
		phase: "orchestration E aux",
		fault: "an owner steer arrives during a delegate wait on a held worker (the background-lane worker wait)",
		witness: "the steered wait's details: not timed out, steered",
		control: "the unsteered wait's details: timed out, not steered",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "steer-ended-tool-task-wait",
		owner: "core/tools/tool-task.ts",
		journey: 2,
		phase: "orchestration E aux",
		fault: "an owner steer arrives during a tool_task wait",
		witness: "the steer re-runs nothing",
		control: "one typed end per wait on the status stream, in order (steered, then timed_out)",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R47",
		owner: "core/util/atomic-file.ts",
		journey: 2,
		phase: "orchestration E aux",
		fault: "the orchestration event store's sync lock is held elsewhere: its attempts back off on the session timer source's sleepSync",
		witness: "the held lock backed off by its default schedule on the session's sleep",
		control: "every earlier store lock was free: no gap was asked for",
		estSeconds: 0.5,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R47w",
		owner: "core/util/atomic-file.ts",
		journey: 3,
		phase: "worktree-and-gates E12",
		fault: "an atomic-file write's rename fails twice with a share-mode EPERM",
		witness:
			"the first reconcile's epoch replacement arms the first two backoffs of the doubling ladder on the session's worktree-sync clock, and the third rename lands the record",
		control:
			"a rename failure outside the share-mode codes (the second landing's EIO epoch rename) arms no backoff: the landing returns on the unadvanced virtual clock and nothing is left armed",
		estSeconds: 0.5,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R48",
		owner: "core/operator-projection/decision-ledger-store.ts",
		journey: 1,
		phase: "host-shutdown SQLite busy",
		fault: "the ledger's schema exec answers SQLITE_BUSY until cleared, across two constructions",
		witness: "no busy construction leaves a handle",
		control: "the construction after the busy window closes its handle",
		estSeconds: 0.1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R48s",
		owner: "core/session-semantic-plane-controller.ts",
		journey: 1,
		phase: "owner-lifecycle ledger owners",
		fault: "a decision ledger whose open meets a busy database inside a live session",
		witness:
			"each use of the ledger while the database is busy retries the open; the first use after the database clears opens the ledger",
		control:
			"the permanently failed ledger is not opened again while the database is busy; the permanently failed ledger stays unavailable for its session after the database clears",
		// Two fresh owners, no turn: the faults are armed across their creation while no other session is live.
		estSeconds: 1,
		status: "covered",
		// The owners run System One off in their own binding, so both world modes run the witness and the control.
		modes: BOTH,
	},
	{
		id: "R49",
		owner: "core/operator-projection/decision-ledger-store.ts",
		journey: 1,
		phase: "owner-lifecycle SQLite",
		// The SQLite half of a crash cut, on the real store with every handle closed; the session-owner cut through
		// `world.restart({ rewindSqlite })` is the restart primitive's own path and is not what this row asserts.
		fault: "the SQLite state of a crash cut rewound to its durable point (decision-ledger store, every handle closed)",
		witness: "the decision written after the durable point is gone after the rewind",
		control: "the decision written before the durable point is read back unchanged",
		estSeconds: 0.1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R50",
		owner: "core/memory/providers/transcript-recall.ts",
		journey: 1,
		// The memory gate owner runs System One off in its own binding, so both world modes run the witness and the control.
		phase: "write-reservations memory gate",
		fault: "the transcript recall worker hangs on a read, then loses its transport while answering one",
		witness:
			"the held read times out at its 1000 ms bound with the worker still active and the late answer settles nothing; the undeliverable answer stops the worker and its read settles once with that cause",
		control: "the normal turn's unheld history read is answered and reported as queried",
		estSeconds: 1.5,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "R50l",
		owner: "core/tool-recovery-logger.ts",
		journey: 2,
		phase: "background-and-stall",
		fault: "the tool recovery log worker loses its transport on a batch's acknowledgement, and a later acknowledgement never arrives at the close",
		witness:
			"the lost acknowledgement is one crash that drops its batch and allows one respawn; the close flush ends at its 200 ms bound past a held acknowledgement",
		control:
			"an acknowledged batch leaves one worker with nothing dropped, and the respawned worker acknowledges the next batch",
		estSeconds: 1,
		status: "covered",
		// The failed tool calls ask judgments with System One on that no reading derives, as for R18.
		modes: ["off"],
	},
	{
		id: "E13R",
		owner: "core/delegation/worker-write-reservation-coordinator.ts",
		journey: 1,
		phase: "write-reservations E13R",
		fault: "the settled lane hands its refused release to the retained retry while a writer waits on the scope",
		witness: "the waiting writer runs no request while the record is durable",
		control: "no reservation diagnostic follows the cleared refusal",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "E13Q",
		owner: "core/delegation/worker-dispatch-scheduler.ts",
		journey: 1,
		phase: "write-reservations E13Q",
		fault: "each reuse entrance queues a specialist turn behind a retained record",
		witness: "at the E13Q queued turn's first request the only held lease is its own",
		control: "the disposed E13Q owner leaves no retry alarm armed",
		estSeconds: 3,
		status: "covered",
		modes: BOTH,
	},
	{
		id: "E13H",
		owner: "core/delegation/worker-delegation-controller.ts",
		journey: 1,
		phase: "write-reservations E13H",
		fault: "the settled execution's project release is refused; its hold and claim go to the controller's retry",
		witness: "at the queued turn's first request it holds its own execution and the kept claim",
		control: "no release diagnostic follows the cleared refusal",
		estSeconds: 1,
		status: "covered",
		modes: BOTH,
	},
];

function freezeRows(source: readonly FaultMatrixRow[]): ReadonlyMap<string, FaultMatrixRow> {
	const byId = new Map<string, FaultMatrixRow>();
	for (const row of source) {
		if (byId.has(row.id)) throw new Error(`fault matrix row ${row.id} is registered twice`);
		if (row.status === "covered" && row.modes.length === 0)
			throw new Error(`covered fault matrix row ${row.id} declares no System One mode`);
		if (row.status === "open" && row.needs.length === 0)
			throw new Error(`open fault matrix row ${row.id} names nothing it is missing`);
		byId.set(row.id, Object.freeze(row));
	}
	return byId;
}

/** Every recovery row, by id. */
export const FAULT_MATRIX: ReadonlyMap<string, FaultMatrixRow> = freezeRows(rows);

/** One world's fault and control marks: the world runs one journey in one System One mode. */
export class FaultMatrixMarks {
	readonly journey: FaultMatrixJourney;
	readonly mode: SystemOneMode;
	private readonly faults = new Set<string>();
	private readonly controls = new Set<string>();

	constructor(journey: FaultMatrixJourney, mode: SystemOneMode) {
		this.journey = journey;
		this.mode = mode;
	}

	/** Marks the row's fault witness (`control: false`) or its normal-order control (`control: true`) as passed. */
	witness(id: string, options: { readonly control: boolean }): void {
		const row = FAULT_MATRIX.get(id);
		if (row === undefined) throw new Error(`fault matrix row ${id} is not registered`);
		if (row.journey !== this.journey)
			throw new Error(`fault matrix row ${id} belongs to journey ${row.journey}, not journey ${this.journey}`);
		if (row.status !== "covered") throw new Error(`fault matrix row ${id} is open and takes no marks`);
		if (!row.modes.includes(this.mode))
			throw new Error(`fault matrix row ${id} does not declare System One ${this.mode}`);
		(options.control ? this.controls : this.faults).add(id);
	}

	/** Every covered row of this journey that declares this mode holds both its fault mark and its control mark. */
	assertCovered(): void {
		const missing: string[] = [];
		for (const row of FAULT_MATRIX.values()) {
			if (row.status !== "covered" || row.journey !== this.journey || !row.modes.includes(this.mode)) continue;
			const absent = [
				...(this.faults.has(row.id) ? [] : ["fault"]),
				...(this.controls.has(row.id) ? [] : ["control"]),
			];
			if (absent.length > 0) missing.push(`${row.id} (${absent.join(", ")})`);
		}
		if (missing.length > 0)
			throw new Error(
				`Fault matrix rows of journey ${this.journey}, System One ${this.mode}, missing marks: ${missing.join("; ")}`,
			);
	}
}
