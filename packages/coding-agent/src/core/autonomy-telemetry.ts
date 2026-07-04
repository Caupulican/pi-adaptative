/**
 * Autonomy telemetry sink + status/diagnostic snapshots.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Owns the latest gate outcome
 * and the bounded gate-outcome history, and is the single sink for G3 autonomy-telemetry custom
 * entries. The two snapshot builders READ broadly across live session state (router decision, cost,
 * goal, lanes, and the research/delegation/learning/goal getters) through narrow deps accessors
 * rather than the whole AgentSession — they never mutate anything but the owned gate-outcome fields.
 */

import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { SessionStats, SpawnedUsageTotals } from "./agent-session.ts";
import type { EvidenceBundle, GateOutcome, LearningDecision, WorkerResult } from "./autonomy/contracts.ts";
import { getLaneRecordSnapshots } from "./autonomy/session-lane-record.ts";
import type {
	AutonomyDiagnosticSnapshot,
	AutonomyStatusSnapshot,
	DiagnosticEntry,
	GateOutcomeHistoryEntry,
} from "./autonomy/status.ts";
import {
	AUTONOMY_TELEMETRY_EVENT_TYPES,
	type AutonomyTelemetryEvent,
	redactTelemetryValue,
} from "./autonomy/telemetry-events.ts";
import type { DailyUsageTotals } from "./cost/daily-usage.ts";
import type { GoalState } from "./goals/goal-state.ts";
import type { LearningAuditRecord } from "./learning/learning-audit.ts";
import { getRecentModelRouterDecisions, type ModelRouterDecisionStatus } from "./model-router/status.ts";

/** Custom-entry type for G3 autonomy telemetry. Distinct from the router/lane record types so a
 * telemetry consumer can filter on it without decoding operational snapshots. */
const AUTONOMY_TELEMETRY_CUSTOM_TYPE = "autonomy-telemetry";

/** G8: bound on the in-memory gate-outcome history. Oldest entries evict once the cap is reached. */
const GATE_OUTCOME_HISTORY_LIMIT = 50;

export interface AutonomyTelemetryDeps {
	/** Session log: `appendCustomEntry` is the telemetry sink; `getEntries` feeds diagnostic aggregation. */
	getSessionManager(): Pick<SessionManager, "appendCustomEntry" | "getEntries">;
	/** Latest model-router decision, for the snapshot's `latestRoute` — owned by the router, not this sink. */
	getLastModelRouterDecision(): ModelRouterDecisionStatus | undefined;
	/** Reason the last research lane was skipped, if any — surfaced in the diagnostic's research family. */
	getLastResearchLaneSkipReason(): string | undefined;
	/** This session's own usage totals (cost only is read). */
	getSessionStats(): SessionStats;
	/** Spawned-child usage totals (cost only is read). */
	getSpawnedUsage(): SpawnedUsageTotals;
	/** Cross-session daily usage totals, if trackable — preserves the source's optional-call semantics. */
	getDailyUsageTotals(): DailyUsageTotals | undefined;
	/** Current goal state, if a goal is active. */
	getGoalStateSnapshot(): GoalState | undefined;
	/** Live count of active lanes from the lane tracker — never inferred from historical snapshots. */
	getActiveLaneCount(): number;
	/** Research evidence bundles recorded this session. */
	getEvidenceBundleSnapshots(): EvidenceBundle[];
	/** Worker-delegation result snapshots recorded this session. */
	getWorkerResultSnapshots(): WorkerResult[];
	/** Learning decision snapshots recorded this session. */
	getLearningDecisionSnapshots(): LearningDecision[];
	/** Learning audit records recorded this session. */
	getLearningAuditRecords(): LearningAuditRecord[];
}

export class AutonomyTelemetry {
	private _lastAutonomyGateOutcome?: GateOutcome;
	/** G8: bounded (cap {@link GATE_OUTCOME_HISTORY_LIMIT}) history of gate outcomes; tail is latest. */
	private readonly _gateOutcomeHistory: GateOutcomeHistoryEntry[] = [];

	private readonly deps: AutonomyTelemetryDeps;

	constructor(deps: AutonomyTelemetryDeps) {
		this.deps = deps;
	}

	/**
	 * G3: bounded autonomy-telemetry sink. Passes the whole event through {@link redactTelemetryValue}
	 * (the taxonomy's redaction contract) before storing it, so a secret that leaked into a payload
	 * field never lands in the session log. Observe-only: a failure here can never surface into the
	 * turn it is measuring, so the whole body is swallowed. Payloads MUST stay small (ids, codes,
	 * numbers) — never prompt/summary text; callers own that discipline.
	 */
	emitTelemetry(event: AutonomyTelemetryEvent): void {
		try {
			const redacted = redactTelemetryValue(event) as Record<string, unknown>;
			this.deps.getSessionManager().appendCustomEntry(AUTONOMY_TELEMETRY_CUSTOM_TYPE, { version: 1, ...redacted });
		} catch {
			// Telemetry is best-effort: swallow so a sink failure cannot break the observed turn.
		}
	}

