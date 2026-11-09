/**
 * Reduction of the `plan.*` orchestration events into the projection's `plans` map. Called by the orchestration
 * reducer only; every rule here is replay-safe: the same journal always yields the same plans, a record from a newer
 * build is kept by identity, and a node's runtime survives a revise only when its spec was not restated.
 */

import { isOutcomeFromNewerBuild } from "../delegation/worker-outcome-contract.ts";
import type { OrchestrationEvent } from "../orchestration/contracts.ts";
import { DurableTaskRuntimeError, type TaskRuntimeState } from "../orchestration/task-runtime-state.ts";
import {
	planClosedFromValue,
	planJoinSettledFromValue,
	planNodeHeldFromValue,
	planNodeReleasedFromValue,
	planNodeSettledFromValue,
	planRecordFromValue,
} from "./plan-codec.ts";
import {
	isPlanFromNewerBuild,
	PLAN_LIMITS,
	type PlanNodeRuntime,
	type PlanRecord,
	type PlanRetiredTask,
	type PlanRuntimeState,
	planTopologicalOrder,
} from "./plan-graph.ts";

export const PLAN_EVENT_TYPES = [
	"plan.recorded",
	"plan.node_released",
	"plan.node_settled",
	"plan.node_held",
	"plan.join_settled",
	"plan.closed",
] as const;
export type PlanEventType = (typeof PLAN_EVENT_TYPES)[number];

export function isPlanEventType(type: string): type is PlanEventType {
	return (PLAN_EVENT_TYPES as readonly string[]).includes(type);
}

function refuse(message: string): never {
	throw new DurableTaskRuntimeError(message);
}

function activePlan(plans: Record<string, PlanRuntimeState>, planId: string, event: OrchestrationEvent) {
	const plan = plans[planId];
	if (!plan) return refuse(`${event.type} names unknown plan '${planId}'.`);
	if (event.aggregateId !== planId) refuse(`${event.type} aggregate does not match plan '${planId}'.`);
	if (isPlanFromNewerBuild(plan.record)) return undefined;
	if (plan.closed) refuse(`${event.type} arrived after plan '${planId}' closed.`);
	return { plan, record: plan.record };
}

function nodeOf(plan: PlanRuntimeState, record: PlanRecord, nodeId: string, type: string) {
	const spec = record.nodes.find((node) => node.id === nodeId);
	const runtime = plan.nodes[nodeId];
	if (!spec || !runtime) return refuse(`${type} names step '${nodeId}' that plan '${record.planId}' does not run.`);
	return { spec, runtime };
}

function withNode(plan: PlanRuntimeState, nodeId: string, runtime: PlanNodeRuntime): PlanRuntimeState {
	return { ...plan, nodes: { ...plan.nodes, [nodeId]: runtime } };
}

function retire(retired: PlanRetiredTask[], entry: PlanRetiredTask): void {
	if (retired.some((existing) => existing.taskId === entry.taskId)) return;
	if (retired.length >= PLAN_LIMITS.retiredTasks) refuse("A plan retired more tasks than its bound.");
	retired.push(entry);
}

/** Drops the oldest closed plan when a new plan would exceed the retained bound; an open plan is never dropped. */
function makeRoom(plans: Record<string, PlanRuntimeState>): void {
	if (Object.keys(plans).length < PLAN_LIMITS.retainedPlans) return;
	const closed = Object.entries(plans)
		.filter(([, plan]) => plan.closed !== undefined)
		.sort(([, a], [, b]) => (a.closed?.closedAt ?? "").localeCompare(b.closed?.closedAt ?? ""));
	const oldest = closed[0];
	if (!oldest) refuse(`A session keeps at most ${PLAN_LIMITS.retainedPlans} plans and none of them is closed.`);
	else delete plans[oldest[0]];
}

function recordPlan(plans: Record<string, PlanRuntimeState>, event: OrchestrationEvent): void {
	const record = planRecordFromValue(event.payload.record, "plan.recorded.record");
	if (event.aggregateId !== record.planId) refuse("plan.recorded aggregate does not match its plan id.");
	const previous = plans[record.planId];
	if (isPlanFromNewerBuild(record)) {
		if (!previous) makeRoom(plans);
		plans[record.planId] = { record, nodes: previous?.nodes ?? {}, retired: previous?.retired ?? [] };
		return;
	}
	const expected = previous && !isPlanFromNewerBuild(previous.record) ? previous.record.version + 1 : 1;
	if (previous && isPlanFromNewerBuild(previous.record))
		refuse(`Plan '${record.planId}' was written by a newer build.`);
	if (previous?.closed) refuse(`Plan '${record.planId}' is closed and cannot be revised.`);
	if (record.version !== expected)
		refuse(`Plan '${record.planId}' version ${record.version} does not follow ${expected - 1}.`);
	if (!planTopologicalOrder(record.nodes).acyclic)
		refuse(`Plan '${record.planId}' version ${record.version} has a cycle.`);
	if (!previous) makeRoom(plans);
	const retired = [...(previous?.retired ?? [])];
	const nodes: Record<string, PlanNodeRuntime> = {};
	for (const spec of record.nodes) {
		const prior = previous?.nodes[spec.id];
		if (prior && spec.since === prior.since) {
			nodes[spec.id] = prior;
			continue;
		}
		if (prior?.release && !prior.settled)
			retire(retired, { nodeId: spec.id, taskId: prior.release.taskId, reason: "superseded" });
		nodes[spec.id] = { since: spec.since };
	}
	for (const [nodeId, prior] of Object.entries(previous?.nodes ?? {})) {
		if (nodes[nodeId] || !prior.release || prior.settled) continue;
		retire(retired, { nodeId, taskId: prior.release.taskId, reason: "removed" });
	}
	plans[record.planId] = { record, nodes, retired };
}

