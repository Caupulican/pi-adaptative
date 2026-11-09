/**
 * The successor relation of an escalated task, as a pure read of the runtime projection. A rung on a completed task places
 * a successor task, and the rung's escalation record names the task it supersedes (`escalations[].supersedesTaskId`); the
 * successor inherits that record. A rung on a failed or blocked task runs as a new attempt of the same task and creates no
 * successor. `currentTaskOf` follows successor links to the task that now carries the work, so a caller that held a
 * superseded task id reaches the live one. A task with no successor is its own current task.
 *
 * The walk visits each task at most once, so a malformed chain ends instead of looping.
 */

import type { TaskRuntimeProjection } from "./task-runtime-state.ts";

/** The task that superseded `taskId` through an escalation rung, or undefined when none did. */
export function successorOf(projection: Pick<TaskRuntimeProjection, "tasks">, taskId: string): string | undefined {
	for (const task of Object.values(projection.tasks)) {
		for (const record of task.escalations ?? []) {
			if (record.supersedesTaskId === taskId && record.taskId !== taskId) return record.taskId;
		}
	}
	return undefined;
}

/** The task that carries the work `taskId` names now: the end of its successor chain (itself when it has none). */
export function currentTaskOf(projection: Pick<TaskRuntimeProjection, "tasks">, taskId: string): string {
	const visited = new Set<string>([taskId]);
	let current = taskId;
	for (;;) {
		const next = successorOf(projection, current);
		if (next === undefined || visited.has(next)) return current;
		visited.add(next);
		current = next;
	}
}
