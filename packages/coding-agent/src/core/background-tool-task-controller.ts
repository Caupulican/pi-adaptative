import type {
	BackgroundToolCallCompletion,
	BackgroundToolCallContext,
	BackgroundToolCallHandoff,
} from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Usage } from "@caupulican/pi-ai";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import { formatArtifactNotice, packToolOutput } from "./context/tool-output-packer.ts";
import { hasOnlyKeys, isPlainRecord, isRecordObject } from "./util/value-guards.ts";

/**
 * Foreground tool calls running longer than this hand off to a background task (see `handoff`
 * below). Configurable via `SettingsManager.getBackgroundToolSettings().callAfterMs`; this constant
 * is only its fallback default, used when the setting is unset or fails sanitization.
 *
 * The default's justification is measured, not assumed, and is under-tuned by that measurement:
 * re-collecting a backgrounded result costs at least one extra provider round trip (observed p50
 * 5.7s, p90 12.8s across a real fleet sample), so backgrounding anything that would have finished
 * within roughly 25-30s is a net loss. 15s sits below that break-even point, and a real sample saw
 * roughly 10% of bash calls terminate at exactly this threshold. The value is left unchanged here
 * deliberately — raising the default is a product/cost tradeoff for the owner to make separately
 * from making it configurable at all.
 */
export const DEFAULT_BACKGROUND_TOOL_CALL_AFTER_MS = 15_000;
/**
 * How long one `tool_task wait` may block by default. A wait is the model's own decision to have
 * nothing else to do until the task ends, so it blocks as long as a delegate wait may (five
 * minutes) instead of returning "still running" after thirty seconds and inviting a poll.
 */
export const DEFAULT_BACKGROUND_TOOL_TASK_WAIT_TIMEOUT_MS = 300_000;
export const BACKGROUND_TOOL_TASK_CUSTOM_TYPE = "background_tool_task";

const MAX_RETAINED_TERMINAL_TASKS = 64;
const MAX_INLINE_OUTPUT_BYTES = 32 * 1024;
const MAX_INLINE_OUTPUT_LINES = 400;
/** Budgeted so a projected failure summary keeps its diagnostic instead of cutting it off. */
const MAX_SUMMARY_CHARS = 320;
const MAX_TERMINAL_HANDOFF_RECORDS = 8;
const MAX_VERIFICATION_ID_LENGTH = 128;
const TASK_ID_PATTERN = /^tool-task-([1-9]\d*)$/;
const VERIFICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RECORD_KEYS = [
	"sessionId",
	"taskId",
	"toolCallId",
	"toolName",
	"goalId",
	"status",
	"startedAt",
	"completedAt",
	"elapsedBeforeHandoffMs",
	"summary",
	"output",
	"artifactId",
	"usage",
	"cancellationRequested",
	"terminalDelivery",
	"piVerification",
] as const;

export type BackgroundToolTaskStatus = "running" | "completed" | "failed" | "canceled";
export type BackgroundToolTerminalDelivery = "pending" | "delivered";

type ToolVerification = {
	version: 1;
	id: string;
	status: "failed" | "passed";
};

type BackgroundToolVerification = ToolVerification & {
	/** Host-bound origin used to order delayed background observations in the foreground transcript. */
	originTaskId: string;
};

export type BackgroundToolTaskRef = Pick<BackgroundToolTaskRecord, "taskId" | "toolCallId" | "goalId" | "status">;

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
	/** Goal execution that owned the foreground tool call when it was handed off. */
	goalId?: string;
	status: BackgroundToolTaskStatus;
	startedAt: string;
	completedAt?: string;
	elapsedBeforeHandoffMs: number;
	summary: string;
	output: string;
	artifactId?: string;
	usage?: Usage;
	cancellationRequested?: boolean;
	/** Durable terminal handoff state. Undefined on legacy records, which are treated as delivered. */
	terminalDelivery?: BackgroundToolTerminalDelivery;
	/** Canonical tool-owned verification state, retained only after validation. */
	piVerification?: BackgroundToolVerification;
	/** Runtime-only receipt; never serialized into the durable task record. */
	observedAt?: string;
	/**
	 * Foreground submission epoch that was current when this task was STARTED (captured in
	 * `handoff()`, never at completion or schedule time -- see
	 * foreground-terminal-handoff-controller.ts's ownership check). Runtime-only; never serialized
	 * into the durable task record, same as `observedAt`. Absent on legacy, resumed, or
	 * cross-process records, which is the signal that the boundary-fold route must not use them.
	 */
	ownerEpoch?: number;
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
			piVerification?: BackgroundToolVerification;
		}>;
		piVerificationEvents: BackgroundToolVerification[];
	};
}

