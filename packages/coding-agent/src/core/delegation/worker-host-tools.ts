/**
 * The tools the host installs on a worker attempt with the attempt's admitted identity, outside the granted tool surface: the
 * task's event control and the watch the runtime arms for its own wait. Neither takes an identity from the model, neither
 * needs a grant, and neither widens what the worker can do.
 */
import type { AgentTool } from "../../kernel/index.ts";
import { TASK_EVENTS_TOOL_NAME } from "../events/host-event-tool-names.ts";
import { createTaskEventsTool } from "../events/task-events-tool.ts";
import { TASK_WATCH_TOOL_NAME } from "../routines/routine-tool-names.ts";
import { createTaskWatchTool, type TaskWatchPort } from "../routines/task-watch-tool.ts";
import type { WorkerAttemptExecutorOptions } from "./worker-attempt-executor.ts";
import { WorkerCompletionProtocolError } from "./worker-provider-turn-protocol.ts";

/** The names of the host-installed tools: a call to one is the host's own and skips the grant gate. */
export const WORKER_HOST_TOOL_NAMES: ReadonlySet<string> = new Set([TASK_EVENTS_TOOL_NAME, TASK_WATCH_TOOL_NAME]);

export function createWorkerHostTools(
	options: Pick<
		WorkerAttemptExecutorOptions,
		"agentControl" | "agentId" | "conversation" | "durableHandle" | "parentSessionId" | "signal" | "toolSurface"
	> & { readonly watches?: TaskWatchPort },
	admissionClosed: () => boolean,
): AgentTool[] {
	const withEventControl = <T>(operation: () => T): T => {
		options.signal?.throwIfAborted();
		options.toolSurface.assertHealthy();
		if (admissionClosed()) throw new WorkerCompletionProtocolError("Worker event control admission is closed.");
		return options.conversation.withHostEventControl(options.parentSessionId, operation);
	};
	const taskEvents = createTaskEventsTool({
		callerAgentId: options.agentId,
		taskId: options.durableHandle.taskId,
		execution: {
			attemptId: options.durableHandle.attemptId,
			leaseId: options.durableHandle.leaseId,
			fencingToken: options.durableHandle.fencingToken,
		},
		port: {
			readHostEvents: (query, scope) => withEventControl(() => options.agentControl.readHostEvents(query, scope)),
			changeHostEventSubscriptions: (input, scope) =>
				withEventControl(() => options.agentControl.changeHostEventSubscriptions(input, scope)),
		},
	});
	return options.watches?.available()
		? [taskEvents, createTaskWatchTool({ runtimeId: options.agentId, port: options.watches })]
		: [taskEvents];
}
