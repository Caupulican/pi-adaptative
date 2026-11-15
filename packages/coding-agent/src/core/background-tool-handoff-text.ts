/**
 * The first line of a background tool task's handoff stub, the result the model reads in place of the call's output: it
 * says what moved the call (the model's request, the tool because the call waits on outside state, the operator, or the
 * latency clock), so a task the model or the tool started never reads as a timeout.
 */

import type { BackgroundToolCallContext } from "../kernel/index.ts";

export function handoffHeadline(context: BackgroundToolCallContext, taskId: string): string {
	const elapsedMs = Number.isFinite(context.elapsedMs) ? Math.max(0, context.elapsedMs) : 0;
	const seconds = Math.max(1, Math.round(elapsedMs / 1000));
	switch (context.trigger) {
		case "requested":
			return `Tool ${context.toolCall.name} started as session task ${taskId} (background requested).`;
		case "tool":
			return `Tool ${context.toolCall.name} started as session task ${taskId}: moved to the background because ${context.reason}.`;
		case "manual":
			return `Tool ${context.toolCall.name} moved to session task ${taskId} by the operator${elapsedMs >= 1000 ? ` after ${seconds}s` : ""}.`;
		default:
			return `Tool ${context.toolCall.name} exceeded ${seconds}s; running as session task ${taskId}.`;
	}
}
