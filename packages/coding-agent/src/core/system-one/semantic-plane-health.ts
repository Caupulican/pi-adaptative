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
import { IndependentObserverSet } from "../observer-dispatch.ts";
import { systemOneFailureReasons } from "../review/system-one-failure-diagnostics.ts";
import {
	type ResolveSemanticDoubtInput,
	type ResolveSemanticDoubtResult,
	type SemanticDoubt,
	type SemanticDoubtDecision,
	SemanticDoubtTracker,
	type SemanticUncertaintyPort,
} from "./semantic-doubts.ts";
import {
	type SemanticEvaluationObserver,
	type SemanticEvaluationRecord,
	type SemanticEvaluationScope,
	type SemanticEvaluationStart,
	type SemanticQuestionState,
	semanticEvaluationLabel,
	semanticQuestionNamespace,
} from "./semantic-evaluation-ledger.ts";

export type SemanticPlaneHealthState = "unbound" | "unknown" | "evaluating" | "ok" | "degraded";

export interface SemanticPlaneHealth {
	readonly state: SemanticPlaneHealthState;
	/** Current unresolved questions, never inferred from historical evaluation counts. */
	readonly unresolvedDoubts?: readonly SemanticDoubt[];
	readonly lastOutcomeAt?: string;
	readonly lastFailure?: string;
	/** Which evaluation failed last (its operator label) and how (the adapter's failure kind, when known). */
	readonly lastFailedLabel?: string;
	readonly lastFailureKind?: string;
	/** Evaluations currently in flight; only meaningful while `state` is `evaluating`. */
	readonly inFlight?: number;
	/** What those evaluations are and since when; present only while `state` is `evaluating`. */
	readonly inFlightEvaluations?: readonly SemanticEvaluationStart[];
}

/** The durable side of the ledger, as the SQLite store exposes it; bound by the session. */
export interface SemanticEvaluationDurableSink {
	readonly sessionId?: string;
	readEvaluations?(): readonly SemanticEvaluationRecord[];
	readDoubtDecisions?(): readonly SemanticDoubtDecision[];
	recordDoubtDecision?(decision: SemanticDoubtDecision): void;
	start(record: SemanticEvaluationStart & { readonly model?: string }): void;
	settle(record: SemanticEvaluationRecord): void;
	noteVerdict(
		evaluationId: string,
		verdict: string,
		reasons?: readonly string[],
		questionStates?: readonly SemanticQuestionState[],
	): void;
}

const MAX_RECENT_EVALUATIONS = 32;

/** Records every semantic evaluation the session runs, on every path. */
export class SemanticPlaneHealthRecorder implements SemanticEvaluationObserver, SemanticUncertaintyPort {
	private lastOutcomeAt?: string;
	private lastFailure?: string;
	private lastFailedLabel?: string;
	private lastFailureKind?: string;
	private observed = false;
	private readonly open = new Map<string, SemanticEvaluationStart>();
	private readonly recent: SemanticEvaluationRecord[] = [];
	private doubts = new SemanticDoubtTracker();
	private sessionId?: string;
	private getSessionId?: () => string;
	private hydratedSessionId?: string;
	private readonly evaluationSessions = new Map<string, string | undefined>();
	private readonly evaluationSinks = new Map<string, SemanticEvaluationDurableSink | undefined>();
	private readonly listeners = new IndependentObserverSet<(record: SemanticEvaluationRecord) => void>();
	private durable?: () => SemanticEvaluationDurableSink | undefined;
	private durableFailure?: string;
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Binds the durable ledger; resolved per call so a lazily opened store is picked up. */
	bindDurable(resolve: () => SemanticEvaluationDurableSink | undefined, getSessionId?: () => string): void {
		this.durable = resolve;
		this.getSessionId = getSessionId;
	}

	getDurableFailure(): string | undefined {
		return this.durableFailure;
	}