	/**
	 * G8: single sink for a gate outcome. Keeps the latest-outcome getter behavior identical (the
	 * full {@link GateOutcome} still lands in `_lastAutonomyGateOutcome`), and additionally appends a
	 * bounded codes-only entry to {@link _gateOutcomeHistory} (oldest evicted at
	 * {@link GATE_OUTCOME_HISTORY_LIMIT}) and emits the `gate_outcome` telemetry event. The history
	 * tail therefore always mirrors the latest outcome. Only called with an active envelope.
	 */
	recordGateOutcome(outcome: GateOutcome): void {
		this._lastAutonomyGateOutcome = outcome;
		const at = new Date().toISOString();
		this._gateOutcomeHistory.push({
			outcome: outcome.outcome,
			gate: outcome.gate,
			reasonCode: outcome.reasonCode,
			at,
		});
		while (this._gateOutcomeHistory.length > GATE_OUTCOME_HISTORY_LIMIT) {
			this._gateOutcomeHistory.shift();
		}
		// G8: gate outcome event. Codes/ids only — never the gate's human-facing message.
		this.emitTelemetry({
			type: AUTONOMY_TELEMETRY_EVENT_TYPES.gateOutcome,
			timestamp: at,
			payload: {
				outcome: outcome.outcome,
				gate: outcome.gate,
				reasonCode: outcome.reasonCode,
			},
		});
	}

	/** G8: copies of the bounded gate-outcome history, oldest first, latest last. */
	getGateOutcomeHistory(): GateOutcomeHistoryEntry[] {
		return this._gateOutcomeHistory.map((entry) => ({ ...entry }));
	}

	getStatusSnapshot(): AutonomyStatusSnapshot {
		const snapshot: AutonomyStatusSnapshot = {};

		const lastRouterDecision = this.deps.getLastModelRouterDecision();
		if (lastRouterDecision?.route) {
			snapshot.latestRoute = {
				tier: lastRouterDecision.route.tier,
				reasonCode: lastRouterDecision.route.reasonCode,
				risk: lastRouterDecision.route.risk,
			};
		}

		if (this._lastAutonomyGateOutcome) {
			snapshot.latestGate = {
				outcome: this._lastAutonomyGateOutcome.outcome,
				gate: this._lastAutonomyGateOutcome.gate,
				reasonCode: this._lastAutonomyGateOutcome.reasonCode,
			};
		}

		const currentCost = this.deps.getSessionStats().cost;
		if (currentCost > 0) {
			snapshot.currentCostUsd = currentCost;
		}

		const spawnedCost = this.deps.getSpawnedUsage().cost;
		if (spawnedCost > 0) {
			snapshot.spawnedCostUsd = spawnedCost;
		}

		const dailyCost = this.deps.getDailyUsageTotals()?.totalCost;
		if (dailyCost !== undefined && dailyCost > 0) {
			snapshot.dailyCostUsd = dailyCost;
		}

		const goal = this.deps.getGoalStateSnapshot();
		if (goal) {
			snapshot.activeGoal = {
				goalId: goal.goalId,
				status: goal.status,
				openRequirements: goal.requirements.filter((requirement) => requirement.status === "open").length,
				stallTurns: goal.stallTurns,
			};
		}

		// Real live count from the lane tracker — never inferred from historical snapshots. Absent
		// while zero, matching the presence-means-signal convention of the sibling fields.
		const activeLaneCount = this.deps.getActiveLaneCount();
		if (activeLaneCount > 0) {
			snapshot.activeLaneCount = activeLaneCount;
		}

		return snapshot;
	}

