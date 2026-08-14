/**
 * Executable assertion helpers for the invariant catalogue (blueprint §3). Every destructive
 * harness ends a run by calling `assertInvariants(world, [ids])` so failures cite a stable,
 * greppable catalogue id plus the mandatory one-line repro (design rule §0.1/§0.3).
 */

import { type ReproFields, reproError } from "./repro.ts";

export const INVARIANT_IDS = [
	"INV-G1",
	"INV-G2",
	"INV-G3",
	"INV-W1",
	"INV-W2",
	"INV-W3",
	"INV-W4",
	"INV-W5",
	"INV-W6",
	"INV-B1",
	"INV-C1",
	"INV-C2",
	"INV-R1",
	"INV-L1",
] as const;

export type InvariantId = (typeof INVARIANT_IDS)[number];

export class InvariantNotImplementedError extends Error {
	constructor(id: InvariantId) {
		super(`${id} has no executable checker.`);
		this.name = "InvariantNotImplementedError";
	}
}

export interface TerminalHandoffWorld {
	deliveredCounts: ReadonlyMap<string, number>;
	neverDelivered: readonly string[];
}

export interface LoopRunWorld {
	settledWithinDeadline: boolean;
	stopReason: string | undefined;
	leaseLeaked: boolean;
}

export interface GoalAccountingWorld {
	tokensUsed: number;
	chargedTokens: readonly number[];
	unresolvableFlush: boolean;
	loudWarningEmitted: boolean;
	continuationFailed: boolean;
}

export interface GoalTerminationWorld {
	budgeted: boolean;
	status: string;
	stopReason: string | undefined;
}

export interface GoalRestartWorld {
	terminal: boolean;
	freshTurnAdmitted: boolean;
	wrapUpDraining: boolean;
}

export interface LeaseWorld {
	acquired: number;
	released: number;
	heldByLiveOwner: number;
}

export interface TerminalPartitionWorld {
	completed: number;
	failed: number;
	attention: number;
	terminalCount: number;
}

export interface ConcurrencyWorld {
	observations: readonly number[];
	maxConcurrent: number;
}

export interface FencedRenewalWorld {
	supersededRenewalRejected: boolean;
	liveExpiryStillAbandons: boolean;
}

export interface BoundedWaitWorld {
	settledWithinBound: boolean;
	silentOverrun: boolean;
}

export interface TreeBudgetWorld {
	spendUsd: number;
	ceilingUsd: number;
	finalTurnOverrunUsd: number;
	profileFree: boolean;
	ceilingIsZero: boolean;
}

export interface CompactionRoundTripWorld {
	userRulesBefore: readonly string[];
	userRulesAfter: readonly string[];
	activeTaskBefore: string;
	activeTaskAfter: string;
	sentinelPersisted: boolean;
}

export interface CrashConsistencyWorld {
	/** true = reconstructed a consistent pre- or post-checkpoint state */
	consistent: boolean;
	/** true = reconstruction failed loudly naming the damage */
	failedLoud: boolean;
	/** true = silent skip / partial application / in-memory vs disk divergence */
	silentDivergence: boolean;
}

export interface InvariantWorld {
	terminalHandoff?: TerminalHandoffWorld;
	loopRun?: LoopRunWorld;
	goalAccounting?: GoalAccountingWorld;
	goalTermination?: GoalTerminationWorld;
	goalRestart?: GoalRestartWorld;
	leases?: LeaseWorld;
	terminalPartition?: TerminalPartitionWorld;
	concurrency?: ConcurrencyWorld;
	fencedRenewal?: FencedRenewalWorld;
	boundedWait?: BoundedWaitWorld;
	treeBudget?: TreeBudgetWorld;
	compactionRoundTrip?: CompactionRoundTripWorld;
	crashConsistency?: CrashConsistencyWorld;
}

function requireWorld<K extends keyof InvariantWorld>(
	world: InvariantWorld,
	key: K,
	id: InvariantId,
	repro: ReproFields,
): NonNullable<InvariantWorld[K]> {
	const value = world[key];
	if (value === undefined) {
		throw reproError(`${id} checker requires world.${key}, which this run did not supply.`, repro);
	}
	return value;
}

export function assertInvG1(world: InvariantWorld, repro: ReproFields): void {
	const goal = requireWorld(world, "goalAccounting", "INV-G1", repro);
	const charged = goal.chargedTokens.reduce((sum, value) => sum + value, 0);
	if (goal.unresolvableFlush) {
		if (!goal.loudWarningEmitted || !goal.continuationFailed) {
			throw reproError(
				"INV-G1 violated: unresolvable flush discarded spend silently (need warning + continuation failure).",
				repro,
			);
		}
		return;
	}
	if (goal.tokensUsed !== charged) {
		throw reproError(`INV-G1 violated: tokensUsed ${goal.tokensUsed} !== sum(charged) ${charged}.`, repro);
	}
}