	start(input: {
		programId: string;
		consequence?: Consequence;
		model?: string;
		evaluationScope?: SemanticEvaluationScope;
	}): string {
		this.refreshSession();
		const record: SemanticEvaluationStart = {
			evaluationId: randomUUID(),
			programId: input.programId,
			label: semanticEvaluationLabel(input.programId),
			questionNamespace: semanticQuestionNamespace(input.programId),
			evaluationScope: input.evaluationScope ?? { kind: "session", id: this.sessionId ?? "process-local" },
			...(input.consequence ? { consequence: input.consequence } : {}),
			startedAt: this.now(),
		};
		this.open.set(record.evaluationId, record);
		this.evaluationSessions.set(record.evaluationId, this.sessionId);
		const sink = this.durable?.();
		this.evaluationSinks.set(record.evaluationId, sink);
		this.doubts.start(record.evaluationId, record.programId, record.evaluationScope, record.questionNamespace);
		this.toDurable((sink) => sink.start({ ...record, ...(input.model ? { model: input.model } : {}) }), sink);
		return record.evaluationId;
	}

	settleOk(
		evaluationId: string,
		verdict?: string,
		reasons?: readonly string[],
		questionStates?: readonly SemanticQuestionState[],
	): void {
		const start = this.take(evaluationId);
		if (!start) return;
		if (this.evaluationSessions.get(evaluationId) === this.sessionId) {
			this.observed = true;
			this.lastOutcomeAt = new Date(this.now()).toISOString();
			this.lastFailure = undefined;
			this.lastFailedLabel = undefined;
			this.lastFailureKind = undefined;
		}
		this.push(start, "ok", verdict, reasons, questionStates);
	}

