/**
 * What a plan review checks: the worker results under a verify step's members, each once, in record order. A member the harness
 * settled in code contributes the results its join counted, recursively. The anchor of a review run is its first subject. Pure
 * code over the projection.
 */

import { isOutcomeFromNewerBuild, type Outcome } from "../delegation/worker-outcome-contract.ts";
import {
	isCodeSettledJoin,
	isPlanFromNewerBuild,
	type PlanNodeSpec,
	type PlanRecord,
	type PlanRuntimeState,
} from "../plan/plan-graph.ts";
import { planNodeOfTask } from "../plan/plan-reducer.ts";
import { selectedTaskAttempt } from "./attempt-ordering.ts";
import type { TaskRuntimeProjection } from "./task-runtime-state.ts";
import { currentTaskOf } from "./task-successor.ts";

/** One worker result a plan review checks: the step that ran it, and the task and attempt it settled with. */
export interface ReviewSubject {
	readonly nodeId: string;
	readonly taskId: string;
	readonly attemptId: string;
}

type ReviewProjection = Pick<TaskRuntimeProjection, "plans" | "tasks" | "attempts">;

/** The outcome a plan step settled with: its join's, or its released task's when the step settled from a worker. */
export function planStepSettledOutcome(
	projection: ReviewProjection,
	runtime: PlanRuntimeState["nodes"][string] | undefined,
): Outcome | undefined {
	const joined = runtime?.join?.outcome;
	if (joined && !isOutcomeFromNewerBuild(joined)) return joined;
	if (!runtime?.settled || !runtime.release) return undefined;
	const outcome = projection.tasks[currentTaskOf(projection, runtime.release.taskId)]?.outcome;
	return outcome && !isOutcomeFromNewerBuild(outcome) ? outcome : undefined;
}

/** The worker results a verify step checks, in record order, each once (a code-settled member contributes what its join counted). */
export function planReviewSubjects(
	projection: ReviewProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	node: PlanNodeSpec,
): readonly ReviewSubject[] {
	const found = new Map<string, ReviewSubject>();
	const visit = (nodeId: string): void => {
		const spec = record.nodes.find((candidate) => candidate.id === nodeId);
		const runtime = plan.nodes[nodeId];
		if (!spec || !runtime) return;
		if (!isCodeSettledJoin(spec.kind)) {
			if (!runtime.release || found.has(nodeId)) return;
			const taskId = currentTaskOf(projection, runtime.release.taskId);
			const attempt = selectedTaskAttempt(projection, taskId);
			if (attempt) found.set(nodeId, { nodeId, taskId, attemptId: attempt.attemptId });
			return;
		}
		const counted = new Set(planStepSettledOutcome(projection, runtime)?.children ?? []);
		for (const member of spec.join?.members ?? []) {
			const memberOutcome = planStepSettledOutcome(projection, plan.nodes[member]);
			if (memberOutcome && counted.has(memberOutcome.outcomeId)) visit(member);
		}
	};
	for (const member of node.join?.members ?? []) visit(member);
	const order = new Map(record.nodes.map((candidate, index) => [candidate.id, index]));
	return [...found.values()].sort((left, right) => (order.get(left.nodeId) ?? 0) - (order.get(right.nodeId) ?? 0));
}

/**
 * The anchor of the verify step that released `taskId` (its first subject); undefined for any other task, and for a task the plan
 * retired: that task is being cancelled, and the current record may name other subjects than the retired review was shown.
 */
export function planReviewAnchorOfTask(
	projection: ReviewProjection,
	taskId: string,
): { taskId: string; attemptId: string } | undefined {
	const located = planNodeOfTask(projection, taskId);
	if (!located || located.retired) return undefined;
	const plan = projection.plans[located.planId];
	if (!plan || isPlanFromNewerBuild(plan.record)) return undefined;
	const node = plan.record.nodes.find((candidate) => candidate.id === located.nodeId);
	if (node?.kind !== "verify") return undefined;
	const [anchor] = planReviewSubjects(projection, plan, plan.record, node);
	return anchor ? { taskId: anchor.taskId, attemptId: anchor.attemptId } : undefined;
}
