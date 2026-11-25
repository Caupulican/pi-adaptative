/**
 * A background tool task's handoff stub, the result the model reads in place of the call's output. Its first line says
 * what moved the call (the model's request, the tool because the call waits on outside state, the operator, or the
 * latency clock), so a task the model or the tool started never reads as a timeout; the next says how long the task may
 * run and how to stop it sooner, and the last how its result arrives.
 */

import type { BackgroundToolCallContext } from "../kernel/index.ts";

export const BACKGROUND_TOOL_COMPLETION_TYPE = "background-tool-completion";

export function handoffStubText(context: BackgroundToolCallContext, taskId: string, runtimeBoundMs: number): string {
	return [
		handoffHeadline(context, taskId),
		`The task is stopped if it still runs after ${runtimeBound(runtimeBoundMs)}; stop it sooner with tool_task action=cancel taskId=${taskId}.`,
		"Continue independent work or end the turn. This task wakes the session on completion; do not arm a watch for its task ID. Use tool_task action=wait only for a synchronous dependency or omitted output; never poll.",
	].join("\n");
}

/** The task's remaining lifetime in whole minutes, or hours when it is a whole number of them. */
function runtimeBound(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
	return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function handoffHeadline(context: BackgroundToolCallContext, taskId: string): string {
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