	settleFailed(evaluationId: string, error: unknown): void {
		const start = this.take(evaluationId);
		if (!start) return;
		const reasons = systemOneFailureReasons(error);
		const failure = reasons[0];
		if (this.evaluationSessions.get(evaluationId) === this.sessionId) {
			this.observed = true;
			this.lastOutcomeAt = new Date(this.now()).toISOString();
			this.lastFailure = failure;
			this.lastFailedLabel = start.label;
			const kind = (error as { kind?: unknown } | undefined)?.kind;
			this.lastFailureKind = typeof kind === "string" ? kind : undefined;
		}
		this.push(start, "failed", undefined, reasons);
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

	noteVerdict(
		evaluationId: string,
		verdict: string,
		reasons?: readonly string[],
		questionStates?: readonly SemanticQuestionState[],
	): void {
		this.refreshSession();
		const index = this.recent.findIndex((record) => record.evaluationId === evaluationId);
		const original = index >= 0 ? this.recent[index] : this.doubts.getRecord(evaluationId);
		if (!original) return;
		const updated: SemanticEvaluationRecord = {
			...original,
			verdict,
			...(reasons ? { reasons } : {}),
			...(questionStates !== undefined ? { questionStates } : {}),
		};
		if (index >= 0) this.recent[index] = updated;
		this.doubts.observe(updated);
		this.toDurable(
			(sink) => sink.noteVerdict(evaluationId, verdict, reasons, updated.questionStates),
			this.durable?.(),
		);
		this.notify(updated);
	}

	/** Completed evaluations, oldest first, bounded. */
	getRecentEvaluations(): readonly SemanticEvaluationRecord[] {
		this.refreshSession();
		return this.recent;
	}

	getLastEvaluation(): SemanticEvaluationRecord | undefined {
		this.refreshSession();
		return this.recent.at(-1);
	}

	/** Fires on every settlement and verdict note; the Execution pane's Jev previews hang off it. */
	subscribe(listener: (record: SemanticEvaluationRecord) => void): () => void {
		return this.listeners.subscribe(listener);
	}

	/** `bound` is whether a semantic plane exists at all for this session. */
	getHealth(bound: boolean): SemanticPlaneHealth {
		this.refreshSession();
		return { ...this.healthSnapshot(bound), unresolvedDoubts: this.doubts.snapshot() };
	}

	listOwnSession(): readonly SemanticDoubt[] {
		this.refreshSession();
		return this.doubts.snapshot();
	}

	resolveOwnSession(input: ResolveSemanticDoubtInput): ResolveSemanticDoubtResult {
		this.refreshSession();
		if (
			(input.disposition !== "conservative_path" && input.disposition !== "evidence_based_decision") ||
			typeof input.reason !== "string" ||
			!input.reason.trim() ||
			input.reason.length > 1000 ||
			typeof input.evidence !== "string" ||
			!input.evidence.trim() ||
			input.evidence.length > 4000
		)
			return { resolved: false, reason: "invalid_record" };
		const doubt = this.doubts
			.snapshot()
			.find((item) => item.evaluationId === input.evaluationId && item.question === input.question);
		if (!doubt) return { resolved: false, reason: "stale_question" };
		if (
			doubt.evaluationScope?.kind === "session" &&
			doubt.evaluationScope.id !== (this.sessionId ?? "process-local")
		) {
			return { resolved: false, reason: "not_owned" };
		}
		const sink = this.durable?.();
		if (!sink?.recordDoubtDecision) return { resolved: false, reason: "storage_unavailable" };
		const record = this.doubts.getRecord(input.evaluationId);
		try {
			sink.recordDoubtDecision({ ...input, decidedAt: this.now() });
		} catch (error) {
			this.durableFailure = error instanceof Error ? error.message : String(error);
			return { resolved: false, reason: "storage_unavailable" };
		}
		if (!this.doubts.resolveCurrent(input)) return { resolved: false, reason: "stale_question" };
		// Refresh the existing evaluation view without manufacturing another Jev evaluation/verdict.
		if (record) this.notify(record);
		return { resolved: true };
	}

	private refreshSession(): void {
		const sink = this.durable?.();
		const sessionId = this.getSessionId?.() ?? sink?.sessionId;
		if (sessionId !== this.sessionId) {
			this.sessionId = sessionId;
			this.hydratedSessionId = undefined;
			this.doubts = new SemanticDoubtTracker();
			this.recent.length = 0;
			this.observed = false;
			this.lastOutcomeAt = undefined;
			this.lastFailure = undefined;
			this.lastFailedLabel = undefined;
			this.lastFailureKind = undefined;
		}
		if (!sessionId || this.hydratedSessionId === sessionId || !sink?.readEvaluations) return;
		try {
			const restored = new SemanticDoubtTracker();
			const recent = [...this.recent];
			let lastOutcome = recent.findLast((record) => record.outcome !== "cancelled");
			for (const persisted of sink.readEvaluations()) {
				const record = {
					...persisted,
					questionNamespace: persisted.questionNamespace ?? semanticQuestionNamespace(persisted.programId),
				};
				restored.start(record.evaluationId, record.programId, record.evaluationScope, record.questionNamespace);
				restored.observe(record);
				if (record.outcome !== "cancelled" && (!lastOutcome || record.endedAt >= lastOutcome.endedAt))
					lastOutcome = record;
				if (!recent.some((item) => item.evaluationId === record.evaluationId)) recent.push(record);
				recent.sort((left, right) => left.endedAt - right.endedAt || left.startedAt - right.startedAt);
				if (recent.length > MAX_RECENT_EVALUATIONS) {
					const removed = recent.shift();
					if (removed) restored.forgetRecent(removed.evaluationId);
				}
			}
			for (const decision of sink.readDoubtDecisions?.() ?? []) restored.resolveCurrent(decision);
			this.doubts = restored;
			this.recent.splice(0, this.recent.length, ...recent);
			if (lastOutcome) {
				this.observed = true;
				this.lastOutcomeAt = new Date(lastOutcome.endedAt).toISOString();
				this.lastFailure =
					lastOutcome.outcome === "failed" ? (lastOutcome.reasons?.[0] ?? "Evaluation failed") : undefined;
				this.lastFailedLabel = lastOutcome.outcome === "failed" ? lastOutcome.label : undefined;
				this.lastFailureKind =
					lastOutcome.outcome === "failed"
						? lastOutcome.reasons
								?.find((line) => line.startsWith("failure kind="))
								?.match(/^failure kind=(\w+)/)?.[1]
						: undefined;
			}
			this.hydratedSessionId = sessionId;
		} catch (error) {
			this.durableFailure = error instanceof Error ? error.message : String(error);
		}
	}

	private healthSnapshot(bound: boolean): SemanticPlaneHealth {
		if (!bound) return { state: "unbound" };
		const open = [...this.open.values()].filter(
			(record) => this.evaluationSessions.get(record.evaluationId) === this.sessionId,
		);
		if (open.length > 0) {
			return {
				state: "evaluating",
				inFlight: open.length,
				inFlightEvaluations: open,
				...(this.lastOutcomeAt ? { lastOutcomeAt: this.lastOutcomeAt } : {}),
				...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
			};
		}
		if (!this.observed) return { state: "unknown" };
		return {
			state: this.lastFailure ? "degraded" : "ok",
			...(this.lastOutcomeAt ? { lastOutcomeAt: this.lastOutcomeAt } : {}),
			...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
			...(this.lastFailure && this.lastFailedLabel ? { lastFailedLabel: this.lastFailedLabel } : {}),
			...(this.lastFailure && this.lastFailureKind ? { lastFailureKind: this.lastFailureKind } : {}),
		};
	}

	/** A settle for an unknown id is a no-op: the recorder can never be left `evaluating`. */
	private take(evaluationId: string): SemanticEvaluationStart | undefined {
		this.refreshSession();
		const start = this.open.get(evaluationId);
		if (start) this.open.delete(evaluationId);
		return start;
	}

	private push(
		start: SemanticEvaluationStart,
		outcome: SemanticEvaluationRecord["outcome"],
		verdict?: string,
		reasons?: readonly string[],
		questionStates?: readonly SemanticQuestionState[],
	): void {
		const endedAt = this.now();
		const record: SemanticEvaluationRecord = {
			...start,
			endedAt,
			durationMs: Math.max(0, endedAt - start.startedAt),
			outcome,
			...(verdict !== undefined ? { verdict } : {}),
			...(reasons?.length ? { reasons } : {}),
			...(questionStates !== undefined ? { questionStates } : {}),
		};
		this.doubts.observe(record);
		const current = this.evaluationSessions.get(record.evaluationId) === this.sessionId;
		if (current) {
			this.recent.push(record);
			while (this.recent.length > MAX_RECENT_EVALUATIONS) {
				const removed = this.recent.shift();
				if (removed) this.doubts.forgetRecent(removed.evaluationId);
			}
		}
		this.toDurable((sink) => sink.settle(record), this.evaluationSinks.get(record.evaluationId));
		this.evaluationSessions.delete(record.evaluationId);
		this.evaluationSinks.delete(record.evaluationId);
		if (current) this.notify(record);
	}

	private notify(record: SemanticEvaluationRecord): void {
		this.listeners.notify(
			(listener) => listener(record),
			() => {
				// A failing listener must not break the plane.
			},
		);
	}

	private toDurable(
		write: (sink: SemanticEvaluationDurableSink) => void,
		sink: SemanticEvaluationDurableSink | undefined,
	): void {
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
/** The short name the operator bar shows System One under. */
export const SYSTEM_ONE_BAR_LABEL = "S1";

/** The state word for a health state, without the System One label. */
export function semanticPlaneHealthValue(health: SemanticPlaneHealth): string {
	let value: string;
	switch (health.state) {
		case "ok":
			value = "ok";
			break;
		case "degraded": {
			// Which evaluation is failing and how, so the operator can tell an outage from one bad input.
			const detail = [health.lastFailedLabel, health.lastFailureKind].filter(Boolean).join(" ");
			value = detail ? `degraded · ${detail}` : "degraded";
			break;
		}
		case "evaluating":
			value = "eval";
			break;
		case "unknown":
			value = "ready";
			break;
		default:
			value = "off";
	}
	const count = health.unresolvedDoubts?.length ?? 0;
	return count ? `${value} · ${count} uncertain` : value;
}

export function semanticPlaneHealthLabel(health: SemanticPlaneHealth): string {
	return `${SYSTEM_ONE_BAR_LABEL} ${semanticPlaneHealthValue(health)}`;
}
