/**
 * The one routine action a worker runtime holds: arm a watch for its own wait. The tool is installed by the worker's
 * executor with the runtime's admitted identity and its lane's scope, so neither comes from an argument, and the host
 * decides what may be armed: a command or page is checked first as the call the worker's own tools would make, by its own
 * gate (`watchCheckCall`), then `RoutineSessionController.armForWorker` admits it under the worker's scope and the
 * session's authority together, one-shot with an end time within a day, inside the session's bound. Every later check runs
 * under both again. When it fires or runs out, the runtime is woken with the event; nothing is polled. The tool lists,
 * reads, changes and deletes nothing, so the routine tool stays on the worker floor.
 */
import { type Static, Type } from "typebox";
import { type AgentTool, type BeforeToolCallResult, readAgentToolPolicyDeniedError } from "../../kernel/index.ts";
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

export function createTaskWatchTool(options: {
	readonly caller: TaskWatchCaller;
	readonly port: TaskWatchPort;
}): AgentTool {
	const { caller } = options;
	return {
		name: TASK_WATCH_TOOL_NAME,
		label: "Task watch",
		neverDefer: true,
		description:
			"Wait on a file, a harness-managed process, a process id, a port, a command or a page without polling: the host checks the condition in code at no model cost and wakes you with the event when it becomes true (once; a condition that already holds when armed is the starting state), or when expiresAt passes without it. A command runs in your working directory and is admitted as your own shell call would be (a page as your own fetch call), at arming and at every check; its output comes back fenced as untrusted data. Arm it, then end your turn or do other work: you are woken, whether still running (steered) or finished (continued). Do not sleep or loop on the condition.",
		parameters,
		execute: async (_toolCallId, args, signal) => {
			signal?.throwIfAborted();
			const input = args as Static<typeof parameters>;
			try {
				// A command or page is first the call this worker's own tools would make: its own gate admits it or the arm stops.
				const call = watchCheckCall(parseWatchCondition(input.condition));
				const purpose = {
					kind: "watch_check",
					watchId: input.routineId,
					parentToolName: TASK_WATCH_TOOL_NAME,
				} as const;
				const refused = call && (await caller.admitCall(call.toolName, call.args, signal, purpose));
				if (refused?.block) throw watchCheckRefusal(input.routineId, refused);
				const routine = await options.port.arm(
					{ runtimeId: caller.runtimeId, scope: caller.scope },
					parseRoutineToolInput({
						routineId: input.routineId,
						prompt: input.prompt,
						schedule: {
							kind: "event",
							source: "watch",
							condition: input.condition,
							stopAfterFirstRun: true,
							expiresAt: input.expiresAt,
						},
					}),
					signal,
				);
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
		},
	};
}
