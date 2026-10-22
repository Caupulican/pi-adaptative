import { type Static, Type } from "typebox";
import type { BackgroundToolImageRead } from "../background-tool-images.ts";
import type { BackgroundToolTaskRecord, BackgroundToolTaskWait } from "../background-tool-task-controller.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { WaitEndKind, WaitEndReason } from "../util/wait.ts";

const MAX_TASK_ID_CHARS = 128;
const MAX_LISTED_TASKS = 32;
const MAX_WAIT_TIMEOUT_MS = 300_000;

const schema = Type.Object(
	{
		action: Type.String({
			enum: ["list", "wait", "image", "cancel"],
			description: "List once, wait once for a dependency, view a retained image, or cancel. Never poll.",
		}),
		taskId: Type.Optional(
			Type.String({
				maxLength: MAX_TASK_ID_CHARS,
				description: "Task id; required for wait/cancel.",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Integer({
				minimum: 1000,
				maximum: MAX_WAIT_TIMEOUT_MS,
				description: "How long wait may block, in ms; default 300000.",
			}),
		),
		imageIndex: Type.Optional(
			Type.Integer({ minimum: 1, description: "For image: one-based image number (default 1)." }),
		),
	},
	{ additionalProperties: false },
);

type Input = Static<typeof schema>;

export interface ToolTaskDependencies {
	list(): BackgroundToolTaskRecord[];
	/** The caller's signal and bound; the session decides whether an owner steer ends the wait. */
	wait(taskId: string, signal?: AbortSignal, timeoutMs?: number): Promise<BackgroundToolTaskWait>;
	readImage?(taskId: string, imageIndex: number): Promise<BackgroundToolImageRead>;
	cancel(taskId: string): boolean;
}

export interface ToolTaskDetails {
	kind: "list" | "wait" | "image" | "cancel" | "error";
	count?: number;
	taskId?: string;
	status?: BackgroundToolTaskRecord["status"];
	artifactId?: string;
	imageIndex?: number;
	reason?: string;
	/** `wait` only: why the wait returned. A running task's wait ends `steered`, `aborted` or `timed_out`. */
	waitEnd?: WaitEndKind;
	piVerification?: NonNullable<BackgroundToolTaskRecord["piVerification"]>;
}

function validTaskId(value: string | undefined): string | undefined {
	const taskId = value?.trim();
	if (!taskId || taskId.length > MAX_TASK_ID_CHARS) return undefined;
	return taskId;
}

/**
 * The answer for a wait that returned while its task still runs. Each end reads differently: a steer means the wait
 * returned early for the owner's input, never that the bound expired; an abort means the wait itself was cancelled.
 *
 * Telling the model to "continue independent work" is not an answer when the waited task is the only
 * thing in flight — it has no independent work, so it spends a turn saying so. Elapsed time is real
 * information: it distinguishes a task that is progressing from one worth cancelling. It is measured by the
 * controller, on the clock that stamped the task's start.
 */
function runningWaitText(record: BackgroundToolTaskRecord, end: WaitEndReason, runningMs: number): string {
	const seconds = Math.round(runningMs / 1000);
	const handoff = "the terminal handoff wakes the session.";
	if (end.kind === "steered") {
		return `${record.summary}\nWait steered: the owner sent input while this wait ran, so the wait returned early to let it through. The task keeps running (${seconds}s so far); ${handoff}`;
	}
	if (end.kind === "aborted") {
		return `${record.summary}\nWait aborted after the task ran ${seconds}s; the task keeps running and ${handoff}`;
	}
	return `${record.summary}\nStill running after ${seconds}s. Wait again when its result is your next dependency; otherwise continue other work, ${handoff}`;
}

/**
 * A status-only snapshot: one line per task, never a task's output.
 *
 * Listing therefore must not consume terminal delivery. The completion wake-up is what carries a
 * finished task's output, and the controller marks a record observed only when the delivered
 * wake-up inlined it; the notifier in turn delivers only records still unobserved. A list that
 * marked records observed would make the wake-up skip exactly those records, so their output would
 * never reach the model even though the listing never printed it. Delivery is consumed by the
 * wake-up itself and by `wait`, never by a read that shows only status.
 */
function projectList(records: readonly BackgroundToolTaskRecord[]): string {
	if (records.length === 0) return "No background tool tasks in this session.";
	const included = records.slice(-MAX_LISTED_TASKS);
	const omitted = records.length - included.length;
	return [
		...included.map((record) => `${record.taskId}: ${record.status}`),
		...(omitted > 0 ? [`${omitted} older task(s) omitted from this bounded snapshot.`] : []),
		"Status only: a finished task's output still arrives in its completion wake-up, or from wait.",
		"Do not poll. Continue independent work, or call wait once only when a running task is a dependency.",
	].join("\n");
}

export function createToolTaskToolDefinition(deps: ToolTaskDependencies): ToolDefinition<typeof schema> {
	return {
		name: "tool_task",
		label: "tool_task",
		description:
			"List, wait for, view retained images from, or cancel this session's background tool calls. list shows status only; wait blocks until the task ends or timeoutMs (default 300000), never poll. image retrieves one stored image by taskId and imageIndex, resizing large images for display. Cite a completed taskId as goal evidence or task_steps evidence.",
		promptSnippet: "Event-driven background tool control; wait once, never poll.",
		promptGuidelines: [
			"A completion wake-up carries the result; wait once with taskId only for a task it marks output omitted.",
			"list reports status only and never consumes a pending completion; the wake-up still carries the output afterwards.",
			"When a result names retained images, use action=image and its taskId with imageIndex (1-based) to view each image.",
			"Cite the taskId on the matching task_steps step and as goal add_evidence kind=tool uri.",
		],
		parameters: schema,
		foregroundWait: (input) => input.action === "wait",
		async execute(_toolCallId, input: Input, signal) {
			if (input.action === "list") {
				const records = deps.list();
				return {
					content: [{ type: "text" as const, text: projectList(records) }],
					details: { kind: "list" as const, count: records.length },
				};
			}

			const taskId = validTaskId(input.taskId);
			if (!taskId) {
				return {
					content: [{ type: "text" as const, text: `${input.action} requires a valid taskId.` }],
					details: { kind: "error" as const, reason: "invalid_task_id" },
					isError: true,
					errorKind: "tool_failure" as const,
				};
			}

			if (input.action === "image") {
				const imageIndex = input.imageIndex ?? 1;
				const result = await deps.readImage?.(taskId, imageIndex);
				if (!result?.found) {
					return {
						content: [{ type: "text" as const, text: result?.reason ?? "Image retrieval is unavailable." }],
						details: { kind: "error" as const, taskId, imageIndex },
						isError: true,
						errorKind: "operation_outcome" as const,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Image ${imageIndex} from ${taskId}.${result.note ? `\n${result.note}` : ""}`,
						},
						result.image,
					],
					details: { kind: "image" as const, taskId, imageIndex },
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
				const { record, end, runningMs } = await deps.wait(taskId, signal, input.timeoutMs);
				const isError = record.status === "failed" || record.status === "canceled";
				// A pending terminal's first waiter is the authoritative model-facing delivery when the
				// controller suppresses its wake. Delivered records are historical state: replaying a
				// prior pass could clear a newer failure for the same verification identity.
				const verification =
					record.terminalDelivery === "pending" &&
					record.piVerification?.originTaskId === record.taskId &&
					(record.piVerification.status !== "passed" || record.status === "completed")
						? record.piVerification
						: undefined;
				const text =
					record.status === "running" ? runningWaitText(record, end, runningMs) : record.output || record.summary;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						kind: "wait" as const,
						taskId,
						status: record.status,
						waitEnd: end.kind,
						...(record.artifactId ? { artifactId: record.artifactId } : {}),
						...(verification ? { piVerification: { ...verification } } : {}),
					},
					...(isError ? { isError: true, errorKind: "operation_outcome" as const } : {}),
				};
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: reason }],
					details: { kind: "error" as const, taskId, reason },
					isError: true,
					errorKind: "tool_failure" as const,
				};
			}
		},
	};
}
