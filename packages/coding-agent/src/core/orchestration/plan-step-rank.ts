/**
 * A plan step's rank in the fleet's order: a verify step runs first, a step on its plan's longest path next, any other step
 * after. One definition for the dispatch a release builds and for the request a restart rebuilds, so a step waits in the
 * same place before and after its owner is opened again. Pure code over the plan record.
 */

import type { FleetRank } from "../fleet/fleet-types.ts";
import { isPlanFromNewerBuild, type PlanNodeSpec, planCriticalPath } from "../plan/plan-graph.ts";
import { planNodeOfTask } from "../plan/plan-reducer.ts";
import type { TaskRuntimeProjection } from "./task-runtime-state.ts";

/** The rank of one step of a plan whose critical path is `criticalPath`. */
export function planNodeRank(node: Pick<PlanNodeSpec, "id" | "kind">, criticalPath: ReadonlySet<string>): FleetRank {
	const critical = criticalPath.has(node.id);
	return { priority: node.kind === "verify" ? 3 : critical ? 2 : 1, criticalPath: critical };
}

/**
 * The rank of the plan step that released `taskId`, read from the plan as it stands; undefined for any other task, and for
 * a task its plan retired or a plan a newer build wrote.
 */
export function planStepRankOfTask(
	projection: Pick<TaskRuntimeProjection, "plans" | "tasks">,
	taskId: string,
): FleetRank | undefined {
	const located = planNodeOfTask(projection, taskId);
	if (!located || located.retired) return undefined;
	const record = projection.plans[located.planId]?.record;
	if (!record || isPlanFromNewerBuild(record)) return undefined;
	const node = record.nodes.find((candidate) => candidate.id === located.nodeId);
	return node ? planNodeRank(node, planCriticalPath(record)) : undefined;
}
