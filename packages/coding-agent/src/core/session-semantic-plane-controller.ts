/**
 * Session semantic-plane health recorder, evaluation-recording decision-engine wrapper, and
 * lazy SQLite decision-ledger lifecycle.
 */

import type { SessionManager } from "../kernel/session/session-manager.ts";
import { decisionLedgerFile } from "./agent-paths.ts";
import { createRetentionDecisionEngine } from "./compaction/retention-decision-engine.ts";
import type { SemanticDecisionEngine } from "./decision/engine.ts";
import { DecisionLedgerStore } from "./operator-projection/decision-ledger-store.ts";
import type { DecisionStageSink } from "./operator-projection/decision-stage-log.ts";
import type { SystemOneSteeringPlane } from "./steering/system-one-steering-plane.ts";
import type { SemanticUncertaintyPort } from "./system-one/semantic-doubts.ts";
import { type SemanticEvaluationRecord, verdictFromEvaluation } from "./system-one/semantic-evaluation-ledger.ts";
import {
	type SemanticEvaluationDurableSink,
	type SemanticPlaneHealth,
	SemanticPlaneHealthRecorder,
} from "./system-one/semantic-plane-health.ts";

export interface SessionSemanticPlaneControllerDeps {
	readonly agentDirForLedger: string;
	isDisposed(): boolean;
	getSessionManager(): SessionManager;
	getSteeringPlane(): SystemOneSteeringPlane | undefined;
}

/** node:sqlite reports a locked (5) or busy (6) database as ERR_SQLITE_ERROR with that errcode. */
function isSqliteBusy(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { code, errcode } = error as { code?: unknown; errcode?: unknown };
	return code === "ERR_SQLITE_ERROR" && (errcode === 5 || errcode === 6);
}

export class SessionSemanticPlaneController {
	private readonly deps: SessionSemanticPlaneControllerDeps;
	readonly health = new SemanticPlaneHealthRecorder();
	private recordedEngineSource?: SemanticDecisionEngine;
	private recordedEngine?: SemanticDecisionEngine;
	private decisionLedger?: DecisionLedgerStore;
	private decisionLedgerFailure?: string;
	/** The cached failure is a locked or busy database: it clears by itself, so the next use tries again. */
	private decisionLedgerBusy = false;
	private stageSink?: { readonly key: string; readonly sink: DecisionStageSink };

	constructor(deps: SessionSemanticPlaneControllerDeps) {
		this.deps = deps;
		this.health.bindDurable(
			() => this.semanticLedgerSink(),
			() => this.deps.getSessionManager().getSessionId(),
		);
	}

	/**
	 * The one way this session hands its semantic decision engine to anything: the plane's engine
	 * wrapped so every evaluation it runs is recorded. Every in-session consumer goes through here,
	 * so the POV bar's Jev indicator reports the whole plane's work and not one subsystem's.
	 * Memoized per underlying engine so collaborators wired once keep a stable engine identity.
	 */
	recordingSemanticEngine(): SemanticDecisionEngine | undefined {
		const engine = this.deps.getSteeringPlane()?.decisionEngine;
		if (!engine) return undefined;
		if (this.recordedEngineSource === engine && this.recordedEngine) {
			return this.recordedEngine;
		}
		const recorded: SemanticDecisionEngine = {
			id: engine.id,
			model: engine.model,
			capabilities: () => engine.capabilities(),
			evaluate: async (program, state, options) => {
				// The in-flight record is what lets the POV bar show `S1 eval` only while a real
				// evaluation runs and the Decision graph say what Jev is judging; settlement below
				// always closes it and keeps the verdict for the ledger.
				const evaluationId = this.health.start({
					programId: program.id,
					...(options?.consequence ? { consequence: options.consequence } : {}),
					...(options?.evaluationScope ? { evaluationScope: options.evaluationScope } : {}),
					model: engine.model,
				});
				try {
					const evaluation = await engine.evaluate(program, state, options);
					const { verdict, reasons, questionStates } = verdictFromEvaluation(evaluation);
					this.health.settleOk(evaluationId, verdict, reasons, questionStates);
					return evaluation;
				} catch (error) {
					// A cancelled evaluation is not a degraded plane: the abort came from the operator or
					// the caller, and the plane never reported an outcome to judge it by.
					if (options?.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
						this.health.settleCancelled(evaluationId);
					} else {
						this.health.settleFailed(evaluationId, error);
					}
					throw error;
				}
			},
		};
		this.recordedEngineSource = engine;
		this.recordedEngine = recorded;
		return recorded;
	}

	/** The recorded engine in the retention planner's batched-question shape. */
	semanticDecisionEngine(): ReturnType<typeof createRetentionDecisionEngine> | undefined {
		const engine = this.recordingSemanticEngine();
		return engine ? createRetentionDecisionEngine(engine) : undefined;
	}