	/**
	 * Aggregate an effectiveness/autonomy dashboard: what Pi has actually been doing (recent
	 * route choices, latest gate outcome, cost, and any research/delegation/learning/goal
	 * activity). Read-only — combines existing session-log getters, never mutates state or
	 * recomputes a route/gate decision.
	 */
	getDiagnosticSnapshot(options?: { maxEntriesPerFamily?: number }): AutonomyDiagnosticSnapshot {
		const maxEntriesPerFamily = options?.maxEntriesPerFamily ?? 10;
		const snapshot: AutonomyDiagnosticSnapshot = {};
		const goal = this.deps.getGoalStateSnapshot();

		const recentDecisions = getRecentModelRouterDecisions(
			this.deps.getSessionManager().getEntries(),
			maxEntriesPerFamily,
		);
		if (recentDecisions.length > 0) {
			snapshot.routes = recentDecisions.map(
				(decision): DiagnosticEntry => ({
					title: decision.route.tier,
					summary: decision.routedModel,
					reasonCode: decision.route.reasonCode,
					metadata: { risk: decision.route.risk, outcome: decision.outcome, intent: decision.intent },
				}),
			);
		}

		if (this._lastAutonomyGateOutcome) {
			const gate = this._lastAutonomyGateOutcome;
			snapshot.gates = [
				{
					title: gate.gate,
					summary: gate.message,
					reasonCode: gate.reasonCode,
					metadata: { outcome: gate.outcome, reversible: gate.reversible },
				},
			];
		}

		const costs: DiagnosticEntry[] = [];
		const currentCostForDiagnostics = this.deps.getSessionStats().cost;
		if (currentCostForDiagnostics > 0) {
			costs.push({ title: "current", summary: `$${currentCostForDiagnostics.toFixed(4)}` });
		}
		const spawnedCost = this.deps.getSpawnedUsage().cost;
		if (spawnedCost > 0) costs.push({ title: "spawned", summary: `$${spawnedCost.toFixed(4)}` });
		const dailyCostForDiagnostics = this.deps.getDailyUsageTotals()?.totalCost;
		if (dailyCostForDiagnostics !== undefined && dailyCostForDiagnostics > 0) {
			costs.push({ title: "daily", summary: `$${dailyCostForDiagnostics.toFixed(4)}` });
		}
		if (costs.length > 0) snapshot.costs = costs;

		const researchEntries: DiagnosticEntry[] = [];
		const researchLaneRecords = getLaneRecordSnapshots(this.deps.getSessionManager().getEntries()).filter(
			(record) => record.type === "research",
		);
		for (const record of researchLaneRecords.slice(-maxEntriesPerFamily)) {
			researchEntries.push({
				title: `Lane ${record.laneId} (${record.status})`,
				reasonCode: record.reasonCode,
				metadata: {
					costUsd: record.costUsd,
					startedAt: record.startedAt,
					completedAt: record.completedAt,
					goalId: record.goalId,
				},
			});
		}
		for (const bundle of this.deps.getEvidenceBundleSnapshots().slice(-maxEntriesPerFamily)) {
			researchEntries.push({
				title: `Research: ${bundle.query}`,
				metadata: { sourceCount: bundle.sources.length, findingCount: bundle.findings.length },
			});
		}
		if (this.deps.getLastResearchLaneSkipReason()) {
			researchEntries.push({ title: "Last skip", reasonCode: this.deps.getLastResearchLaneSkipReason() });
		}
		if (researchEntries.length > 0) {
			snapshot.research = researchEntries;
		}

		const delegationEntries: DiagnosticEntry[] = [];
		const workerLaneRecords = getLaneRecordSnapshots(this.deps.getSessionManager().getEntries()).filter(
			(record) => record.type === "worker",
		);
		for (const record of workerLaneRecords.slice(-maxEntriesPerFamily)) {
			delegationEntries.push({
				title: `Lane ${record.laneId} (${record.status})`,
				reasonCode: record.reasonCode,
				metadata: { costUsd: record.costUsd, startedAt: record.startedAt, completedAt: record.completedAt },
			});
		}
		const workerResults = this.deps.getWorkerResultSnapshots();
		for (const result of workerResults.slice(-maxEntriesPerFamily)) {
			delegationEntries.push({
				title: `Worker ${result.requestId} (${result.status})`,
				summary: result.summary,
				metadata: {
					changedFileCount: result.changedFiles.length,
					blockerCount: result.blockers?.length ?? 0,
					usageReportId: result.usageReportId,
				},
			});
		}
		if (delegationEntries.length > 0) {
			snapshot.delegation = delegationEntries;
		}

		const learningEntries: DiagnosticEntry[] = [];
		const learningDecisions = this.deps.getLearningDecisionSnapshots();
		for (const decision of learningDecisions.slice(-maxEntriesPerFamily)) {
			learningEntries.push({
				title: `Learning (${decision.kind})`,
				summary: decision.summary,
				reasonCode: decision.reasonCode,
				metadata: { confidence: decision.confidence, requiresApproval: decision.requiresApproval },
			});
		}
		for (const audit of this.deps.getLearningAuditRecords().slice(-maxEntriesPerFamily)) {
			learningEntries.push({
				title: `Audit ${audit.id} (${audit.action})`,
				summary: audit.summary,
				reasonCode: audit.reasonCode,
				metadata: { layer: audit.layer, proposalId: audit.proposalId, rollbackOf: audit.rollbackOf },
			});
		}
		if (learningEntries.length > 0) {
			snapshot.learning = learningEntries;
		}

		if (goal) {
			snapshot.goals = [
				{
					title: `Goal ${goal.goalId}`,
					summary: goal.userGoal,
					reasonCode: goal.status,
					metadata: {
						openRequirementCount: goal.requirements.filter((requirement) => requirement.status === "open").length,
						stallTurns: goal.stallTurns,
						blockedReason: goal.blockedReason,
					},
				},
			];
		}

		return snapshot;
	}
}
