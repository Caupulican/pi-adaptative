/**
 * Observed health of the session's semantic plane, and the ledger of what it evaluated.
 *
 * Health is what actually happened to the last evaluation, not a constant. A session with no plane
 * reports `unbound`; a bound plane that has never been asked reports `unknown`; a plane with an
 * evaluation in flight reports `evaluating`; a plane whose last evaluation threw reports `degraded`.
 * Nothing here renders a state the runtime did not earn.
 *
 * The recorder is the ONE observer every evaluation path reports to (the session's recording
 * wrapper, the steering plane, System One's stage controller). It keeps the in-flight evaluations
 * with their labels and clocks, a bounded ring of recent records, and forwards every start and
 * settlement to the durable decision ledger when one is bound.
 */

import { randomUUID } from "node:crypto";
import type { Consequence } from "../decision/primitives.ts";
import {
	type SemanticEvaluationObserver,
	type SemanticEvaluationRecord,
	type SemanticEvaluationStart,
	semanticEvaluationLabel,
} from "./semantic-evaluation-ledger.ts";

export type SemanticPlaneHealthState = "unbound" | "unknown" | "evaluating" | "ok" | "degraded";

export interface SemanticPlaneHealth {
	readonly state: SemanticPlaneHealthState;
	readonly lastOutcomeAt?: string;
	readonly lastFailure?: string;
	/** Evaluations currently in flight; only meaningful while `state` is `evaluating`. */
	readonly inFlight?: number;
	/** What those evaluations are and since when; present only while `state` is `evaluating`. */
	readonly inFlightEvaluations?: readonly SemanticEvaluationStart[];
}

/** The durable side of the ledger, as the SQLite store exposes it; bound by the session. */
export interface SemanticEvaluationDurableSink {
	start(record: SemanticEvaluationStart & { readonly model?: string }): void;
	settle(record: SemanticEvaluationRecord): void;
	noteVerdict(evaluationId: string, verdict: string, reasons?: readonly string[]): void;
}

const MAX_RECENT_EVALUATIONS = 32;

/** Records every semantic evaluation the session runs, on every path. */
export class SemanticPlaneHealthRecorder implements SemanticEvaluationObserver {
	private lastOutcomeAt?: string;
	private lastFailure?: string;
	private observed = false;
	private readonly open = new Map<string, SemanticEvaluationStart>();
	private readonly recent: SemanticEvaluationRecord[] = [];
	private readonly listeners = new Set<(record: SemanticEvaluationRecord) => void>();
	private durable?: () => SemanticEvaluationDurableSink | undefined;
	private durableFailure?: string;
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Binds the durable ledger; resolved per call so a lazily opened store is picked up. */
	bindDurable(resolve: () => SemanticEvaluationDurableSink | undefined): void {
		this.durable = resolve;
	}

	getDurableFailure(): string | undefined {
		return this.durableFailure;
	}

	start(input: { programId: string; consequence?: Consequence; model?: string }): string {
		const record: SemanticEvaluationStart = {
			evaluationId: randomUUID(),
			programId: input.programId,
			label: semanticEvaluationLabel(input.programId),
			...(input.consequence ? { consequence: input.consequence } : {}),
			startedAt: this.now(),
		};
		this.open.set(record.evaluationId, record);
		this.toDurable((sink) => sink.start({ ...record, ...(input.model ? { model: input.model } : {}) }));
		return record.evaluationId;
	}

	settleOk(evaluationId: string, verdict?: string, reasons?: readonly string[]): void {
		const start = this.take(evaluationId);
		if (!start) return;
		this.observed = true;
		this.lastOutcomeAt = new Date(this.now()).toISOString();
		this.lastFailure = undefined;
		this.push(start, "ok", verdict, reasons);
	}

	settleFailed(evaluationId: string, error: unknown): void {
		const start = this.take(evaluationId);
		if (!start) return;
		this.observed = true;
		this.lastOutcomeAt = new Date(this.now()).toISOString();
		this.lastFailure = error instanceof Error ? error.message : String(error);
		this.push(start, "failed", undefined, [this.lastFailure]);
	}

