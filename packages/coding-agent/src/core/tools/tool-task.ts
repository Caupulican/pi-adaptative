import { type Static, Type } from "typebox";
import type { BackgroundToolTaskRecord } from "../background-tool-task-controller.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const MAX_TASK_ID_CHARS = 128;
const MAX_LISTED_TASKS = 32;

const schema = Type.Object(
	{
		action: Type.String({
			enum: ["list", "wait", "cancel"],
			description:
				'Use "list" for one bounded snapshot, "wait" once when a task result is a dependency, or "cancel" to abort one session task. Never poll.',
		}),
		taskId: Type.Optional(
			Type.String({
				maxLength: MAX_TASK_ID_CHARS,
				description: "Session-local task id returned by a backgrounded tool call; required for wait/cancel.",
			}),
		),
	},
	{ additionalProperties: false },
);

type Input = Static<typeof schema>;

export interface ToolTaskDependencies {
	list(): BackgroundToolTaskRecord[];
	wait(taskId: string, signal?: AbortSignal): Promise<BackgroundToolTaskRecord>;
	cancel(taskId: string): boolean;
}

export interface ToolTaskDetails {
	kind: "list" | "wait" | "cancel" | "error";
	count?: number;
	taskId?: string;
	status?: BackgroundToolTaskRecord["status"];
	artifactId?: string;
	reason?: string;
}

function validTaskId(value: string | undefined): string | undefined {
	const taskId = value?.trim();
	if (!taskId || taskId.length > MAX_TASK_ID_CHARS) return undefined;
	return taskId;
}

function listText(records: readonly BackgroundToolTaskRecord[]): string {
	if (records.length === 0) return "No background tool tasks in this session.";
	const included = records.slice(-MAX_LISTED_TASKS);
	const omitted = records.length - included.length;
	return [
		...included.map((record) => `${record.taskId}: ${record.status} — ${record.summary}`),
		...(omitted > 0 ? [`${omitted} older task(s) omitted from this bounded snapshot.`] : []),
		"Do not poll. Continue independent work, or call wait once only when a running task is a dependency.",
	].join("\n");
}

export function createToolTaskToolDefinition(deps: ToolTaskDependencies): ToolDefinition<typeof schema> {
	return {
		name: "tool_task",
		label: "tool_task",
		description:
			"List, wait for, or cancel tool calls automatically moved into this session's background after 15 seconds or by a manual handoff. Continue independent work when possible. If a result is required, call wait once; completion is event-driven, so never poll.",
		promptSnippet: "Wait for or cancel session-owned background tool calls without polling.",
		promptGuidelines: [
			"A slow tool result names its session task. Continue independent work; if that result blocks progress, call tool_task with action=wait exactly once.",
			"Background tool completion is event-driven and wakes this session. Never poll tool_task list or repeatedly wait.",
		],
		parameters: schema,
		async execute(_toolCallId, input: Input, signal) {
			if (input.action === "list") {
				const records = deps.list();
				return {
					content: [{ type: "text" as const, text: listText(records) }],
					details: { kind: "list" as const, count: records.length },
				};
			}

			const taskId = validTaskId(input.taskId);
			if (!taskId) {
				return {
					content: [{ type: "text" as const, text: `${input.action} requires a valid taskId.` }],
					details: { kind: "error" as const, reason: "invalid_task_id" },
				};
			}

			if (input.action === "cancel") {
				const canceled = deps.cancel(taskId);
				return {
					content: [
						{
							type: "text" as const,
							text: canceled
								? `Cancellation requested for ${taskId}.`
								: `No running background tool task named ${taskId}.`,
						},
					],
					details: {
						kind: "cancel" as const,
						taskId,
						...(canceled ? {} : { reason: "not_running" }),
					},
				};
			}

			try {
				const record = await deps.wait(taskId, signal);
				return {
					content: [{ type: "text" as const, text: record.output || record.summary }],
					details: {
						kind: "wait" as const,
						taskId,
						status: record.status,
						...(record.artifactId ? { artifactId: record.artifactId } : {}),
					},
				};
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: reason }],
					details: { kind: "error" as const, taskId, reason },
				};
			}
		},
	};
}