export function assertInvG2(world: InvariantWorld, repro: ReproFields): void {
	const goal = requireWorld(world, "goalTermination", "INV-G2", repro);
	if (!goal.budgeted) return;
	const clean =
		goal.status === "completed" ||
		goal.status === "cancelled" ||
		goal.status === "budget_limited" ||
		goal.stopReason === "goal_budget_exhausted";
	if (goal.stopReason === "error") {
		throw reproError("INV-G2 violated: budgeted goal stopped with stopReason error.", repro);
	}
	if (goal.stopReason === "length") {
		throw reproError("INV-G2 violated: budgeted goal ended as a length truncation.", repro);
	}
	if (!clean) {
		throw reproError(
			`INV-G2 violated: budgeted goal ended as status=${goal.status} stopReason=${goal.stopReason ?? "undefined"}.`,
			repro,
		);
	}
}

export function assertInvG3(world: InvariantWorld, repro: ReproFields): void {
	const goal = requireWorld(world, "goalRestart", "INV-G3", repro);
	if (!goal.terminal) return;
	if (goal.freshTurnAdmitted) {
		throw reproError("INV-G3 violated: a terminal goal admitted a fresh turn.", repro);
	}
	if (!goal.wrapUpDraining && goal.freshTurnAdmitted) {
		throw reproError("INV-G3 violated: wrap-up did not drain after a terminal stop.", repro);
	}
}

export function assertInvW1(world: InvariantWorld, repro: ReproFields): void {
	const leases = requireWorld(world, "leases", "INV-W1", repro);
	if (leases.acquired !== leases.released + leases.heldByLiveOwner) {
		throw reproError(
			`INV-W1 violated: acquired ${leases.acquired} !== released ${leases.released} + live ${leases.heldByLiveOwner}.`,
			repro,
		);
	}
}

export function assertInvW2(world: InvariantWorld, repro: ReproFields): void {
	const partition = requireWorld(world, "terminalPartition", "INV-W2", repro);
	const sum = partition.completed + partition.failed + partition.attention;
	if (sum !== partition.terminalCount) {
		throw reproError(
			`INV-W2 violated: completed+failed+attention ${sum} !== terminalCount ${partition.terminalCount}.`,
			repro,
		);
	}
}

export function assertInvW3(world: InvariantWorld, repro: ReproFields): void {
	const concurrency = requireWorld(world, "concurrency", "INV-W3", repro);
	for (const running of concurrency.observations) {
		if (running > concurrency.maxConcurrent) {
			throw reproError(
				`INV-W3 violated: observed ${running} running workers > maxConcurrent ${concurrency.maxConcurrent}.`,
				repro,
			);
		}
	}
}

/**
 * INV-W4 — Exactly-once terminal handoff.
 * Falsified against: a duplicate-persist reintroduced on the worker-terminal-notification path.
 */
export function assertInvW4(world: InvariantWorld, repro: ReproFields): void {
	const handoff = requireWorld(world, "terminalHandoff", "INV-W4", repro);
	if (handoff.neverDelivered.length > 0) {
		throw reproError(
			`INV-W4 violated: ${handoff.neverDelivered.length} terminal attempt(s) were never delivered: ${handoff.neverDelivered.join(", ")}.`,
			repro,
		);
	}
	for (const [attemptId, count] of handoff.deliveredCounts) {
		if (count !== 1) {
			throw reproError(
				`INV-W4 violated: terminal attempt ${attemptId} was delivered ${count} time(s); expected exactly 1.`,
				repro,
			);
		}
	}
}

export function assertInvW5(world: InvariantWorld, repro: ReproFields): void {
	const renewal = requireWorld(world, "fencedRenewal", "INV-W5", repro);
	if (!renewal.supersededRenewalRejected) {
		throw reproError("INV-W5 violated: a superseded attempt's renewal was accepted.", repro);
	}
	if (!renewal.liveExpiryStillAbandons) {
		throw reproError("INV-W5 violated: live lease expiry is no longer an abandonment signal.", repro);
	}
}

export function assertInvW6(world: InvariantWorld, repro: ReproFields): void {
	const wait = requireWorld(world, "boundedWait", "INV-W6", repro);
	if (wait.silentOverrun) {
		throw reproError("INV-W6 violated: a wait overran its bound silently.", repro);
	}
	if (!wait.settledWithinBound) {
		throw reproError("INV-W6 violated: a wait/watchdog did not settle within its documented bound.", repro);
	}
}

