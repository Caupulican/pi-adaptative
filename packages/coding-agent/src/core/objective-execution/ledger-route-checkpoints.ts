/**
 * The decision ledger as an input to System One's next route: every route is recorded when decided
 * and stamped with its executor when it ran; the objective's recent routes feed the bounded state
 * the judge reads (`history`), and the stall evaluation reads the same rows, so "repeated without
 * new evidence" is a fact from the ledger, never a counter the loop keeps in memory.
 */

import type { DecisionLedgerStore } from "../operator-projection/decision-ledger-store.ts";
import {
	reconcileArchivedWorkerRouteStarts,
	reconcileWorkerRouteStarts,
} from "../operator-projection/worker-route-starts.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { OBJECTIVE_WAIT_ROUTES, type ObjectiveRoute, SCOPE_REPLAN_EXECUTOR } from "./objective-route.ts";
import { type RouteHistoryEntry, repeatedRouteCount } from "./objective-route-projector.ts";
import { evidenceMarkerOf, ObjectiveStallDetector, type StallEvaluation } from "./objective-stall-fingerprint.ts";

export interface LedgerRouteCheckpointsDeps {
	getLedger(): DecisionLedgerStore | undefined;
	readonly sessionId: string;
	readonly cwd: string;
	readonly eventStoreRoot?: string;
	getSnapshot(): TaskRuntimeProjection | undefined;
	now?(): number;
}

/** The route and measured work identity captured at decision time. */
export function routeHistoryEntry(
	route: ObjectiveRoute,
	runtime: TaskRuntimeProjection | undefined,
): RouteHistoryEntry {
	return {
		route: route.route,
		reasonCodes: route.reason_codes,
		evidenceMarker: evidenceMarkerOf(runtime, route.objective_id),
		workKey: ObjectiveStallDetector.computeStrategyFingerprint({
			route: route.route,
			targetRequirementIds: route.target_requirement_ids,
			targetHypothesisIds: route.target_hypothesis_ids,
		}),
	};
}

/** A scope refusal can submit a root replan in the same decision cycle. Keep the executed work distinct. */
function executedStrategy(entry: RouteHistoryEntry, executor?: string): RouteHistoryEntry {
	if (executor === SCOPE_REPLAN_EXECUTOR)
		return {
			route: "replan",
			reasonCodes: ["executor_scope_replan_required"],
			evidenceMarker: entry.evidenceMarker,
			workKey: ObjectiveStallDetector.computeStrategyFingerprint({ route: "replan", targetRequirementIds: [] }),
			executor,
		};
	return executor ? { ...entry, executor } : entry;
}

/** Fallback for SDK controllers without a history store. Preserve the same measured strategy rows. */
export class LocalRouteHistory {
	private readonly rows: { objectiveId: string; cycleId: string; entry: RouteHistoryEntry }[] = [];

	recent(objectiveId: string, limit: number): readonly RouteHistoryEntry[] {
		return this.rows
			.filter((row) => row.objectiveId === objectiveId)
			.slice(-limit)
			.map((row) => row.entry);
	}

	record(route: ObjectiveRoute, runtime: TaskRuntimeProjection, executor: string): void {
		if (OBJECTIVE_WAIT_ROUTES.includes(route.route)) return;
		const prior = this.rows.find((row) => row.cycleId === route.cycle_id);
		if (prior) {
			prior.entry = executedStrategy(prior.entry, executor);
			return;
		}
		this.rows.push({
			objectiveId: route.objective_id,
			cycleId: route.cycle_id,
			entry: executedStrategy(routeHistoryEntry(route, runtime), executor),
		});
		if (this.rows.length > 20) this.rows.shift();
	}
}

export class LedgerRouteCheckpoints {
	private readonly deps: LedgerRouteCheckpointsDeps;
	private readonly reconciledSnapshots = new WeakMap<TaskRuntimeProjection, DecisionLedgerStore>();

	constructor(deps: LedgerRouteCheckpointsDeps) {
		this.deps = deps;
	}

	async recordRoute(route: ObjectiveRoute): Promise<void> {
		this.deps.getLedger()?.recordRoute({
			sessionId: this.deps.sessionId,
			cwd: this.deps.cwd,
			objectiveId: route.objective_id,
			cycleId: route.cycle_id,
			decidedAt: (this.deps.now ?? Date.now)(),
			...routeHistoryEntry(route, this.deps.getSnapshot()),
		});
	}

	async recordRouteOutcome(route: ObjectiveRoute, executor: string): Promise<void> {
		this.deps.getLedger()?.noteRouteExecutor(this.deps.sessionId, route.cycle_id, executor, route.objective_id);
	}

	async recentRoutes(objectiveId: string, limit: number): Promise<readonly RouteHistoryEntry[]> {
		const ledger = this.deps.getLedger();
		if (!ledger) return [];
		const snapshot = this.deps.getSnapshot();
		if (snapshot && this.reconciledSnapshots.get(snapshot) !== ledger) {
			reconcileWorkerRouteStarts(this.deps.sessionId, snapshot, () => ledger);
			if (this.deps.eventStoreRoot)
				reconcileArchivedWorkerRouteStarts(
					this.deps.sessionId,
					this.deps.eventStoreRoot,
					snapshot.retentionArchiveIds,
					() => ledger,
				);
			this.reconciledSnapshots.set(snapshot, ledger);
		}
		const rows = ledger.recentRoutes(this.deps.sessionId, objectiveId, limit, true);
		return rows.map((row) =>
			executedStrategy(
				{
					route: row.route,
					reasonCodes: row.reasonCodes,
					evidenceMarker: row.evidenceMarker,
					workKey: row.workKey,
				},
				row.executor,
			),
		);
	}

	/**
	 * Stalled when the tail of the ledger repeats one executable route on one evidence marker. A
	 * repeated wait is waiting on work in flight, never a repeated strategy.
	 */
	async evaluate(objectiveId: string): Promise<StallEvaluation> {
		const history = await this.recentRoutes(objectiveId, 8);
		return evaluateRouteHistory(history, evidenceMarkerOf(this.deps.getSnapshot(), objectiveId));
	}
}

export function evaluateRouteHistory(history: readonly RouteHistoryEntry[], marker: number): StallEvaluation {
	const repeated = repeatedRouteCount(history, marker);
	const last = history.findLast((entry) => !OBJECTIVE_WAIT_ROUTES.includes(entry.route));
	const stalled = repeated >= 2;
	return {
		stalled,
		stallTurns: stalled ? repeated - 1 : 0,
		repeatedWithoutNewEvidence: stalled,
		fingerprint: last ? `${last.workKey ?? last.route}:${last.evidenceMarker}` : "init",
		...(stalled ? { reason: `route ${last?.route} repeated ${repeated} times without new evidence` } : {}),
	};
}
