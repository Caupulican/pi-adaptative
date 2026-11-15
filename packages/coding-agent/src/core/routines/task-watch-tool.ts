/**
 * The arming and cancelling of a watch for the own wait of a runtime that holds no `watch` tool. Two hold it, and both arm
 * into the session's own watches (`core/watches/session-watch-service.ts`), as the `watch` tool does.
 *
 * A worker runtime: the tool is installed by the worker's executor with the runtime's admitted identity and its lane's
 * scope, so neither comes from an argument. A command or page is checked first as the call the worker's own tools would
 * make, by its own gate (`watchCheckCall`), then the session's watch service admits it under the worker's scope and the
 * session's authority together, in one of the worker's slots.
 *
 * A bot's own session: the tool is the session's own (`SessionRoutines.tools`), and the watch is armed for the session
 * itself, stamped with the authority of the turn it runs in: its check is admitted by the session's own gate as a sub-call
 * of this call.
 *
 * Either way the watch is one-shot with an end time within a day, inside the session's bound, and every later check runs
 * under the same authority again. When it fires or runs out, the armer is woken with the event; nothing is polled. A watch
 * the armer no longer waits on is cancelled by it (`cancel`): a worker cancels only a watch its own runtime armed, a bot's
 * session only one it armed itself, at its turn's authority or below. A watch is named by `watchId`; `routineId`, the name
 * earlier builds gave it, is still read, so a cancel reaches a routine watch an earlier build armed. The tool lists, reads
 * and changes nothing else, so it stays on the worker floor.
 */
import { StringEnum } from "@caupulican/pi-ai";
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
import type { SessionWatchView } from "../watches/session-watch-service.ts";
import type { SessionWatchPort } from "../watches/watch-tool.ts";
import { MAX_ROUTINE_ID_CHARS, MAX_ROUTINE_ID_PATTERN, MAX_ROUTINE_PROMPT_CHARS } from "./routine-contract.ts";
import { TASK_WATCH_TOOL_NAME } from "./routine-tool-names.ts";
import { parseWatchCondition, type WatchCondition, watchConditionSchema } from "./watch-contract.ts";
import {
	type WorkerWatchAuthority,
	type WorkerWatchScope,
	watchCheckCall,
	watchCheckRefusal,
} from "./worker-watch-scope.ts";

/** One watch a `task_watch` call arms: what to wait on, the plan and the end time. */
export interface TaskWatchRequest {
	readonly watchId: string;
	readonly onFire: string;
	readonly condition: WatchCondition;
	readonly expiresAt: number;
}

/** What the session's watch service does for a worker runtime; the runtime id and scope are the executor's, never the model's. */
export interface TaskWatchPort {
	/** Whether the session holds a watch service to arm into; a session without one offers its workers no watch tool. */
	available(): boolean;
	arm(worker: WorkerWatchAuthority, watch: TaskWatchRequest, signal?: AbortSignal): Promise<SessionWatchView>;
	/**
	 * Cancels a watch the worker's runtime armed: one in the session's ledger, or a routine watch an earlier build armed
	 * for it; one another runtime or the session armed is absent to it.
	 */
	cancel(worker: WorkerWatchAuthority, watchId: string, signal?: AbortSignal): Promise<void>;
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

const watchIdSchema = (description: string) =>
	Type.Optional(
		Type.String({ minLength: 1, maxLength: MAX_ROUTINE_ID_CHARS, pattern: MAX_ROUTINE_ID_PATTERN, description }),
	);

const parameters = Type.Object(
	{
		action: StringEnum(["arm", "cancel"] as const, {
			description:
				"arm: wait on a condition (watchId, prompt, condition and expiresAt). cancel: stop a watch you armed (watchId only).",
		}),
		watchId: watchIdSchema("Your name for the watch; arm and cancel take it."),
		routineId: watchIdSchema(
			"The same name, as earlier builds called it; give watchId or routineId, not both. A watch armed before this build is named by it.",
		),
		prompt: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_ROUTINE_PROMPT_CHARS,
				description:
					"arm: your own plan for when it fires: what you will check or do next. You read it again with the event.",
			}),
		),
		condition: Type.Optional(watchConditionSchema),
		expiresAt: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"arm: UTC epoch ms after now and at most 24 hours ahead; if the condition has not become true by then you are woken with what it last saw.",
			}),
		),
	},
	{ additionalProperties: false },
);

type TaskWatchArgs = Static<typeof parameters>;