	/**
	 * The decision ledger, opened lazily. A ledger that cannot open (read-only state dir, driver
	 * missing) is reported once and the session runs with process-local records rather than failing.
	 */
	getDecisionLedger(): DecisionLedgerStore | undefined {
		if (this.deps.isDisposed()) return undefined;
		if (this.decisionLedger || (this.decisionLedgerFailure !== undefined && !this.decisionLedgerBusy)) {
			return this.decisionLedger;
		}
		try {
			this.decisionLedger = new DecisionLedgerStore({
				databasePath: decisionLedgerFile(this.deps.agentDirForLedger),
			});
			this.decisionLedgerFailure = undefined;
			this.decisionLedgerBusy = false;
		} catch (error) {
			this.decisionLedgerFailure = error instanceof Error ? error.message : String(error);
			// A locked or busy database clears by itself: the next use tries again. Any other failure (no driver,
			// read-only state directory) is permanent for the session.
			this.decisionLedgerBusy = isSqliteBusy(error);
		}
		return this.decisionLedger;
	}

	/** Why the ledger is unavailable, when it is. */
	getDecisionLedgerFailure(): string | undefined {
		return this.decisionLedgerFailure;
	}

	/** The stage-log sink bound to the current session id; rebound when the session changes. */
	stageSinkForSession(): { readonly key: string; readonly sink: DecisionStageSink } | undefined {
		const ledger = this.getDecisionLedger();
		if (!ledger) return undefined;
		const key = this.deps.getSessionManager().getSessionId();
		if (this.stageSink?.key !== key) {
			this.stageSink = { key, sink: ledger.stageSink(key, this.deps.getSessionManager().getCwd()) };
		}
		return this.stageSink;
	}

	/** Binds the one evaluation sink onto a steering plane; both plane assignments go through here. */
	bindSemanticObserver(plane: SystemOneSteeringPlane | undefined): void {
		plane?.setEvaluationObserver(this.health);
	}

	/** The durable side of the Jev ledger, bound to the current session id and cwd. */
	semanticLedgerSink(): SemanticEvaluationDurableSink | undefined {
		const ledger = this.getDecisionLedger();
		if (!ledger) return undefined;
		const sessionId = this.deps.getSessionManager().getSessionId();
		const cwd = this.deps.getSessionManager().getCwd();
		return {
			sessionId,
			readDoubtDecisions: () => ledger.semanticDoubtDecisions(sessionId),
			recordDoubtDecision: (decision) => ledger.recordSemanticDoubtDecision(sessionId, decision),
			readEvaluations: () =>
				ledger.semanticEvaluations(sessionId).flatMap((row) => {
					if (row.endedAt === undefined || row.outcome === undefined) return [];
					return [
						{
							evaluationId: row.evaluationId,
							programId: row.programId,
							label: row.label,
							...(row.evaluationScope ? { evaluationScope: row.evaluationScope } : {}),
							...(row.questionNamespace ? { questionNamespace: row.questionNamespace } : {}),
							startedAt: row.startedAt,
							endedAt: row.endedAt,
							durationMs: Math.max(0, row.endedAt - row.startedAt),
							outcome: row.outcome,
							...(row.verdict !== undefined ? { verdict: row.verdict } : {}),
							...(row.reasons ? { reasons: row.reasons } : {}),
							...(row.questionStates ? { questionStates: row.questionStates } : {}),
						},
					];
				}),
			start: (record) =>
				ledger.startSemanticEvaluation({
					evaluationId: record.evaluationId,
					sessionId,
					cwd,
					programId: record.programId,
					label: record.label,
					startedAt: record.startedAt,
					...(record.evaluationScope ? { evaluationScope: record.evaluationScope } : {}),
					...(record.questionNamespace ? { questionNamespace: record.questionNamespace } : {}),
					...(record.consequence ? { consequence: record.consequence } : {}),
					...(record.model ? { model: record.model } : {}),
				}),
			settle: (record) =>
				ledger.settleSemanticEvaluation(record.evaluationId, {
					endedAt: record.endedAt,
					outcome: record.outcome,
					...(record.verdict !== undefined ? { verdict: record.verdict } : {}),
					...(record.reasons ? { reasons: record.reasons } : {}),
					...(record.questionStates ? { questionStates: record.questionStates } : {}),
				}),
			noteVerdict: (evaluationId, verdict, reasons, questionStates) =>
				ledger.noteSemanticVerdict(evaluationId, verdict, reasons, questionStates),
		};
	}

	/** Recent Jev evaluations: what was judged, when, and what it decided. */
	getSemanticEvaluations(): readonly SemanticEvaluationRecord[] {
		return this.health.getRecentEvaluations();
	}

	/** Subscribes to settled Jev evaluations (the Execution pane's Jev previews). */
	onSemanticEvaluation(listener: (record: SemanticEvaluationRecord) => void): () => void {
		return this.health.subscribe(listener);
	}

	/** Observed health of this session's semantic plane. */
	getSemanticPlaneHealth(): SemanticPlaneHealth {
		return this.health.getHealth(Boolean(this.deps.getSteeringPlane()?.decisionEngine));
	}

	/** Live semantic uncertainty decisions, scoped to this root session by the health recorder. */
	getSemanticUncertainties(): SemanticUncertaintyPort {
		return this.health;
	}

	/** Closes the decision ledger and releases its SQLite handle. */
	closeDecisionLedger(): void {
		this.decisionLedger?.close();
		this.decisionLedger = undefined;
	}
}
