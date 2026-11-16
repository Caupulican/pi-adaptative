/**
 * The tools the host installs on a worker attempt with the attempt's admitted identity, outside the granted tool surface: the
 * task's event control and the watch the runtime arms for its own wait. Neither takes an identity from the model, neither
 * needs a grant, and neither widens what the worker can do: a watch's check is admitted by the lane's own gate and kept
 * inside the lane's scope (`toolSurface.shellFacts`). Beside them the host follows the worker's own calls and arms its
 * waits on what they start outside it (a push's CI, a dispatched run), as it does for the session.
 */
import { createHash } from "node:crypto";
import type { AgentTool } from "../../kernel/index.ts";
import { TASK_EVENTS_TOOL_NAME } from "../events/host-event-tool-names.ts";
import { createTaskEventsTool } from "../events/task-events-tool.ts";
import { TASK_WATCH_TOOL_NAME } from "../routines/routine-tool-names.ts";
import { createTaskWatchTool, type TaskWatchPort } from "../routines/task-watch-tool.ts";
import type { NestedCallPurpose } from "../tools/nested-tool-call.ts";
import { WatchAutoArm } from "../watches/watch-auto-arm.ts";
import type { WorkerAttemptExecutorOptions } from "./worker-attempt-executor.ts";
import { WorkerCompletionProtocolError } from "./worker-provider-turn-protocol.ts";

/** The names of the host-installed tools: a call to one is the host's own and skips the grant gate. */
export const WORKER_HOST_TOOL_NAMES: ReadonlySet<string> = new Set([TASK_EVENTS_TOOL_NAME, TASK_WATCH_TOOL_NAME]);

/** The host-installed tools, and the release of what the host follows for the attempt (its own calls), once it settled. */
export interface WorkerHostTools {
	readonly tools: AgentTool[];
	readonly release: () => void;
}

export function createWorkerHostTools(
	options: Pick<
		WorkerAttemptExecutorOptions,
		| "agentControl"
		| "agentId"
		| "conversation"
		| "cwd"
		| "durableHandle"
		| "parentSessionId"
		| "signal"
		| "toolSurface"
	> & { readonly watches?: TaskWatchPort },
	admissionClosed: () => boolean,
): WorkerHostTools {
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
	if (!options.watches?.available()) return { tools: [taskEvents], release: () => {} };
	const { toolSurface } = options;
	const caller = {
		runtimeId: options.agentId,
		scope: toolSurface.shellFacts,
		admitCall: (toolName: string, args: unknown, signal?: AbortSignal, purpose?: NestedCallPurpose) => {
			options.signal?.throwIfAborted();
			if (admissionClosed()) throw new WorkerCompletionProtocolError("Worker watch admission is closed.");
			return toolSurface.admitHostCall(toolName, args, signal, purpose);
		},
	};
	return {
		tools: [taskEvents, createTaskWatchTool({ caller, port: options.watches })],
		release: followOwnCalls(options, options.watches),
	};
}

/**
 * Arms the worker's own waits on what its calls start outside it, as the session's are armed (`watch-auto-arm.ts`): a push
 * from its checkout arms a `ci` watch on what it pushed, a dispatched run or a release a `github_run` or `release` watch,
 * in the worker's own slots, each waking the worker. The worker is told what was armed, and what was not and why. A call
 * is read when its body ends, from its own result. Returns the end of the following, which the attempt calls once settled.
 */
function followOwnCalls(
	options: Pick<WorkerAttemptExecutorOptions, "agentId" | "cwd" | "signal" | "toolSurface">,
	watches: TaskWatchPort,
): () => void {
	const worker = { runtimeId: options.agentId, scope: options.toolSurface.shellFacts };
	let notes = 0;
	const note = (text: string) =>
		watches.noteWorker(
			worker,
			text,
			`watch-auto-arm:${options.agentId}:${++notes}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
		);
	const auto = new WatchAutoArm({
		port: () => watches.autoArm(worker),
		cwd: () => options.cwd,
		note: async (text) => note(text),
		failed: (error) =>
			note(
				`The host could not arm watches for what one of your calls started: ${error instanceof Error ? error.message : String(error)}. Wait on it yourself if your work needs its result.`,
			),
		disposed: () => options.signal?.aborted === true,
	});
	return options.toolSurface.onToolExecution({
		start: (toolCallId, toolName, args) => auto.noteStart(toolCallId, toolName, args),
		end: (toolCallId, result) => auto.noteFinished(toolCallId, result),
	});
}