export function assertInvB1(world: InvariantWorld, repro: ReproFields): void {
	const tree = requireWorld(world, "treeBudget", "INV-B1", repro);
	if (tree.profileFree && tree.ceilingIsZero) {
		throw reproError("INV-B1 violated: a profile-free tree has a zero/absent ceiling.", repro);
	}
	if (tree.spendUsd > tree.ceilingUsd + tree.finalTurnOverrunUsd) {
		throw reproError(
			`INV-B1 violated: tree spend ${tree.spendUsd} > ceiling ${tree.ceilingUsd} + overrun ${tree.finalTurnOverrunUsd}.`,
			repro,
		);
	}
}

export function assertInvC1(world: InvariantWorld, repro: ReproFields): void {
	const compaction = requireWorld(world, "compactionRoundTrip", "INV-C1", repro);
	if (compaction.sentinelPersisted) {
		throw reproError("INV-C1 violated: the worked-example sentinel persisted.", repro);
	}
	if (compaction.activeTaskAfter !== compaction.activeTaskBefore) {
		throw reproError(
			`INV-C1 violated: Active Task drifted (${JSON.stringify(compaction.activeTaskBefore)} -> ${JSON.stringify(compaction.activeTaskAfter)}).`,
			repro,
		);
	}
	if (compaction.userRulesAfter.length !== compaction.userRulesBefore.length) {
		throw reproError("INV-C1 violated: user-rule count changed across fill→render→verify.", repro);
	}
	for (const rule of compaction.userRulesBefore) {
		if (!compaction.userRulesAfter.includes(rule)) {
			throw reproError(`INV-C1 violated: user rule missing after round-trip: ${rule}.`, repro);
		}
	}
}

export function assertInvC2(world: InvariantWorld, repro: ReproFields): void {
	const crash = requireWorld(world, "crashConsistency", "INV-C2", repro);
	if (crash.silentDivergence) {
		throw reproError("INV-C2 violated: crash mid-checkpoint produced silent/partial application.", repro);
	}
	if (!crash.consistent && !crash.failedLoud) {
		throw reproError("INV-C2 violated: reconstruction was neither consistent nor loud.", repro);
	}
}

export function assertInvR1(world: InvariantWorld, repro: ReproFields): void {
	const crash = requireWorld(world, "crashConsistency", "INV-R1", repro);
	if (crash.silentDivergence) {
		throw reproError("INV-R1 violated: journal reconstruction silently diverged.", repro);
	}
	if (!crash.consistent && !crash.failedLoud) {
		throw reproError("INV-R1 violated: restart neither reconstructed a consistent state nor failed loudly.", repro);
	}
}

/**
 * INV-L1 — loop always terminates.
 * Falsified against: waitForWorkerAgents hanging past its deadline under a stalled provider.
 */
export function assertInvL1(world: InvariantWorld, repro: ReproFields): void {
	const loopRun = requireWorld(world, "loopRun", "INV-L1", repro);
	if (!loopRun.settledWithinDeadline) {
		throw reproError("INV-L1 violated: the loop did not settle within its virtual-time deadline.", repro);
	}
	if (!loopRun.stopReason) {
		throw reproError("INV-L1 violated: the loop settled without a defined stop reason.", repro);
	}
	if (loopRun.leaseLeaked) {
		throw reproError(
			`INV-L1 violated: a lease/reservation was still held after stop reason "${loopRun.stopReason}".`,
			repro,
		);
	}
}

type InvariantChecker = (world: InvariantWorld, repro: ReproFields) => void;

const CHECKERS: Record<InvariantId, InvariantChecker> = {
	"INV-G1": assertInvG1,
	"INV-G2": assertInvG2,
	"INV-G3": assertInvG3,
	"INV-W1": assertInvW1,
	"INV-W2": assertInvW2,
	"INV-W3": assertInvW3,
	"INV-W4": assertInvW4,
	"INV-W5": assertInvW5,
	"INV-W6": assertInvW6,
	"INV-B1": assertInvB1,
	"INV-C1": assertInvC1,
	"INV-C2": assertInvC2,
	"INV-R1": assertInvR1,
	"INV-L1": assertInvL1,
};

export function assertInvariants(world: InvariantWorld, ids: readonly InvariantId[], repro: ReproFields): void {
	for (const id of ids) {
		CHECKERS[id](world, repro);
	}
}
