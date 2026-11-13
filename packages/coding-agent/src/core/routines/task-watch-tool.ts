/**
 * The one routine action a worker runtime holds: arm a watch for its own wait. The tool is installed by the worker's
 * executor with the runtime's admitted identity, so the runtime id never comes from an argument, and the host decides
 * what may be armed (`RoutineSessionController.armForWorker`): a condition a worker's own tools could not check is refused,
 * the watch is one-shot with an end time within a day, and it counts inside the session's bound. When it fires or runs
 * out, the runtime is woken with the event; nothing is polled. The tool lists, reads, changes and deletes nothing, so the
 * routine tool stays on the worker floor.
 */
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../kernel/index.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import { MAX_ROUTINE_PROMPT_CHARS, routineAuthoringSchema } from "./routine-contract.ts";
import { parseRoutineToolInput, type RoutineToolInput, type RoutineToolView } from "./routine-tool.ts";
import { TASK_WATCH_TOOL_NAME } from "./routine-tool-names.ts";
import { watchConditionSchema } from "./watch-contract.ts";

/** What the session's routine runtime does for a worker runtime; the runtime id is the executor's, never the model's. */
export interface TaskWatchPort {
	/** Whether the session holds a routine runtime to arm into; a session without one offers its workers no watch tool. */
	available(): boolean;
	arm(runtimeId: string, input: RoutineToolInput, signal?: AbortSignal): Promise<RoutineToolView>;
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

export function createTaskWatchTool(options: { readonly runtimeId: string; readonly port: TaskWatchPort }): AgentTool {
	return {
		name: TASK_WATCH_TOOL_NAME,
		label: "Task watch",
		neverDefer: true,
		description:
			"Wait on a file, a harness-managed process, a process id or a port without polling: the host checks the condition in code at no model cost and wakes you with the event when it becomes true (once; a condition that already holds when armed is the starting state), or when expiresAt passes without it. Arm it, then end your turn or do other work: you are woken, whether still running (steered) or finished (continued). Do not sleep or loop on the condition. Only these conditions are available to a worker; a command or page check is not.",
		parameters,
		execute: async (_toolCallId, args, signal) => {
			signal?.throwIfAborted();
			const input = args as Static<typeof parameters>;
			try {
				const routine = await options.port.arm(
					options.runtimeId,
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
