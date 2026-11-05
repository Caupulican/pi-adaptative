/**
 * A worker conversation's request planning and cache guard. The parent's context pipeline plans each worker request
 * on the worker's own context-policy lane (the mechanics every agent needs, none of the head-only steps), and the
 * parent's lane guard guards it as its own conversation. Composed from any pipeline and lane guard, so a parent
 * opened away plans its workers' requests the way the foreground does.
 */

import type { EdgeGrantView } from "../autonomy/edge-policy.ts";
import type { CacheLaneGuard } from "../context/cache-lane-guard.ts";
import type { ContextPipeline } from "../context-pipeline.ts";
import type { ParentExecutionPolicy } from "./parent-execution-context.ts";

export interface WorkerRequestPlannerDeps {
	/** Read per request: the foreground builds its pipeline after the worker coordinator. */
	getPipeline(): Pick<ContextPipeline, "planWorkerRequest">;
	readonly guard: CacheLaneGuard;
	getEdgeGrants(): readonly EdgeGrantView[];
}

export type WorkerRequestPlanner = Required<
	Pick<
		ParentExecutionPolicy,
		| "planWorkerRequest"
		| "observeWorkerRequest"
		| "observeWorkerResponse"
		| "admitWorkerEarlyCompaction"
		| "recordWorkerCompactionOutcome"
	>
>;

export function createWorkerRequestPlanner(deps: WorkerRequestPlannerDeps): WorkerRequestPlanner {
	const { guard } = deps;
	return {
		planWorkerRequest: (input) => deps.getPipeline().planWorkerRequest(input, () => deps.getEdgeGrants()),
		observeWorkerRequest: (agentId, snapshot, prefixTokens) =>
			guard.observeWorkerRequest(agentId, snapshot, prefixTokens),
		observeWorkerResponse: (message, observation) => guard.observeWorkerResponse(message, observation),
		admitWorkerEarlyCompaction: ({ agentId, model, contextTokens, messages }) =>
			guard.admitWorkerEarlyCompaction(agentId, model, contextTokens, messages),
		recordWorkerCompactionOutcome: ({ agentId, ...outcome }) => guard.recordCompactionOutcome(outcome, agentId),
	};
}
