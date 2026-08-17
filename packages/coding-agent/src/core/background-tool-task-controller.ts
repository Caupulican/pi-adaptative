import type {
	BackgroundToolCallCompletion,
	BackgroundToolCallContext,
	BackgroundToolCallHandoff,
} from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Usage } from "@caupulican/pi-ai";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import { formatArtifactNotice, packToolOutput } from "./context/tool-output-packer.ts";
import { hasOnlyKeys, isPlainRecord } from "./util/value-guards.ts";

export const DEFAULT_BACKGROUND_TOOL_CALL_AFTER_MS = 15_000;
export const BACKGROUND_TOOL_TASK_CUSTOM_TYPE = "background_tool_task";

const MAX_RETAINED_TERMINAL_TASKS = 64;
const MAX_INLINE_OUTPUT_BYTES = 32 * 1024;
const MAX_INLINE_OUTPUT_LINES = 400;
const MAX_SUMMARY_CHARS = 200;
const MAX_TERMINAL_HANDOFF_RECORDS = 8;
const TASK_ID_PATTERN = /^tool-task-([1-9]\d*)$/;
const RECORD_KEYS = [
	"sessionId",
	"taskId",
	"toolCallId",
	"toolName",
	"status",
	"startedAt",
	"completedAt",
	"elapsedBeforeHandoffMs",
	"summary",
	"output",
	"artifactId",
	"usage",
	"cancellationRequested",
] as const;

export type BackgroundToolTaskStatus = "running" | "completed" | "failed" | "canceled";

export type BackgroundToolTaskRef = Pick<BackgroundToolTaskRecord, "taskId" | "toolCallId" | "status">;

/** Match a goal/task_steps evidence uri to a session background tool task by task id or toolCallId. */
export function findBackgroundToolTask<T extends BackgroundToolTaskRef>(
	records: readonly T[],
	uri: string,
): T | undefined {
	const id = uri.trim();
	if (!id) return undefined;
	return records.find((record) => record.taskId === id || record.toolCallId === id);
}

/** True only when the cited background task finished successfully. Undefined when no task matches. */
export function isCompletedBackgroundToolEvidence(
	records: readonly BackgroundToolTaskRef[],
	uri: string,
): boolean | undefined {
	const task = findBackgroundToolTask(records, uri);
	if (!task) return undefined;
	return task.status === "completed";
}

export function collectCitedRunningToolTaskIds(args: {
	records: readonly BackgroundToolTaskRef[];
	uris: readonly string[];
}): string[] {
	const running = new Set<string>();
	for (const uri of args.uris) {
		const task = findBackgroundToolTask(args.records, uri);
		if (task?.status === "running") running.add(task.taskId);
	}
	return [...running];
}

export interface BackgroundToolTaskRecord {
	sessionId: string;
	taskId: string;
	toolCallId: string;
	toolName: string;
	status: BackgroundToolTaskStatus;
	startedAt: string;
	completedAt?: string;
	elapsedBeforeHandoffMs: number;
	summary: string;
	output: string;
	artifactId?: string;
	usage?: Usage;
	cancellationRequested?: boolean;
}

export interface BackgroundToolTaskLiveView {
	taskId: string;
	toolCallId: string;
	toolName: string;
	description: string;
}

export interface BackgroundToolTerminalMessage {
	customType: "background-tool-completion";
	content: string;
	display: true;
	details: {
		records: Array<{
			taskId: string;
			status: BackgroundToolTaskStatus;
			toolName: string;
			artifactId?: string;
		}>;
	};
}

