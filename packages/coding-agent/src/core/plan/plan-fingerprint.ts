/**
 * Which plans the executor's observation must look at again, and whether two plan views render the same. A plan's inputs
 * are its runtime and the task and attempt records its released steps read; task-runtime records are replaced, never
 * mutated, and every adopted projection is deep-frozen, so those inputs are compared by reference. A view is compared by
 * value with the one the panel last saw, without serializing it.
 */

import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { currentTaskOf } from "../orchestration/task-successor.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { PlanRuntimeState } from "./plan-graph.ts";
import type { PlanView } from "./plan-view.ts";

/** The plan runtime and the records its view reads beyond it, as they were at the last observation. */
interface PlanInputs {
	readonly plan: PlanRuntimeState;
	readonly records: readonly unknown[];
}

/** Each released step's current task and that task's attempts: the records `planView` reads beyond the plan runtime. */
function recordsOf(projection: TaskRuntimeProjection, plan: PlanRuntimeState): readonly unknown[] {
	return Object.values(plan.nodes).flatMap((runtime) => {
		if (!runtime.release) return [];
		const task = projection.tasks[currentTaskOf(projection, runtime.release.taskId)];
		return [task, ...(task?.attemptIds.map((attemptId) => projection.attempts[attemptId]) ?? [])];
	});
}

function sameReferences(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
}

export class PlanFingerprint {
	private readonly seen = new Map<string, PlanInputs>();

	/** The plan ids whose inputs changed since the last call; the first call returns every plan. */
	changed(projection: TaskRuntimeProjection): ReadonlySet<string> {
		const changed = new Set<string>();
		for (const [planId, plan] of Object.entries(projection.plans)) {
			const records = recordsOf(projection, plan);
			const before = this.seen.get(planId);
			if (before === undefined || before.plan !== plan || !sameReferences(before.records, records))
				changed.add(planId);
			this.seen.set(planId, { plan, records });
		}
		return changed;
	}

	/** Drops a plan that left the projection. */
	forget(planId: string): void {
		this.seen.delete(planId);
	}
}

/**
 * Whether two views render the same. Every field is compared by value, so a change to anything the panel shows (a title,
 * an intent, a placement, a doubt, a closing) is a change, and a view that gains a field is compared on it too.
 */
export function sameVisibleView(a: PlanView, b: PlanView): boolean {
	return sameData(a, b);
}

function sameData(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameData(item, b[i]));
	if (!isPlainRecord(a) || !isPlainRecord(b)) return false;
	return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => sameData(a[key], b[key]));
}
