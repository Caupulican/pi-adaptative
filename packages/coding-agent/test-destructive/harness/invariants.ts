/**
 * Executable assertion helpers for the invariant catalogue (blueprint §3). Every destructive
 * harness ends a run by calling `assertInvariants(world, [ids])` so failures cite a stable,
 * greppable catalogue id plus the mandatory one-line repro (design rule §0.1/§0.3).
 *
 * Phase 1 implements INV-W4 (exactly-once terminal handoff) and INV-L1 (loop always terminates),
 * the two invariants the Phase-1 pilots guard. Every other catalogue id is stubbed: calling
 * `assertInvariants` with a stub id throws `InvariantNotImplementedError` rather than silently
 * passing, so a future harness that forgets to wire a real checker fails loudly instead of green.
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
		super(
			`${id} has no executable checker yet (blueprint §3/§6 — later phase). ` +
				`Do not add it to an assertInvariants() call until it is implemented for real.`,
		);
		this.name = "InvariantNotImplementedError";
	}
}

/** Per-lane/per-attempt terminal handoff delivery ledger observed across one crash-sweep run. */
export interface TerminalHandoffWorld {
	/** attemptId -> number of times its terminal handoff was durably observed as delivered/replayed. */
	deliveredCounts: ReadonlyMap<string, number>;
	/** attemptIds that durably reached a terminal state but were never observed as delivered. */
	neverDelivered: readonly string[];
}

/** One chaos-loop run's outcome, as observed by the H2 driver. */
export interface LoopRunWorld {
	/** Whether the loop returned/threw before the harness gave up waiting (fake-timer deadline). */
	settledWithinDeadline: boolean;
	/** The loop's final stop reason, if it settled. */
	stopReason: string | undefined;
	/** True if any lease/reservation acquired during the run was still held after the run settled. */
	leaseLeaked: boolean;
}

export interface InvariantWorld {
	terminalHandoff?: TerminalHandoffWorld;
	loopRun?: LoopRunWorld;
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

/**
 * INV-W4 — Exactly-once terminal handoff: no duplicate delivery, no loss; after restart, every
 * undelivered terminal (including formerly transient ones) replays exactly once.
 *
 * Falsified against: a duplicate-persist reintroduced on the worker-terminal-notification path in
 * `WorkerLifecycle`/`DelegationOrchestrationLedger` (see test-destructive/crash's falsifiability
 * capture in the Phase 1 report) — with the dedup guard removed, this checker goes red on a
 * `deliveredCounts` entry > 1.
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

/**
 * INV-L1 — The agent loop always terminates with a defined stop reason under any ChaosProvider
 * schedule; no hang past deadline, no lease leaked on any exit path.
 *
 * Falsified against: `waitForWorkerAgents` hanging past its own deadline under a stalled provider
 * (the historical bug named in blueprint §1/H2) — reintroducing an unconditional wait with no
 * watchdog makes `settledWithinDeadline` false and this checker goes red.
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
	"INV-G1": stub("INV-G1"),
	"INV-G2": stub("INV-G2"),
	"INV-G3": stub("INV-G3"),
	"INV-W1": stub("INV-W1"),
	"INV-W2": stub("INV-W2"),
	"INV-W3": stub("INV-W3"),
	"INV-W4": assertInvW4,
	"INV-W5": stub("INV-W5"),
	"INV-W6": stub("INV-W6"),
	"INV-B1": stub("INV-B1"),
	"INV-C1": stub("INV-C1"),
	"INV-C2": stub("INV-C2"),
	"INV-R1": stub("INV-R1"),
	"INV-L1": assertInvL1,
};

function stub(id: InvariantId): InvariantChecker {
	return () => {
		throw new InvariantNotImplementedError(id);
	};
}

/**
 * Assert every requested invariant id against `world`, in order. Throws on the first violation
 * (including the first "not implemented yet" stub), always carrying the one-line repro.
 */
export function assertInvariants(world: InvariantWorld, ids: readonly InvariantId[], repro: ReproFields): void {
	for (const id of ids) {
		CHECKERS[id](world, repro);
	}
}