export interface BackgroundToolTaskControllerDeps {
	getSessionId(): string;
	/** Current session followed by the authoritative fork ancestry whose branch records remain visible. */
	getSessionLineageIds?(): readonly string[];
	getArtifactStore(): ArtifactStore | undefined;
	/** Durable task records on the active branch, newest first, without rebuilding full model context. */
	loadPersistedRecordsNewestFirst?(): readonly unknown[];
	persist(record: BackgroundToolTaskRecord): void;
	notifyTerminal(records: readonly BackgroundToolTaskRecord[], options: { wakeParent: boolean }): Promise<void> | void;
	onLiveTasksChanged?(tasks: readonly BackgroundToolTaskLiveView[]): void;
	recordUsage?(taskId: string, usage: Usage): void;
	onError?(message: string, error: unknown): void;
	now?(): Date;
}

interface BackgroundToolTaskState {
	record: BackgroundToolTaskRecord;
	cancel: () => void;
	cancellationRequested: boolean;
	waitingConsumers: number;
	terminal: Promise<BackgroundToolTaskRecord>;
	resolveTerminal: (record: BackgroundToolTaskRecord) => void;
	artifactHolderId: string;
}

/** Read only task records on the active branch without allocating or hydrating the full branch context. */
export function loadBackgroundToolTaskRecordsNewestFirst(
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch">,
): unknown[] {
	const records: unknown[] = [];
	let fromId: string | undefined;
	for (;;) {
		const entry = sessionManager.getLatestCustomEntryOnBranch(BACKGROUND_TOOL_TASK_CUSTOM_TYPE, fromId);
		if (!entry) return records;
		records.push(entry.data);
		if (entry.parentId === null) return records;
		fromId = entry.parentId;
	}
}

export function createBackgroundToolTerminalMessage(
	records: readonly BackgroundToolTaskRecord[],
): BackgroundToolTerminalMessage {
	if (records.length === 0) throw new TypeError("Background tool terminal handoff requires at least one record");
	const included = records.slice(0, MAX_TERMINAL_HANDOFF_RECORDS);
	const omitted = records.length - included.length;
	return {
		customType: "background-tool-completion",
		content: [
			"Background tool terminal handoff:",
			...included.map((record) => `- ${record.taskId}: ${record.status} tool=${record.toolName}`),
			...(omitted > 0 ? [`- ${omitted} additional terminal tool task(s) omitted.`] : []),
			"Parent woke. Need result: tool_task action=wait once; never poll.",
		].join("\n"),
		display: true,
		details: {
			records: included.map((record) => ({
				taskId: record.taskId,
				status: record.status,
				toolName: record.toolName,
				...(record.artifactId ? { artifactId: record.artifactId } : {}),
			})),
		},
	};
}

function renderCompletionOutput(completion: BackgroundToolCallCompletion): string {
	const blocks = completion.result.content.map((block) =>
		block.type === "text" ? block.text : "[Image output retained outside the foreground transcript]",
	);
	return blocks.join("\n") || "Tool completed without text output.";
}

