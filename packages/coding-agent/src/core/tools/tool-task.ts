import { type Static, Type } from "typebox";
import type { BackgroundToolTaskRecord } from "../background-tool-task-controller.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const MAX_TASK_ID_CHARS = 128;
const MAX_LISTED_TASKS = 32;

const schema = Type.Object(
	{
		action: Type.String({
			enum: ["list", "wait", "cancel"],
			description: "List once, wait once for a dependency, or cancel. Never poll.",
		}),
		taskId: Type.Optional(
			Type.String({
				maxLength: MAX_TASK_ID_CHARS,
				description: "Task id; required for wait/cancel.",
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
			"List, wait for, or cancel this session's background tool calls. Continue other work; wait is event-driven, never poll. Cite a completed taskId as goal evidence or task_steps evidence.",
		promptSnippet: "Event-driven background tool control; wait once, never poll.",
		promptGuidelines: [
			"Handoff is not completion. Need the result: wait once with taskId.",
			"Cite the taskId on the matching task_steps step and as goal add_evidence kind=tool uri.",
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
					isError: true,
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
				const isError = record.status !== "completed";
				return {
					content: [{ type: "text" as const, text: record.output || record.summary }],
					details: {
						kind: "wait" as const,
						taskId,
						status: record.status,
						...(record.artifactId ? { artifactId: record.artifactId } : {}),
					},
					...(isError ? { isError: true } : {}),
				};
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: reason }],
					details: { kind: "error" as const, taskId, reason },
					isError: true,
				};
			}
		},
	};
}
