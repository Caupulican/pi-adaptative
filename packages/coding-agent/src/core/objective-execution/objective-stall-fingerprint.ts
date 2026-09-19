/**
 * Objective Stall Fingerprinting and Progress Tracking.
 * Host-derived progress and stall detection independent of worker rhetoric.
 */

import { createHash } from "node:crypto";

export interface StallEvaluation {
	readonly stalled: boolean;
	readonly stallTurns: number;
	readonly repeatedWithoutNewEvidence: boolean;
	readonly fingerprint: string;
	readonly reason?: string;
}

export interface StallTrackerState {
	lastProgressRevision: number;
	stallTurns: number;
	strategyHistory: readonly string[];
}

export class ObjectiveStallDetector {
	private readonly maxStallTurns: number;
	private lastProgressRevision = 0;
	private stallTurns = 0;
	private strategyHistory: string[] = [];

	constructor(options?: { maxStallTurns?: number }) {
		this.maxStallTurns = options?.maxStallTurns ?? 3;
	}

	/**
	 * Computes a deterministic SHA-256 fingerprint for a strategy/action proposal.
	 */
	static computeStrategyFingerprint(action: {
		route: string;
		targetRequirementIds?: readonly string[];
		targetHypothesisIds?: readonly string[];
		plannedActions?: readonly string[];
	}): string {
		const norm = {
			route: action.route,
			reqs: [...(action.targetRequirementIds ?? [])].sort(),
			hyps: [...(action.targetHypothesisIds ?? [])].sort(),
			acts: [...(action.plannedActions ?? [])].sort(),
		};
		return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 16);
	}

	/**
	 * Evaluates stall state based on canonical progress revision and strategy history.
	 * Waiting (e.g. worker in flight or tool executing) is explicitly NOT a stall.
	 */
	evaluate(input: {
		currentRevision: number;
		isWaiting?: boolean;
		currentStrategyFingerprint?: string;
	}): StallEvaluation {
		const fingerprint = input.currentStrategyFingerprint ?? "empty_strategy";

		// Waiting is explicitly not a stall (Rule 23).
		if (input.isWaiting) {
			return {
				stalled: false,
				stallTurns: this.stallTurns,
				repeatedWithoutNewEvidence: false,
				fingerprint,
				reason: "waiting_in_flight",
			};
		}

		// Check if canonical progress revision advanced (Rule 20: material state change required).
		if (input.currentRevision > this.lastProgressRevision) {
			this.lastProgressRevision = input.currentRevision;
			this.stallTurns = 0;
			this.strategyHistory = [fingerprint];
			return {
				stalled: false,
				stallTurns: 0,
				repeatedWithoutNewEvidence: false,
				fingerprint,
			};
		}

		// Revision did not advance
		this.stallTurns++;

		// Detect repeated strategy without new evidence (Rule 22).
		const previousOccurrences = this.strategyHistory.filter((f) => f === fingerprint).length;
		this.strategyHistory.push(fingerprint);
		if (this.strategyHistory.length > 20) {
			this.strategyHistory.shift();
		}

		const repeatedWithoutNewEvidence = previousOccurrences >= 2;
		const stalled = this.stallTurns >= this.maxStallTurns || repeatedWithoutNewEvidence;

		return {
			stalled,
			stallTurns: this.stallTurns,
			repeatedWithoutNewEvidence,
			fingerprint,
			reason: repeatedWithoutNewEvidence
				? "repeated_strategy_without_new_evidence"
				: stalled
					? `max_stall_turns_exceeded (${this.stallTurns}/${this.maxStallTurns})`
					: undefined,
		};
	}

	/**
	 * Explicitly resets stall tracking (e.g. on new objective or fresh worker handoff).
	 */
	reset(initialRevision = 0): void {
		this.lastProgressRevision = initialRevision;
		this.stallTurns = 0;
		this.strategyHistory = [];
	}

	getState(): Readonly<StallTrackerState> {
		return {
			lastProgressRevision: this.lastProgressRevision,
			stallTurns: this.stallTurns,
			strategyHistory: [...this.strategyHistory],
		};
	}
}