function oneLine(value: string): string {
	return value
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function summaryFor(status: BackgroundToolTaskStatus, toolName: string, output: string): string {
	const prefix = `${toolName} ${status}`;
	const firstLine = oneLine(output);
	if (!firstLine) return prefix;
	const remaining = Math.max(0, MAX_SUMMARY_CHARS - prefix.length - 2);
	return `${prefix}: ${firstLine.slice(0, remaining)}`;
}

function taskNumber(taskId: string): number | undefined {
	const match = TASK_ID_PATTERN.exec(taskId);
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function cloneUsage(value: unknown): Usage | undefined {
	if (!isPlainRecord(value)) return undefined;
	const cost = value.cost;
	if (!isPlainRecord(cost)) return undefined;
	const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
	const costFields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
	if (
		fields.some((field) => typeof value[field] !== "number" || !Number.isFinite(value[field])) ||
		costFields.some((field) => typeof cost[field] !== "number" || !Number.isFinite(cost[field]))
	) {
		return undefined;
	}
	return {
		input: value.input as number,
		output: value.output as number,
		cacheRead: value.cacheRead as number,
		cacheWrite: value.cacheWrite as number,
		totalTokens: value.totalTokens as number,
		cost: {
			input: cost.input as number,
			output: cost.output as number,
			cacheRead: cost.cacheRead as number,
			cacheWrite: cost.cacheWrite as number,
			total: cost.total as number,
		},
	};
}

function decodeRecord(value: unknown, sessionIds: ReadonlySet<string>): BackgroundToolTaskRecord | undefined {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) return undefined;
	if (
		typeof value.sessionId !== "string" ||
		value.sessionId.length === 0 ||
		!sessionIds.has(value.sessionId) ||
		typeof value.taskId !== "string" ||
		taskNumber(value.taskId) === undefined ||
		typeof value.toolCallId !== "string" ||
		value.toolCallId.length === 0 ||
		typeof value.toolName !== "string" ||
		value.toolName.length === 0 ||
		(value.status !== "running" &&
			value.status !== "completed" &&
			value.status !== "failed" &&
			value.status !== "canceled") ||
		typeof value.startedAt !== "string" ||
		!Number.isFinite(Date.parse(value.startedAt)) ||
		(value.completedAt !== undefined &&
			(typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt)))) ||
		(value.status !== "running" && value.completedAt === undefined) ||
		typeof value.elapsedBeforeHandoffMs !== "number" ||
		!Number.isFinite(value.elapsedBeforeHandoffMs) ||
		value.elapsedBeforeHandoffMs < 0 ||
		typeof value.summary !== "string" ||
		typeof value.output !== "string" ||
		(value.artifactId !== undefined &&
			(typeof value.artifactId !== "string" || !/^[0-9a-f]{1,64}$/.test(value.artifactId))) ||
		(value.cancellationRequested !== undefined && typeof value.cancellationRequested !== "boolean")
	) {
		return undefined;
	}
	const usage = value.usage === undefined ? undefined : cloneUsage(value.usage);
	if (value.usage !== undefined && !usage) return undefined;
	return {
		sessionId: value.sessionId,
		taskId: value.taskId,
		toolCallId: value.toolCallId,
		toolName: value.toolName,
		status: value.status,
		startedAt: value.startedAt,
		...(value.completedAt ? { completedAt: value.completedAt } : {}),
		elapsedBeforeHandoffMs: value.elapsedBeforeHandoffMs,
		summary: value.summary,
		output: value.output,
		...(value.artifactId ? { artifactId: value.artifactId } : {}),
		...(usage ? { usage } : {}),
		...(value.cancellationRequested !== undefined ? { cancellationRequested: value.cancellationRequested } : {}),
	};
}

/**
 * Session-owned registry for foreground tool calls transferred into background execution.
 * It emits edge records for durability and a replace-style live-task signal for UI consumers.
 */
export class BackgroundToolTaskController {
	private readonly deps: BackgroundToolTaskControllerDeps;
	private readonly tasks = new Map<string, BackgroundToolTaskState>();
	private readonly handoffRequests = new Map<string, Set<() => void>>();
	private readonly queuedNotifications: Array<{ record: BackgroundToolTaskRecord; wakeParent: boolean }> = [];
	private notificationDrain: Promise<void> | undefined;
	private nextTaskId = 1;
	private disposed = false;

	constructor(deps: BackgroundToolTaskControllerDeps) {
		this.deps = deps;
		this.restorePersistedTasks();
	}

