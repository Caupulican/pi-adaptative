/**
 * The decision ledger as an input to System One's next route: every route is recorded when decided
 * and stamped with its executor when it ran; the objective's recent routes feed the bounded state
 * the judge reads (`history`), and the stall evaluation reads the same rows, so "repeated without
 * new evidence" is a fact from the ledger, never a counter the loop keeps in memory.
 */

import type { DecisionLedgerStore } from "../operator-projection/decision-ledger-store.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { ObjectiveRoute } from "./objective-route.ts";
import { type RouteHistoryEntry, repeatedRouteCount } from "./objective-route-projector.ts";
import type { StallEvaluation } from "./objective-stall-fingerprint.ts";

export interface LedgerRouteCheckpointsDeps {
	getLedger(): DecisionLedgerStore | undefined;
	readonly sessionId: string;
	readonly cwd: string;
	getSnapshot(): TaskRuntimeProjection | undefined;
	now?(): number;
}

/** Objective evidence plus tasks plus attempts: any real progress moves it, a repeated route does not. */
export function evidenceMarkerOf(snapshot: TaskRuntimeProjection | undefined, objectiveId: string): number {
	if (!snapshot) return 0;
	const objective = snapshot.objectives[objectiveId];
	const tasks = Object.values(snapshot.tasks).filter((task) => task.task.objectiveId === objectiveId);
	const attempts = tasks.reduce((sum, task) => sum + task.attemptIds.length, 0);
	return (objective?.evidence.length ?? 0) * 1000 + tasks.length * 10 + attempts;
}

export class LedgerRouteCheckpoints {
	private readonly deps: LedgerRouteCheckpointsDeps;

	constructor(deps: LedgerRouteCheckpointsDeps) {
		this.deps = deps;
	}

	async recordRoute(route: ObjectiveRoute): Promise<void> {
		this.deps.getLedger()?.recordRoute({
			sessionId: this.deps.sessionId,
			cwd: this.deps.cwd,
			objectiveId: route.objective_id,
			cycleId: route.cycle_id,
			route: route.route,
			reasonCodes: route.reason_codes,
			decidedAt: (this.deps.now ?? Date.now)(),
			evidenceMarker: evidenceMarkerOf(this.deps.getSnapshot(), route.objective_id),
		});
	}

	async recordRouteOutcome(route: ObjectiveRoute, executor: string): Promise<void> {
		this.deps.getLedger()?.noteRouteExecutor(this.deps.sessionId, route.cycle_id, executor);
	}

	async recentRoutes(objectiveId: string, limit: number): Promise<readonly RouteHistoryEntry[]> {
		const rows = this.deps.getLedger()?.recentRoutes(this.deps.sessionId, objectiveId, limit) ?? [];
		return rows.map((row) => ({
			route: row.route,
			reasonCodes: row.reasonCodes,
			evidenceMarker: row.evidenceMarker,
			...(row.executor ? { executor: row.executor } : {}),
		}));
	}

	/** Stalled when the tail of the ledger repeats one route on one evidence marker. */
	async evaluate(objectiveId: string): Promise<StallEvaluation> {
		const history = await this.recentRoutes(objectiveId, 8);
		const repeated = repeatedRouteCount(history);
		const last = history.at(-1);
		const stalled = repeated >= 2;
		return {
			stalled,
			stallTurns: stalled ? repeated - 1 : 0,
			repeatedWithoutNewEvidence: stalled,
			fingerprint: last ? `${last.route}:${last.reasonCodes.join(",")}:${last.evidenceMarker}` : "init",
			...(stalled ? { reason: `route ${last?.route} repeated ${repeated} times without new evidence` } : {}),
		};
	}
}