/**
 * Applies one `plan.*` event to the (already copied and tracked) plans map. `tasks` is read to bind a release and a
 * settlement to the exact task and outcome they name.
 */
export function reducePlanEvent(
	plans: Record<string, PlanRuntimeState>,
	tasks: Readonly<Record<string, TaskRuntimeState>>,
	event: OrchestrationEvent,
): void {
	const at = event.occurredAt;
	switch (event.type) {
		case "plan.recorded":
			recordPlan(plans, event);
			return;
		case "plan.node_released": {
			const payload = planNodeReleasedFromValue(event.payload, event.type);
			const found = activePlan(plans, payload.planId, event);
			if (!found) return;
			const { runtime } = nodeOf(found.plan, found.record, payload.nodeId, event.type);
			if (runtime.since !== payload.version)
				refuse(`Step '${payload.nodeId}' is released for a version it does not run.`);
			if (runtime.release) refuse(`Step '${payload.nodeId}' version ${payload.version} was released twice.`);
			if (!tasks[payload.taskId]) refuse(`Step '${payload.nodeId}' is bound to unknown task '${payload.taskId}'.`);
			const { taskId, placement, exit, version } = payload;
			plans[payload.planId] = withNode(found.plan, payload.nodeId, {
				...runtime,
				release: { version, taskId, placement, exit, releasedAt: at },
			});
			return;
		}
		case "plan.node_settled": {
			const payload = planNodeSettledFromValue(event.payload, event.type);
			const found = activePlan(plans, payload.planId, event);
			if (!found) return;
			const { runtime } = nodeOf(found.plan, found.record, payload.nodeId, event.type);
			const outcome = runtime.release ? tasks[runtime.release.taskId]?.outcome : undefined;
			if (!outcome)
				throw new DurableTaskRuntimeError(`Step '${payload.nodeId}' settled without a recorded outcome.`);
			if (!isOutcomeFromNewerBuild(outcome) && outcome.generation < payload.generation) {
				refuse(`Step '${payload.nodeId}' settled on an outcome its task never recorded.`);
			}
			const { held: _held, ...rest } = runtime;
			plans[payload.planId] = withNode(found.plan, payload.nodeId, {
				...rest,
				settled: { outcomeId: payload.outcomeId, generation: payload.generation, settledAt: at },
			});
			return;
		}
		case "plan.node_held": {
			const payload = planNodeHeldFromValue(event.payload, event.type);
			const found = activePlan(plans, payload.planId, event);
			if (!found) return;
			const { runtime } = nodeOf(found.plan, found.record, payload.nodeId, event.type);
			const { reason, detail, generation } = payload;
			plans[payload.planId] = withNode(found.plan, payload.nodeId, {
				...runtime,
				held: { reason, detail, generation, heldAt: at },
			});
			return;
		}
		case "plan.join_settled": {
			const payload = planJoinSettledFromValue(event.payload, event.type);
			const found = activePlan(plans, payload.planId, event);
			if (!found) return;
			const { spec, runtime } = nodeOf(found.plan, found.record, payload.nodeId, event.type);
			if (spec.kind === "work") refuse(`Step '${payload.nodeId}' is not a join.`);
			plans[payload.planId] = withNode(found.plan, payload.nodeId, {
				...runtime,
				join: {
					outcome: payload.outcome,
					artifact: payload.artifact,
					n: (runtime.join?.n ?? 0) + 1,
					settledAt: at,
				},
			});
			return;
		}
		case "plan.closed": {
			const payload = planClosedFromValue(event.payload, event.type);
			const found = activePlan(plans, payload.planId, event);
			const plan = found?.plan ?? plans[payload.planId];
			if (!plan) return;
			plans[payload.planId] = {
				...plan,
				closed: { status: payload.status, reason: payload.reason, closedAt: at },
			};
			return;
		}
		default:
			refuse(`Event '${event.type}' is not a plan event.`);
	}
}

/** The released node, current or retired, that a task belongs to; the terminal route's code fact. */
export function planNodeOfTask(
	plans: Readonly<Record<string, PlanRuntimeState>>,
	taskId: string,
): { planId: string; nodeId: string; retired: boolean } | undefined {
	for (const [planId, plan] of Object.entries(plans)) {
		for (const [nodeId, runtime] of Object.entries(plan.nodes)) {
			if (runtime.release?.taskId === taskId) return { planId, nodeId, retired: false };
		}
		const retired = plan.retired.find((entry) => entry.taskId === taskId);
		if (retired) return { planId, nodeId: retired.nodeId, retired: true };
	}
	return undefined;
}