	handoff(context: BackgroundToolCallContext): BackgroundToolCallHandoff | undefined {
		if (this.disposed || context.toolCall.name === "tool_task") return undefined;
		const sessionId = this.deps.getSessionId();
		const taskId = `tool-task-${this.nextTaskId++}`;
		const startedAt = this.now().toISOString();
		const record: BackgroundToolTaskRecord = {
			sessionId,
			taskId,
			toolCallId: context.toolCall.id,
			toolName: context.toolCall.name,
			status: "running",
			startedAt,
			elapsedBeforeHandoffMs: context.elapsedMs,
			summary: `${context.toolCall.name} running in the background`,
			output: "",
		};
		const state = this.createState(record, context.cancel);
		this.tasks.set(taskId, state);
		if (!this.persist(record)) {
			this.tasks.delete(taskId);
			return undefined;
		}
		this.emitLiveTasks();
		context.completion.then(
			(completion) => this.settle(state, completion),
			(error) => this.settleRejected(state, error),
		);

		return {
			result: {
				content: [
					{
						type: "text",
						text: [
							`Tool ${context.toolCall.name} exceeded ${Math.max(1, Math.round(context.elapsedMs / 1000))}s; running as session task ${taskId}.`,
							"Continue independent work. Dependency: tool_task action=wait once with taskId; event-driven, never poll.",
						].join("\n"),
					},
				],
				details: { sessionId, taskId, status: "running" as const },
			},
		};
	}

	list(): BackgroundToolTaskRecord[] {
		return [...this.tasks.values()].map((state) => ({ ...state.record }));
	}