	/**
	 * The evaluation was cancelled — the operator aborted the turn, or its caller went away. The
	 * plane did not fail: nothing was observed, so the last real outcome stands and the state
	 * returns to whatever it was before the evaluation started. The record is still kept, so the
	 * pane can show that Jev was interrupted.
	 */
	settleCancelled(evaluationId: string): void {
		const start = this.take(evaluationId);
		if (!start) return;
		this.push(start, "cancelled");
	}

	noteVerdict(evaluationId: string, verdict: string, reasons?: readonly string[]): void {
		const index = this.recent.findIndex((record) => record.evaluationId === evaluationId);
		if (index < 0) return;
		const updated: SemanticEvaluationRecord = {
			...this.recent[index]!,
			verdict,
			...(reasons ? { reasons } : {}),
		};
		this.recent[index] = updated;
		this.toDurable((sink) => sink.noteVerdict(evaluationId, verdict, reasons));
		this.notify(updated);
	}

	/** Completed evaluations, oldest first, bounded. */
	getRecentEvaluations(): readonly SemanticEvaluationRecord[] {
		return this.recent;
	}

	getLastEvaluation(): SemanticEvaluationRecord | undefined {
		return this.recent.at(-1);
	}

	/** Fires on every settlement and verdict note; the Execution pane's Jev previews hang off it. */
	subscribe(listener: (record: SemanticEvaluationRecord) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** `bound` is whether a semantic plane exists at all for this session. */
	getHealth(bound: boolean): SemanticPlaneHealth {
		if (!bound) return { state: "unbound" };
		if (this.open.size > 0) {
			return {
				state: "evaluating",
				inFlight: this.open.size,
				inFlightEvaluations: [...this.open.values()],
				...(this.lastOutcomeAt ? { lastOutcomeAt: this.lastOutcomeAt } : {}),
				...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
			};
		}
		if (!this.observed) return { state: "unknown" };
		return {
			state: this.lastFailure ? "degraded" : "ok",
			...(this.lastOutcomeAt ? { lastOutcomeAt: this.lastOutcomeAt } : {}),
			...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
		};
	}

	/** A settle for an unknown id is a no-op: the recorder can never be left `evaluating`. */
	private take(evaluationId: string): SemanticEvaluationStart | undefined {
		const start = this.open.get(evaluationId);
		if (start) this.open.delete(evaluationId);
		return start;
	}

	private push(
		start: SemanticEvaluationStart,
		outcome: SemanticEvaluationRecord["outcome"],
		verdict?: string,
		reasons?: readonly string[],
	): void {
		const endedAt = this.now();
		const record: SemanticEvaluationRecord = {
			...start,
			endedAt,
			durationMs: Math.max(0, endedAt - start.startedAt),
			outcome,
			...(verdict !== undefined ? { verdict } : {}),
			...(reasons?.length ? { reasons } : {}),
		};
		this.recent.push(record);
		while (this.recent.length > MAX_RECENT_EVALUATIONS) this.recent.shift();
		this.toDurable((sink) => sink.settle(record));
		this.notify(record);
	}

	private notify(record: SemanticEvaluationRecord): void {
		for (const listener of this.listeners) {
			try {
				listener(record);
			} catch {
				// A failing listener must not break the plane.
			}
		}
	}

	private toDurable(write: (sink: SemanticEvaluationDurableSink) => void): void {
		const sink = this.durable?.();
		if (!sink) return;
		try {
			write(sink);
		} catch (error) {
			this.durableFailure = error instanceof Error ? error.message : String(error);
		}
	}
}

/**
 * The operator label for a health state, as the normal-mode POV bar shows it. Every state has a
 * word an operator can act on; there is deliberately no "?" state.
 */
export function semanticPlaneHealthLabel(health: SemanticPlaneHealth): string {
	switch (health.state) {
		case "ok":
			return "JEV ok";
		case "degraded":
			return "JEV degraded";
		case "evaluating":
			return "JEV eval";
		case "unknown":
			return "JEV ready";
		default:
			return "JEV off";
	}
}
