/**
 * The one routine action a runtime that holds no `routine` tool keeps: arm a watch for its own wait. Two hold it.
 *
 * A worker runtime: the tool is installed by the worker's executor with the runtime's admitted identity and its lane's
 * scope, so neither comes from an argument. A command or page is checked first as the call the worker's own tools would
 * make, by its own gate (`watchCheckCall`), then `RoutineSessionController.armForWorker` admits it under the worker's scope
 * and the session's authority together.
 *
 * A bot's own session: the tool is the session's routine tool (`SessionRoutines.tool`), and
 * `RoutineSessionController.armForSession` arms the watch for the session itself, as the `routine` tool arms one: its
 * check is admitted by the session's own gate as a sub-call of this call.
 *
 * Either way the watch is one-shot with an end time within a day, inside the session's bound, and every later check runs
 * under the same authority again. When it fires or runs out, the armer is woken with the event; nothing is polled. The tool
 * lists, reads, changes and deletes nothing, so it stays on the worker floor.
 */
import { type Static, Type } from "typebox";
import {
	type AgentTool,
	type AgentToolResult,
	type BeforeToolCallResult,
	readAgentToolPolicyDeniedError,
} from "../../kernel/index.ts";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import type { NestedCallPurpose } from "../tools/nested-tool-call.ts";
import { MAX_ROUTINE_PROMPT_CHARS, routineAuthoringSchema } from "./routine-contract.ts";
import { parseRoutineToolInput, type RoutineToolInput, type RoutineToolView } from "./routine-tool.ts";
import { TASK_WATCH_TOOL_NAME } from "./routine-tool-names.ts";
import { parseWatchCondition, watchConditionSchema } from "./watch-contract.ts";
import {
	type WorkerWatchAuthority,
	type WorkerWatchScope,
	watchCheckCall,
	watchCheckRefusal,
} from "./worker-watch-scope.ts";

/** What the session's routine runtime does for a worker runtime; the runtime id and scope are the executor's, never the model's. */
export interface TaskWatchPort {
	/** Whether the session holds a routine runtime to arm into; a session without one offers its workers no watch tool. */
	available(): boolean;
	arm(worker: WorkerWatchAuthority, input: RoutineToolInput, signal?: AbortSignal): Promise<RoutineToolView>;
}

/** The worker the tool arms for: its runtime id, its lane's scope and its own gate, which judges the call a check would make. */
export interface TaskWatchCaller {
	readonly runtimeId: string;
	readonly scope: WorkerWatchScope;
	/** `purpose` names the watch the call is the check of, for the worker gate's notice. */
	admitCall(
		toolName: string,
		args: unknown,
		signal?: AbortSignal,
		purpose?: NestedCallPurpose,
	): Promise<BeforeToolCallResult | undefined>;
}

/** What arms a watch for a session's own wait: the session's routine owner, which admits the check through the session's gate. */
export interface SessionTaskWatchArmer {
	armForSession(input: RoutineToolInput, toolCallId: string, signal?: AbortSignal): Promise<RoutineToolView>;
}

const parameters = Type.Object(
	{
		routineId: routineAuthoringSchema.properties.routineId,
		prompt: Type.String({
			minLength: 1,
			maxLength: MAX_ROUTINE_PROMPT_CHARS,
			description:
				"Your own plan for when it fires: what you will check or do next. You read it again with the event.",
		}),
		condition: watchConditionSchema,
		expiresAt: Type.Integer({
			minimum: 1,
			description:
				"UTC epoch ms after now and at most 24 hours ahead; if the condition has not become true by then you are woken with what it last saw.",
		}),
	},
	{ additionalProperties: false },
);

type TaskWatchArgs = Static<typeof parameters>;

/** The description, with how the armer is woken: a worker is steered or continued, a session is steered or starts a turn. */
function description(woken: string): string {
	return `Wait on a file, a harness-managed process, a process id, a port, a command or a page without polling: the host checks the condition in code at no model cost and wakes you with the event when it becomes true (once; a condition that already holds when armed is the starting state), or when expiresAt passes without it. A command runs in your working directory and is admitted as your own shell call would be (a page as your own fetch call), at arming and at every check; its output comes back fenced as untrusted data. Arm it, then end your turn or do other work: you are woken, ${woken}. Do not sleep or loop on the condition.`;
}

/** The watch the call asks for, as the routine owner takes it: a one-shot event watch ending at `expiresAt`. */
function watchInput(input: TaskWatchArgs): RoutineToolInput {
	return parseRoutineToolInput({
		routineId: input.routineId,
		prompt: input.prompt,
		schedule: {
			kind: "event",
			source: "watch",
			condition: input.condition,
			stopAfterFirstRun: true,
			expiresAt: input.expiresAt,
		},
	});
}

/** Runs one arming and shapes its outcome: the armed watch, or why it was not armed as an operation outcome. */
async function armed(arm: () => Promise<RoutineToolView>): Promise<AgentToolResult<unknown> & { isError?: boolean }> {
	try {
		const routine = await arm();
		const details = { routineId: routine.routineId, revision: routine.revision, armed: true };
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	} catch (error) {
		// A refused check is this call's policy refusal, read as the check's own call's would be.
		if (readAgentToolPolicyDeniedError(error)) throw error;
		const diagnostic = boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error));
		return {
			content: [{ type: "text", text: `Watch was not armed: ${diagnostic ?? "unavailable"}.` }],
			details: undefined,
			isError: true,
			errorKind: "operation_outcome",
		};
	}
}

export function createTaskWatchTool(options: {
	readonly caller: TaskWatchCaller;
	readonly port: TaskWatchPort;
}): AgentTool {
	const { caller } = options;
	return {
		name: TASK_WATCH_TOOL_NAME,
		label: "Task watch",
		neverDefer: true,
		description: description("whether still running (steered) or finished (continued)"),
		parameters,
		execute: async (_toolCallId, args, signal) => {
			signal?.throwIfAborted();
			const input = args as TaskWatchArgs;
			return armed(async () => {
				// A command or page is first the call this worker's own tools would make: its own gate admits it or the arm stops.
				const call = watchCheckCall(parseWatchCondition(input.condition));
				const purpose = {
					kind: "watch_check",
					watchId: input.routineId,
					parentToolName: TASK_WATCH_TOOL_NAME,
				} as const;
				const refused = call && (await caller.admitCall(call.toolName, call.args, signal, purpose));
				if (refused?.block) throw watchCheckRefusal(input.routineId, refused);
				return options.port.arm({ runtimeId: caller.runtimeId, scope: caller.scope }, watchInput(input), signal);
			});
		},
	};
}

/**
 * The tool of a session that arms watches only for its own wait (a bot's own session). The armer is read at the call,
 * since the session's routine runtime is built once its store is loaded; a session without one arms nothing.
 */
export function createSessionTaskWatchTool(getArmer: () => SessionTaskWatchArmer | undefined): ToolDefinition {
	return defineTool({
		name: TASK_WATCH_TOOL_NAME,
		label: "Task watch",
		neverDefer: true,
		description: description("steered while your turn runs, or in a new turn once it has ended"),
		parameters,
		// One arming at a time, so the session's watch count each arming reads is the one its write finds.
		executionMode: "sequential",
		async execute(toolCallId, input, signal) {
			signal?.throwIfAborted();
			return armed(async () => {
				const armer = getArmer();
				if (!armer) throw new Error("Watches are unavailable in this session");
				return armer.armForSession(watchInput(input), toolCallId, signal);
			});
		},
	}) as ToolDefinition;
}