	wait(taskId: string, signal?: AbortSignal): Promise<BackgroundToolTaskRecord> {
		const state = this.tasks.get(taskId);
		if (!state) return Promise.reject(new Error(`Unknown background tool task: ${taskId}`));
		if (state.record.status !== "running") return Promise.resolve({ ...state.record });
		state.waitingConsumers++;
		let waiting = true;
		const releaseWaiter = (): void => {
			if (!waiting) return;
			waiting = false;
			state.waitingConsumers--;
		};
		if (!signal) {
			return state.terminal.then((record) => {
				releaseWaiter();
				return { ...record };
			});
		}
		if (signal.aborted) {
			releaseWaiter();
			return Promise.reject(signal.reason ?? new Error("Operation aborted"));
		}
		return new Promise<BackgroundToolTaskRecord>((resolve, reject) => {
			const onAbort = (): void => {
				signal.removeEventListener("abort", onAbort);
				releaseWaiter();
				reject(signal.reason ?? new Error("Operation aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			state.terminal.then((record) => {
				signal.removeEventListener("abort", onAbort);
				releaseWaiter();
				resolve({ ...record });
			});
		});
	}

	cancel(taskId: string): boolean {
		const state = this.tasks.get(taskId);
		if (!state || state.record.status !== "running") return false;
		state.cancellationRequested = true;
		state.record = { ...state.record, cancellationRequested: true };
		try {
			state.cancel();
		} catch (error) {
			this.deps.onError?.(`Failed to cancel background tool task ${taskId}`, error);
		}
		return true;
	}

	subscribeHandoffRequest(toolCallId: string, request: () => void): () => void {
		if (this.disposed) return () => {};
		const requests = this.handoffRequests.get(toolCallId) ?? new Set<() => void>();
		requests.add(request);
		this.handoffRequests.set(toolCallId, requests);
		return () => {
			requests.delete(request);
			if (requests.size === 0) this.handoffRequests.delete(toolCallId);
		};
	}

	requestHandoff(toolCallId?: string): number {
		if (this.disposed) return 0;
		const requested = toolCallId
			? [...(this.handoffRequests.get(toolCallId) ?? [])]
			: [...this.handoffRequests.values()].flatMap((requests) => [...requests]);
		for (const request of requested) request();
		return requested.length;
	}

	async waitForNotifications(): Promise<void> {
		// A just-resolved tool completion settles through its promise continuation before it can enqueue
		// the notification drain. Yield once so this event-driven barrier observes that enqueue.
		await Promise.resolve();
		for (;;) {
			const drain = this.notificationDrain;
			if (!drain) return;
			await drain;
			if (!this.notificationDrain && this.queuedNotifications.length === 0) return;
		}
	}

	async shutdown(): Promise<void> {
		if (!this.disposed) {
			this.disposed = true;
			this.handoffRequests.clear();
			for (const state of this.tasks.values()) {
				if (state.record.status !== "running") continue;
				state.cancellationRequested = true;
				try {
					state.cancel();
				} catch (error) {
					this.deps.onError?.(`Failed to cancel background tool task ${state.record.taskId}`, error);
				}
				this.finishState(
					state,
					"canceled",
					"Session ended before the background tool completed.",
					undefined,
					false,
				);
			}
		}
		await this.waitForNotifications();
	}

	private settle(state: BackgroundToolTaskState, completion: BackgroundToolCallCompletion): void {
		if (state.record.status !== "running") return;
		const status = state.cancellationRequested ? "canceled" : completion.isError ? "failed" : "completed";
		const output = renderCompletionOutput(completion);
		this.finishState(state, status, output, completion.result.usage, true);
	}

	private settleRejected(state: BackgroundToolTaskState, error: unknown): void {
		if (state.record.status !== "running") return;
		const status = state.cancellationRequested ? "canceled" : "failed";
		const output = error instanceof Error ? error.message : String(error);
		this.finishState(state, status, output, undefined, true);
	}

	private restorePersistedTasks(): void {
		const load = this.deps.loadPersistedRecordsNewestFirst;
		if (!load) return;
		let values: readonly unknown[];
		try {
			values = load();
		} catch (error) {
			this.deps.onError?.("Failed to load persisted background tool tasks", error);
			return;
		}
		const sessionId = this.deps.getSessionId();
		const sessionIds = new Set(this.deps.getSessionLineageIds?.() ?? [sessionId]);
		sessionIds.add(sessionId);
		const seenTaskIds = new Set<string>();
		const latestRecords: BackgroundToolTaskRecord[] = [];
		let highestTaskNumber = 0;
		for (const value of values) {
			if (
				!isPlainRecord(value) ||
				typeof value.sessionId !== "string" ||
				!sessionIds.has(value.sessionId) ||
				typeof value.taskId !== "string"
			) {
				continue;
			}
			const numericTaskId = taskNumber(value.taskId);
			if (numericTaskId === undefined) continue;
			highestTaskNumber = Math.max(highestTaskNumber, numericTaskId);
			if (seenTaskIds.has(value.taskId)) continue;
			seenTaskIds.add(value.taskId);
			const record = decodeRecord(value, sessionIds);
			if (record) latestRecords.push(record);
		}
		this.nextTaskId = highestTaskNumber + 1;
		latestRecords.sort((left, right) => taskNumber(left.taskId)! - taskNumber(right.taskId)!);
		for (const record of latestRecords) {
			const state = this.createState(record, () => {});
			this.tasks.set(record.taskId, state);
			if (record.status !== "running") {
				state.resolveTerminal(record);
				continue;
			}
			this.finishState(
				state,
				"failed",
				"The session resumed after the owning process ended; the original tool completion is unavailable.",
				undefined,
				false,
			);
		}
		this.pruneTerminalTasks();
		this.emitLiveTasks();
	}

	private createState(record: BackgroundToolTaskRecord, cancel: () => void): BackgroundToolTaskState {
		let resolveTerminal: ((terminalRecord: BackgroundToolTaskRecord) => void) | undefined;
		const terminal = new Promise<BackgroundToolTaskRecord>((resolve) => {
			resolveTerminal = resolve;
		});
		return {
			record: { ...record },
			cancel,
			cancellationRequested: record.cancellationRequested ?? false,
			waitingConsumers: 0,
			terminal,
			resolveTerminal: resolveTerminal!,
			artifactHolderId: `background-tool-task:${record.sessionId}:${record.taskId}`,
		};
	}

	private finishState(
		state: BackgroundToolTaskState,
		status: Exclude<BackgroundToolTaskStatus, "running">,
		rawOutput: string,
		usage: Usage | undefined,
		notify: boolean,
	): void {
		const packed = packToolOutput(
			{
				toolName: state.record.toolName,
				rawContent: rawOutput,
				sessionEntryId: state.record.taskId,
				createdAtTurn: 0,
				reproducible: false,
				truncation: { maxBytes: MAX_INLINE_OUTPUT_BYTES, maxLines: MAX_INLINE_OUTPUT_LINES },
			},
			this.deps.getArtifactStore(),
			state.artifactHolderId,
		);
		const output = packed.artifactId
			? `${packed.content}\n\n[${formatArtifactNotice(packed.artifactId)}]`
			: packed.content;
		const record: BackgroundToolTaskRecord = {
			...state.record,
			status,
			completedAt: this.now().toISOString(),
			summary: summaryFor(status, state.record.toolName, output),
			output,
			...(packed.artifactId ? { artifactId: packed.artifactId } : {}),
			...(usage ? { usage } : {}),
			...(state.cancellationRequested ? { cancellationRequested: true } : {}),
		};
		state.record = record;
		this.persist(record);
		if (usage) this.deps.recordUsage?.(record.taskId, usage);
		state.resolveTerminal(record);
		this.emitLiveTasks();
		this.pruneTerminalTasks();
		if (notify) this.notify(record, state.waitingConsumers === 0);
	}

	private persist(record: BackgroundToolTaskRecord): boolean {
		try {
			this.deps.persist({ ...record });
			return true;
		} catch (error) {
			this.deps.onError?.(`Failed to persist background tool task ${record.taskId}`, error);
			return false;
		}
	}

	private notify(record: BackgroundToolTaskRecord, wakeParent: boolean): void {
		this.queuedNotifications.push({ record: { ...record }, wakeParent });
		this.scheduleNotificationDrain();
	}

	private scheduleNotificationDrain(): void {
		if (this.notificationDrain) return;
		this.notificationDrain = this.drainNotifications().finally(() => {
			this.notificationDrain = undefined;
			if (this.queuedNotifications.length > 0) this.scheduleNotificationDrain();
		});
	}

	private async drainNotifications(): Promise<void> {
		// Allow completions released by the same event to reach this queue before forming the batch.
		await Promise.resolve();
		while (this.queuedNotifications.length > 0) {
			await Promise.resolve();
			const batch = this.queuedNotifications.splice(0);
			const records = batch.map((notification) => notification.record);
			try {
				await this.deps.notifyTerminal(records, {
					wakeParent: batch.some((notification) => notification.wakeParent),
				});
			} catch (error) {
				const includedIds = records.slice(0, MAX_TERMINAL_HANDOFF_RECORDS).map((record) => record.taskId);
				const omitted = records.length - includedIds.length;
				const suffix = omitted > 0 ? ` (+${omitted} more)` : "";
				this.deps.onError?.(
					`Failed to notify terminal background tool task batch ${includedIds.join(", ")}${suffix}`,
					error,
				);
			}
		}
	}

	private emitLiveTasks(): void {
		const tasks = [...this.tasks.values()]
			.filter((state) => state.record.status === "running")
			.map((state) => ({
				taskId: state.record.taskId,
				toolCallId: state.record.toolCallId,
				toolName: state.record.toolName,
				description: state.record.summary,
			}));
		try {
			this.deps.onLiveTasksChanged?.(tasks);
		} catch (error) {
			this.deps.onError?.("Failed to emit background tool task level signal", error);
		}
	}

	private pruneTerminalTasks(): void {
		const terminal = [...this.tasks.values()].filter((state) => state.record.status !== "running");
		for (const state of terminal.slice(0, Math.max(0, terminal.length - MAX_RETAINED_TERMINAL_TASKS))) {
			this.tasks.delete(state.record.taskId);
			if (!state.record.artifactId) continue;
			const store = this.deps.getArtifactStore();
			store?.removeReference(state.record.artifactId, state.artifactHolderId);
			store?.cleanup();
		}
	}

	private now(): Date {
		return this.deps.now?.() ?? new Date();
	}
}