/** The description, with how the armer is woken: a worker is steered or continued, a session is steered or starts a turn. */
function description(woken: string): string {
	return `Wait on a file, a harness-managed process, a process id, a port, a command or a page without polling: the host checks the condition in code at no model cost and wakes you with the event when it becomes true (once; a condition that already holds when armed is the starting state), or when expiresAt passes without it. A command runs in your working directory and is admitted as your own shell call would be (a page as your own fetch call), at arming and at every check; its output comes back fenced as untrusted data. Arm it, then end your turn or do other work: you are woken, ${woken}. Do not sleep or loop on the condition. Cancel a watch you armed once you no longer wait on it.`;
}

/** The watch a call names: `watchId`, or `routineId` as earlier builds called it, exactly one of them. */
function watchIdOf(input: TaskWatchArgs): string {
	if ((input.watchId === undefined) === (input.routineId === undefined))
		throw new Error("Name the watch with watchId (or routineId, as earlier builds called it), not both.");
	return input.watchId ?? (input.routineId as string);
}

/** The watch an arm call asks for, all of it: its name, the plan read back when it wakes the armer, the condition and the end time. */
function watchRequest(input: TaskWatchArgs): TaskWatchRequest {
	if (input.action !== "arm") throw new Error("Only an arm call watches a condition.");
	if (input.prompt === undefined || input.condition === undefined || input.expiresAt === undefined)
		throw new Error("An arm call needs prompt, condition and expiresAt.");
	const onFire = input.prompt.trim();
	if (onFire.length === 0) throw new Error("prompt is empty");
	return {
		watchId: watchIdOf(input),
		onFire,
		condition: parseWatchCondition(input.condition),
		expiresAt: input.expiresAt,
	};
}

/** Runs one cancel and shapes its outcome: the watch cancelled, or why it was not as an operation outcome. */
async function cancelled(
	input: TaskWatchArgs,
	cancel: (watchId: string) => Promise<void>,
): Promise<AgentToolResult<unknown> & { isError?: boolean }> {
	try {
		if (input.prompt !== undefined || input.condition !== undefined || input.expiresAt !== undefined)
			throw new Error("A cancel call names only the watch.");
		const watchId = watchIdOf(input);
		await cancel(watchId);
		const details = { watchId, cancelled: true };
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	} catch (error) {
		const diagnostic = boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error));
		return {
			content: [{ type: "text", text: `Watch was not cancelled: ${diagnostic ?? "unavailable"}.` }],
			details: undefined,
			isError: true,
			errorKind: "operation_outcome",
		};
	}
}

/** Runs one arming and shapes its outcome: the armed watch, or why it was not armed as an operation outcome. */
async function armed(arm: () => Promise<SessionWatchView>): Promise<AgentToolResult<unknown> & { isError?: boolean }> {
	try {
		const watch = await arm();
		const details = { watchId: watch.watchId, expiresAt: watch.expiresAt, armed: true };
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
			const worker = { runtimeId: caller.runtimeId, scope: caller.scope };
			if (input.action === "cancel")
				return cancelled(input, (watchId) => options.port.cancel(worker, watchId, signal));
			return armed(async () => {
				const request = watchRequest(input);
				// A command or page is first the call this worker's own tools would make: its own gate admits it or the arm stops.
				const call = watchCheckCall(request.condition);
				const purpose = {
					kind: "watch_check",
					watchId: request.watchId,
					parentToolName: TASK_WATCH_TOOL_NAME,
				} as const;
				const refused = call && (await caller.admitCall(call.toolName, call.args, signal, purpose));
				if (refused?.block) throw watchCheckRefusal(request.watchId, refused);
				return options.port.arm(worker, request, signal);
			});
		},
	};
}

/**
 * The tool of a session that arms watches only for its own wait (a bot's own session). The port is read at the call,
 * since the session's watch service is built once its store is loaded; a session without one arms nothing.
 */
export function createSessionTaskWatchTool(getPort: () => SessionWatchPort | undefined): ToolDefinition {
	const port = (): SessionWatchPort => {
		const current = getPort();
		if (!current) throw new Error("Watches are unavailable in this session");
		return current;
	};
	return defineTool({
		name: TASK_WATCH_TOOL_NAME,
		label: "Task watch",
		neverDefer: true,
		description: description("steered while your turn runs, or in a new turn once it has ended"),
		parameters,
		async execute(toolCallId, input, signal) {
			signal?.throwIfAborted();
			if (input.action === "cancel") return cancelled(input, (watchId) => port().cancelOwn(watchId, signal));
			return armed(() =>
				port().arm({ ...watchRequest(input), parentToolName: TASK_WATCH_TOOL_NAME }, toolCallId, signal),
			);
		},
	}) as ToolDefinition;
}