export interface BackgroundToolTaskControllerDeps {
	getSessionId(): string;
	/** Authoritative goal execution attribution at the tool handoff boundary. */
	getGoalId?(): string | undefined;
	/** Current foreground submission epoch, or undefined when no submission is held. Read once at
	 * task start to stamp `ownerEpoch` -- never read again later, so a task always remembers who
	 * owned it when it began, not whoever happens to be current by the time it finishes. */
	getCurrentSubmissionEpoch?(): number | undefined;
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
	/** Event-wait watchdog; completion still arrives through the terminal handoff after this bound. */
	waitTimeoutMs?: number;
	/** True when the tool declares this call a foreground wait; such a call is never handed off. */
	isForegroundWait?: (toolName: string, args: unknown) => boolean;
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
	options?: { wakeParent?: boolean },
): BackgroundToolTerminalMessage {
	if (records.length === 0) throw new TypeError("Background tool terminal handoff requires at least one record");
	const included = records.slice(0, MAX_TERMINAL_HANDOFF_RECORDS);
	const omitted = records.length - included.length;
	const wakeParent = options?.wakeParent ?? true;
	return {
		customType: "background-tool-completion",
		content: [
			"Background tool terminal handoff:",
			...included.map((record) => `- ${record.taskId}: ${record.status} tool=${record.toolName}`),
			...(omitted > 0 ? [`- ${omitted} additional terminal tool task(s) omitted.`] : []),
			...(wakeParent
				? ["Parent woke. Need result: tool_task action=wait once; never poll."]
				: ["Parent was not woken because the owning goal is no longer active. Wait for explicit user input."]),
		].join("\n"),
		display: true,
		details: {
			records: included.map((record) => ({
				taskId: record.taskId,
				status: record.status,
				toolName: record.toolName,
				...(record.artifactId ? { artifactId: record.artifactId } : {}),
				...(record.piVerification &&
				record.piVerification.originTaskId === record.taskId &&
				(record.piVerification.status !== "passed" || record.status === "completed")
					? { piVerification: { ...record.piVerification } }
					: {}),
			})),
			piVerificationEvents: included.flatMap((record) =>
				record.piVerification &&
				record.piVerification.originTaskId === record.taskId &&
				(record.piVerification.status !== "passed" || record.status === "completed")
					? [{ ...record.piVerification }]
					: [],
			),
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

/**
 * The model-facing half of a `[harness]` failure record, in cause-first order.
 *
 * Head-truncating the serialized record instead spends the budget on harness bookkeeping — `MUST`,
 * `occ`, `kind_mistakes`, `mistake_kind`, `failure_key` all precede `failure_code` — and cuts the
 * remaining text mid-key, so the one field that says why the task failed is the field that is lost.
 */
function harnessFailureSummary(output: string): string | undefined {
	const start = output.indexOf("[harness]");
	if (start < 0) return undefined;
	const braceStart = output.indexOf("{", start);
	if (braceStart < 0) return undefined;
	let record: unknown;
	try {
		record = JSON.parse(output.slice(braceStart));
	} catch {
		return undefined;
	}
	if (!isPlainRecord(record)) return undefined;
	const parts: string[] = [];
	for (const field of ["state", "phase", "failure_code", "diagnostic", "next_action"] as const) {
		const value = record[field];
		if (typeof value === "string" && value.trim()) parts.push(`${field}=${oneLine(value)}`);
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function summaryFor(status: BackgroundToolTaskStatus, toolName: string, output: string): string {
	const prefix = `${toolName} ${status}`;
	const firstLine = harnessFailureSummary(output) ?? oneLine(output);
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

function ownDataValue(record: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Normalize the cross-package verification wire contract before durable persistence. */
function retainedToolVerification(details: unknown): ToolVerification | undefined {
	if (!isRecordObject(details)) return undefined;
	const candidate = ownDataValue(details, "piVerification");
	if (!isRecordObject(candidate)) return undefined;
	const version = ownDataValue(candidate, "version");
	const id = ownDataValue(candidate, "id");
	const status = ownDataValue(candidate, "status");
	if (
		version !== 1 ||
		typeof id !== "string" ||
		id.length > MAX_VERIFICATION_ID_LENGTH ||
		!VERIFICATION_ID_PATTERN.test(id) ||
		(status !== "failed" && status !== "passed")
	) {
		return undefined;
	}
	return { version, id, status };
}

function retainedBackgroundToolVerification(details: unknown, taskId: string): BackgroundToolVerification | undefined {
	const verification = retainedToolVerification(details);
	if (!verification || !isRecordObject(details)) return undefined;
	const candidate = ownDataValue(details, "piVerification");
	if (!isRecordObject(candidate) || ownDataValue(candidate, "originTaskId") !== taskId) return undefined;
	return { ...verification, originTaskId: taskId };
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
		(value.goalId !== undefined && (typeof value.goalId !== "string" || value.goalId.length === 0)) ||
		typeof value.elapsedBeforeHandoffMs !== "number" ||
		!Number.isFinite(value.elapsedBeforeHandoffMs) ||
		value.elapsedBeforeHandoffMs < 0 ||
		typeof value.summary !== "string" ||
		typeof value.output !== "string" ||
		(value.artifactId !== undefined &&
			(typeof value.artifactId !== "string" || !/^[0-9a-f]{1,64}$/.test(value.artifactId))) ||
		(value.cancellationRequested !== undefined && typeof value.cancellationRequested !== "boolean") ||
		(value.terminalDelivery !== undefined &&
			value.terminalDelivery !== "pending" &&
			value.terminalDelivery !== "delivered")
	) {
		return undefined;
	}
	const usage = value.usage === undefined ? undefined : cloneUsage(value.usage);
	if (value.usage !== undefined && !usage) return undefined;
	const rawVerification = retainedToolVerification(value);
	if (value.piVerification !== undefined && !rawVerification) return undefined;
	const verification = rawVerification
		? rawVerification.status === "passed" &&
			(!retainedBackgroundToolVerification(value, value.taskId) || value.status !== "completed")
			? undefined
			: { ...rawVerification, originTaskId: value.taskId }
		: undefined;
	return {
		sessionId: value.sessionId,
		taskId: value.taskId,
		toolCallId: value.toolCallId,
		toolName: value.toolName,
		...(value.goalId ? { goalId: value.goalId } : {}),
		status: value.status,
		startedAt: value.startedAt,
		...(value.completedAt ? { completedAt: value.completedAt } : {}),
		elapsedBeforeHandoffMs: value.elapsedBeforeHandoffMs,
		summary: value.summary,
		output: value.output,
		...(value.artifactId ? { artifactId: value.artifactId } : {}),
		...(usage ? { usage } : {}),
		...(value.cancellationRequested !== undefined ? { cancellationRequested: value.cancellationRequested } : {}),
		...(value.terminalDelivery !== undefined ? { terminalDelivery: value.terminalDelivery } : {}),
		...(verification ? { piVerification: verification } : {}),
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
	private readonly activeNotificationRecords = new Set<BackgroundToolTaskRecord>();
	private notificationDrain: Promise<void> | undefined;
	private notificationRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private notificationRetryCompletion: Promise<void> | undefined;
	private resolveNotificationRetry: (() => void) | undefined;
	private notificationRetryCount = 0;
	private readonly waitTimeoutMs: number;
	private nextTaskId = 1;
	private disposed = false;

	constructor(deps: BackgroundToolTaskControllerDeps) {
		this.deps = deps;
		this.waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_BACKGROUND_TOOL_TASK_WAIT_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs < 1) {
			throw new TypeError("Background tool task wait timeout must be a positive safe integer.");
		}
		this.restorePersistedTasks();
	}

	handoff(context: BackgroundToolCallContext): BackgroundToolCallHandoff | undefined {
		if (
			this.disposed ||
			context.toolCall.name === "tool_task" ||
			this.deps.isForegroundWait?.(context.toolCall.name, context.args) === true
		) {
			return undefined;
		}
		const sessionId = this.deps.getSessionId();
		const taskId = `tool-task-${this.nextTaskId++}`;
		const startedAt = this.now().toISOString();
		const goalId = this.deps.getGoalId?.();
		const ownerEpoch = this.deps.getCurrentSubmissionEpoch?.();
		const record: BackgroundToolTaskRecord = {
			sessionId,
			taskId,
			toolCallId: context.toolCall.id,
			toolName: context.toolCall.name,
			...(goalId ? { goalId } : {}),
			...(ownerEpoch !== undefined ? { ownerEpoch } : {}),
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

	/** Model-facing read that consumes terminal delivery without approving its outcome. */
	observe(taskIds?: string | readonly string[]): BackgroundToolTaskRecord[] {
		const ids = typeof taskIds === "string" ? [taskIds] : taskIds;
		const states = ids
			? ids.flatMap((taskId) => {
					const state = this.tasks.get(taskId);
					return state === undefined ? [] : [state];
				})
			: [...this.tasks.values()];
		for (const state of states) this.observeState(state);
		return states.map((state) => ({ ...state.record }));
	}

	wait(taskId: string, signal?: AbortSignal, timeoutMs?: number): Promise<BackgroundToolTaskRecord> {
		const waitBoundMs = timeoutMs ?? this.waitTimeoutMs;
		if (!Number.isSafeInteger(waitBoundMs) || waitBoundMs < 1) {
			return Promise.reject(new TypeError("Background tool task wait timeout must be a positive safe integer."));
		}
		const state = this.tasks.get(taskId);
		if (!state) return Promise.reject(new Error(`Unknown background tool task: ${taskId}`));
		if (state.record.status !== "running") {
			this.observeState(state);
			return Promise.resolve({ ...state.record });
		}
		if (signal?.aborted) return Promise.resolve({ ...state.record });
		state.waitingConsumers++;
		let waiting = true;
		const releaseWaiter = (): void => {
			if (!waiting) return;
			waiting = false;
			state.waitingConsumers--;
		};
		return new Promise<BackgroundToolTaskRecord>((resolve) => {
			let settled = false;
			const finishWait = (record: BackgroundToolTaskRecord): void => {
				if (settled) return;
				settled = true;
				clearTimeout(watchdog);
				signal?.removeEventListener("abort", onAbort);
				releaseWaiter();
				if (record.status !== "running") this.observeState(state);
				resolve({ ...state.record });
			};
			const onAbort = (): void => {
				finishWait(state.record);
			};
			const watchdog = setTimeout(() => finishWait(state.record), waitBoundMs);
			watchdog.unref?.();
			signal?.addEventListener("abort", onAbort, { once: true });
			state.terminal.then(finishWait);
		});
	}

	cancel(taskId: string): boolean {
		const state = this.tasks.get(taskId);
		if (state?.record.status !== "running") return false;
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
			if (drain) {
				await drain;
				continue;
			}
			if (this.queuedNotifications.length === 0) return;
			const retry = this.notificationRetryCompletion;
			if (retry) {
				await retry;
				continue;
			}
			if (this.disposed) return;
			this.scheduleNotificationDrain();
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
		this.finishState(
			state,
			status,
			output,
			completion.result.usage,
			true,
			retainedToolVerification(completion.result.details),
		);
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
				if (record.terminalDelivery === "pending") this.notify(record, true);
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
		verification?: ToolVerification,
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
			terminalDelivery: notify ? "pending" : "delivered",
			...(verification && (verification.status !== "passed" || status === "completed")
				? { piVerification: { ...verification, originTaskId: state.record.taskId } }
				: {}),
		};
		const persisted = this.persist(record);
		const terminalRecord = persisted
			? record
			: (() => {
					const { piVerification: _verification, ...unavailableRecord } = record;
					return {
						...unavailableRecord,
						status: "failed" as const,
						summary: `${record.toolName} failed: terminal result could not be persisted`,
						output: "Background tool result could not be persisted; treat it as unavailable.",
					};
				})();
		state.record = terminalRecord;
		if (usage) this.deps.recordUsage?.(record.taskId, usage);
		state.resolveTerminal(terminalRecord);
		this.emitLiveTasks();
		this.pruneTerminalTasks();
		if (notify) this.notify(terminalRecord, state.waitingConsumers === 0);
	}

	private persist(record: BackgroundToolTaskRecord): boolean {
		try {
			const durableRecord = { ...record };
			delete durableRecord.observedAt;
			delete durableRecord.ownerEpoch;
			this.deps.persist(durableRecord);
			return true;
		} catch (error) {
			this.deps.onError?.(`Failed to persist background tool task ${record.taskId}`, error);
			return false;
		}
	}

	private notify(record: BackgroundToolTaskRecord, wakeParent: boolean): void {
		const notificationRecord = {
			...record,
			...(!wakeParent && !record.observedAt ? { observedAt: this.now().toISOString() } : {}),
		};
		this.activeNotificationRecords.add(notificationRecord);
		this.queuedNotifications.push({ record: notificationRecord, wakeParent });
		this.scheduleNotificationDrain();
	}

	private markNotificationDelivered(record: BackgroundToolTaskRecord): void {
		if (record.terminalDelivery !== "pending") return;
		const delivered = { ...record, terminalDelivery: "delivered" as const };
		if (this.persist(delivered)) {
			const state = this.tasks.get(record.taskId);
			if (state && state.record.completedAt === record.completedAt) state.record = delivered;
		}
	}

	private observeState(state: BackgroundToolTaskState): void {
		if (state.record.status === "running" || state.record.observedAt) return;
		const observedAt = this.now().toISOString();
		state.record = { ...state.record, observedAt };
		for (const record of this.activeNotificationRecords) {
			if (record.taskId === state.record.taskId && record.completedAt === state.record.completedAt) {
				record.observedAt = observedAt;
			}
		}
	}

	private scheduleNotificationDrain(): void {
		if (this.disposed || this.notificationDrain || this.notificationRetryTimer) return;
		this.notificationDrain = this.drainNotifications().finally(() => {
			this.notificationDrain = undefined;
			if (this.queuedNotifications.length > 0 && !this.notificationRetryTimer) this.scheduleNotificationDrain();
		});
	}

	private scheduleNotificationRetry(): void {
		if (this.disposed || this.notificationRetryTimer) return;
		const delayMs = Math.min(100 * 2 ** Math.min(this.notificationRetryCount, 5), 5_000);
		this.notificationRetryCount++;
		this.notificationRetryCompletion = new Promise<void>((resolve) => {
			this.resolveNotificationRetry = resolve;
		});
		this.notificationRetryTimer = setTimeout(() => {
			this.notificationRetryTimer = undefined;
			const resolve = this.resolveNotificationRetry;
			this.resolveNotificationRetry = undefined;
			this.notificationRetryCompletion = undefined;
			resolve?.();
			this.scheduleNotificationDrain();
		}, delayMs);
		this.notificationRetryTimer.unref?.();
	}

	private async drainNotifications(): Promise<void> {
		// Allow completions released by the same event to reach this queue before forming the batch.
		await Promise.resolve();
		while (this.queuedNotifications.length > 0) {
			await Promise.resolve();
			const batch = this.queuedNotifications.splice(0, MAX_TERMINAL_HANDOFF_RECORDS);
			const records = batch.map((notification) => notification.record);
			try {
				await this.deps.notifyTerminal(records, {
					wakeParent: batch.some((notification) => notification.wakeParent),
				});
			} catch (error) {
				// A rejected handoff is not a delivery receipt. Put the exact records back ahead of
				// newer completions and retry on an event-driven backoff; persistence already contains
				// the terminal, so a transient notifier failure must not make it disappear.
				this.queuedNotifications.unshift(...batch);
				const includedIds = records.slice(0, MAX_TERMINAL_HANDOFF_RECORDS).map((record) => record.taskId);
				const omitted = records.length - includedIds.length;
				const suffix = omitted > 0 ? ` (+${omitted} more)` : "";
				try {
					this.deps.onError?.(
						`Failed to notify terminal background tool task batch ${includedIds.join(", ")}${suffix}`,
						error,
					);
				} catch {
					// Diagnostics cannot consume the pending terminal handoff.
				}
				this.scheduleNotificationRetry();
				return;
			}
			this.notificationRetryCount = 0;
			for (const record of records) this.markNotificationDelivered(record);
			for (const record of records) {
				this.activeNotificationRecords.delete(record);
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
