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
const OWNER_LIFECYCLE = "journeys/journey-1-owner-lifecycle.ts";
const NONE = "none";

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
		phase: "write-reservations E13",
		fault: "the owner process dies holding its exact lease",
		witness: "the recovery entrance releases the exact old reservation from the durable store",
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [
			{
				kind: "control",
				detail:
					"no journey asserts that a live owner's lease probed with signal 0 is kept; E13R's live owner is a local conflict",
			},
		],
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
		control: NONE,
		estSeconds: 0.5,
		status: "open",
		needs: [
			{
				kind: "control",
				detail:
					"E13W asserts at least one observer, so a second observer that closes cleanly is not certain to exist",
			},
		],
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
		journey: 2,
		phase: "queued-recovery",
		fault: "a crash cut after a queued owner input was promoted",
		witness: NONE,
		control: NONE,
		estSeconds: 4,
		status: "open",
		needs: [
			{
				kind: "extension",
				extension: "X2",
				detail:
					"the E7 cut recovers a queued worker, not a promoted owner input; a restart with a promoted input in flight is needed",
			},
		],
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
		owner: "core/memory/continuous-chat-work-queue.ts",
		journey: 1,
		phase: "continuous-chat I3",
		fault: "the leaf retry backoff spacing",
		witness: NONE,
		control: NONE,
		estSeconds: 0.3,
		status: "open",
		needs: [
			{
				kind: "extension",
				extension: "X1",
				detail: "the census files the leaf retry spacing under X1; its delay is not asserted on virtual time",
			},
		],
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
		fault: "one-shot SQLite exec, prepare and run failures",
		witness: "the schema exec failure is the scripted one; a failed required SQL write must reject disposeAndWait",
		control: "a release without a fault must complete",
		estSeconds: 1,
		status: "open",
		needs: [
			{
				kind: "mark",
				file: OWNER_LIFECYCLE,
				anchors: [
					"a failed required SQL write must reject disposeAndWait",
					"a release without a fault must complete",
				],
			},
		],
	},
	{
		id: "R13",
		owner: "core/human-input-controller.ts",
		journey: 1,
		phase: "owner-lifecycle ask",
		fault: "a durable cut while an ask is presented",
		witness: "the ask recovered after the cut",
		control: "the ask presentation of the live owner",
		estSeconds: 2,
		status: "open",
		needs: [{ kind: "mark", file: OWNER_LIFECYCLE, anchors: ["ask.presented"] }],
	},
	{
		id: "R14",
		owner: "core/tool-applicability-gate.ts",
		journey: 1,
		phase: "owner-lifecycle take-back",
		fault: "an admitted input is taken back before delivery",
		witness: "the taken back input leaves the optional-tool chain as it was",
		control: "a committed revocation of the tool blocks it (System One on only)",
		estSeconds: 0.5,
		status: "open",
		needs: [
			{
				kind: "mark",
				file: OWNER_LIFECYCLE,
				anchors: [
					"the taken back input leaves the optional-tool chain as it was",
					"a committed revocation of the tool blocks it",
				],
			},
		],
	},
	{
		id: "R14r",
		owner: "core/tool-applicability-gate.ts",
		journey: 2,
		phase: "queued-recovery",
		fault: "a staged optional-tool intent across a restart",
		witness: NONE,
		control: NONE,
		estSeconds: 4,
		status: "open",
		needs: [{ kind: "extension", extension: "X2", detail: "a restart with a staged intent in flight" }],
	},
	{
		id: "tab-preference",
		owner: "core/tool-applicability-gate.ts",
		journey: 1,
		phase: "owner-lifecycle tab preference",
		fault: "a follow-up judged while an older input is held",
		witness: "tab-preference.held",
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "mark", file: OWNER_LIFECYCLE, anchors: ["tab-preference.held"] }],
	},
	{
		id: "delivery-order",
		owner: "core/pending-input-queue-controller.ts",
		journey: 1,
		phase: "owner-lifecycle delivery order",
		fault: "a newer steer queued behind an older follow-up",
		witness: "the newer steer is delivered ahead of the older follow-up",
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [
			{
				kind: "mark",
				file: OWNER_LIFECYCLE,
				anchors: ["the newer steer is delivered ahead of the older follow-up"],
			},
		],
	},
	{
		id: "owner-input-crash-cut",
		owner: "core/owner-input-ledger.ts",
		journey: 1,
		phase: "owner-lifecycle delivery order",
		fault: "a cut of the session file between the queued record and the user entry",
		witness: "a delivered steer leaves the durable record only once its user entry is persisted",
		control: NONE,
		estSeconds: 0.5,
		status: "open",
		needs: [
			{
				kind: "mark",
				file: OWNER_LIFECYCLE,
				anchors: ["a delivered steer leaves the durable record only once its user entry is persisted"],
			},
		],
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
		journey: 2,
		phase: "queued-recovery",
		fault: "the held input is restored by the next session",
		witness: NONE,
		control: NONE,
		estSeconds: 4,
		status: "open",
		needs: [{ kind: "extension", extension: "X2", detail: "a restart that reopens the held queue" }],
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
		owner: "core/reload-blockers.ts",
		journey: 1,
		phase: "intent-and-branching",
		fault: "navigation while a run is active",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "extension", extension: "X6", detail: "a run-active navigation probe" }],
	},
	{
		id: "R18",
		owner: "core/background-tool-task-controller.ts",
		journey: 2,
		phase: "orchestration",
		fault: "the background terminal delivery to the idle root is refused",
		witness: NONE,
		control: "terminalDelivery is delivered (happy path only)",
		estSeconds: 2,
		status: "open",
		needs: [{ kind: "extension", extension: "X5", detail: "a persistent append denial on the delivery" }],
	},
	{
		id: "R19",
		owner: "core/background-tool-task-controller.ts",
		journey: 2,
		phase: "orchestration",
		fault: "the wake-up delivery is rejected until the queue parks",
		witness: NONE,
		control: NONE,
		estSeconds: 2,
		status: "open",
		needs: [{ kind: "extension", extension: "X5", detail: "a persistent append denial driving the backoff to park" }],
	},
	{
		id: "R20",
		owner: "core/background-tool-task-controller.ts",
		journey: 2,
		phase: "orchestration",
		fault: "a parked queue re-armed by a task event or resume",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "extension", extension: "X5", detail: "depends on R19's parked queue" }],
	},
	{
		id: "R21",
		owner: "core/background-tool-task-controller.ts",
		journey: 2,
		phase: "queued-recovery",
		fault: "a cut while a background task is running",
		witness: NONE,
		control: NONE,
		estSeconds: 4,
		status: "open",
		needs: [{ kind: "extension", extension: "X2", detail: "a restart cut with a live background execution" }],
	},
	{
		id: "R22",
		owner: "core/background-tool-task-controller.ts",
		journey: 1,
		phase: "owner-lifecycle cleanup",
		fault: "the background shutdown grace watchdog expires",
		witness: NONE,
		control: NONE,
		estSeconds: 0.5,
		status: "open",
		needs: [
			{
				kind: "witness",
				detail:
					"shutdown rejects with the retained cleanup failure, but the watchdog expiry itself is not asserted",
			},
		],
	},
	{
		id: "R23",
		owner: "core/foreground-recovery-controller.ts",
		journey: 2,
		phase: "background-and-stall",
		fault: "a retryable foreground provider error and the retry-window close",
		witness: NONE,
		control: NONE,
		estSeconds: 2,
		status: "open",
		needs: [{ kind: "extension", extension: "X4", detail: "provider connect-error and error-after-frames shapes" }],
	},
	{
		id: "R24",
		owner: "core/foreground-recovery-controller.ts",
		journey: 2,
		phase: "background-and-stall",
		fault: "a parked foreground resumes",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "extension", extension: "X4", detail: "depends on R23's retryable error shapes" }],
	},
	{
		id: "R25",
		owner: "core/foreground-recovery-controller.ts",
		journey: 2,
		phase: "queued-recovery",
		fault: "a usage-limit wait with owner input queued",
		witness: NONE,
		control: NONE,
		estSeconds: 2,
		status: "open",
		needs: [{ kind: "extension", extension: "X4", detail: "a provider quota reply shape" }],
	},
	{
		id: "R26",
		owner: "core/memory/continuous-chat-runtime.ts",
		journey: 2,
		phase: "continuous-chat",
		fault: "ICM recovery waits on a lease event; a settings change does not recycle the host",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [
			{
				kind: "witness",
				detail: "only lease contention is asserted, not the lease-event wake or the settings change",
			},
		],
	},
	{
		id: "R27",
		owner: "core/memory/continuous-chat-store.ts",
		journey: 2,
		phase: "continuous-chat",
		fault: "the ICM runtime lease owner is dead",
		witness: NONE,
		control: NONE,
		estSeconds: 4,
		status: "open",
		needs: [{ kind: "extension", extension: "X2", detail: "a process advance plus reopen of the ICM runtime" }],
	},
	{
		id: "R28",
		owner: "core/delegation/worker-lease-heartbeat.ts",
		journey: 2,
		phase: "continuous-chat",
		fault: "the lease renewal fails while running",
		witness: NONE,
		control: NONE,
		estSeconds: 0.5,
		status: "open",
		needs: [
			{
				kind: "extension",
				extension: "X1",
				detail: "the heartbeat runs on a raw setInterval, not a TimerPort owner",
			},
		],
	},
	{
		id: "R29",
		owner: "core/goals/goal-auto-continue-controller.ts",
		journey: 2,
		phase: "orchestration",
		fault: "the workerDeadline wake of a goal waiting on a bound worker fires",
		witness: NONE,
		control: NONE,
		estSeconds: 0.5,
		status: "open",
		needs: [
			{
				kind: "extension",
				extension: "X1",
				detail: "the auto-continue wake is a raw setTimeout, not a TimerPort owner",
			},
		],
	},
	{
		id: "R30",
		owner: "core/delegation/worker-recovery-coordinator.ts",
		journey: 2,
		phase: "queued-recovery",
		fault: "a read or enqueue fault during worker recovery re-arms its retry timer",
		witness: NONE,
		control: NONE,
		estSeconds: 0.5,
		status: "open",
		needs: [
			{ kind: "witness", detail: "the timer is a TimerPort owner, but no journey forces the recovery read fault" },
		],
	},
	{
		id: "R31",
		owner: "core/delegation/worker-notification-coordinator.ts",
		journey: 2,
		phase: "orchestration",
		fault: "a worker notification write fails and retries",
		witness: NONE,
		control: NONE,
		estSeconds: 0.5,
		status: "open",
		needs: [
			{ kind: "witness", detail: "the timer is a TimerPort owner, but no journey forces the notification fault" },
		],
	},
	{
		id: "R32",
		owner: "core/delegation/worker-agent-control-coordinator.ts",
		journey: 2,
		phase: "orchestration",
		fault: "a durable lane cancel fails",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "witness", detail: "no journey forces the durable cancel failure" }],
	},
	{
		id: "R33",
		owner: "core/delegation/managed-lane-controller.ts",
		journey: 2,
		phase: "orchestration",
		fault: "a legacy managed lane is adopted",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "extension", extension: "X8", detail: "a legacy managed-lane fixture" }],
	},
	{
		id: "R34",
		owner: "core/foreground-terminal-handoff-controller.ts",
		journey: 2,
		phase: "queued-recovery",
		fault: "terminal handoffs pending across a restart",
		witness: NONE,
		control: NONE,
		estSeconds: 4,
		status: "open",
		needs: [{ kind: "extension", extension: "X2", detail: "a restart with pending terminal handoffs" }],
	},
	{
		id: "R35",
		owner: "core/foreground-terminal-handoff-controller.ts",
		journey: 2,
		phase: "orchestration",
		fault: "a handoff that wakes no turn with buffered owner items",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "witness", detail: "no journey asserts the flush of buffered owner items" }],
	},
	{
		id: "R36",
		owner: "core/owner-input-ledger.ts",
		journey: 1,
		phase: "owner-lifecycle",
		fault: "owner words judged at acceptance survive a reopen",
		witness: NONE,
		control: NONE,
		estSeconds: 4,
		status: "open",
		needs: [{ kind: "extension", extension: "X2", detail: "a restart between acceptance and delivery" }],
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
		owner: "core/goals/goal-state.ts",
		journey: 2,
		phase: "orchestration",
		fault: "a goal blocked by an unproven completion reopens",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "witness", detail: "no journey asserts blockedBy" }],
	},
	{
		id: "R39",
		owner: "core/goals/goal-auto-continue-controller.ts",
		journey: 2,
		phase: "orchestration",
		fault: "the goal auto-continue timer fires",
		witness: NONE,
		control: NONE,
		estSeconds: 0.5,
		status: "open",
		needs: [{ kind: "extension", extension: "X1", detail: "the timer is a raw setTimeout, not a TimerPort owner" }],
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
		owner: "core/context/context-store-retention.ts",
		journey: 2,
		phase: "orchestration",
		fault: "artifacts kept across task-record eviction",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "extension", extension: "X9", detail: "eviction-driven retention" }],
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
		journey: 2,
		phase: "queued-recovery",
		fault: "a runtime-update or usage-limit stop with owner input queued",
		witness: NONE,
		control: NONE,
		estSeconds: 2,
		status: "open",
		needs: [{ kind: "extension", extension: "X4", detail: "a provider quota reply shape" }],
	},
	{
		id: "R46",
		owner: "core/pending-input-queue-controller.ts",
		journey: 2,
		phase: "orchestration",
		fault: "a steer during the delegate and background-lane waits",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "witness", detail: "only the tool_task wait is steered (row steer-ended-tool-task-wait)" }],
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
		phase: "queued-recovery",
		fault: "an atomic-file write retries",
		witness: NONE,
		control: NONE,
		estSeconds: 0.5,
		status: "open",
		needs: [
			{
				kind: "extension",
				extension: "X1",
				detail: "the retry delay is a raw setTimeout; rename and write faults reach it only indirectly (R8, R44)",
			},
		],
	},
	{
		id: "R48",
		owner: "core/operator-projection/decision-ledger-store.ts",
		journey: 1,
		phase: "owner-lifecycle SQLite",
		fault: "SQLite busy or locked, or a persistent ledger failure",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "extension", extension: "X3", detail: "a persistent or BUSY SQLite fault" }],
	},
	{
		id: "R49",
		owner: "core/operator-projection/decision-ledger-store.ts",
		journey: 1,
		phase: "owner-lifecycle SQLite",
		fault: "a crash cut with SQLite state rewound to its durable point",
		witness: NONE,
		control: NONE,
		estSeconds: 4,
		status: "open",
		needs: [
			{ kind: "extension", extension: "X2", detail: "a restart cut" },
			{ kind: "extension", extension: "X3", detail: "a SQLite snapshot and rewind" },
		],
	},
	{
		id: "R50",
		owner: "core/memory/providers/transcript-recall.ts",
		journey: 3,
		phase: "continuous-chat",
		fault: "a worker thread crashes or hangs (transcript recall, tool recovery log)",
		witness: NONE,
		control: NONE,
		estSeconds: 1,
		status: "open",
		needs: [{ kind: "extension", extension: "X7", detail: "use of the dormant worker-thread fault hooks" }],
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
