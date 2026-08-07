import { Buffer } from "node:buffer";
import type { AttemptStatus, OrchestrationTaskStatus, WorkerRole } from "../orchestration/contracts.ts";
import {
	ATTEMPT_STATUSES,
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_DESCRIPTION_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	TASK_STATUSES,
	WORKER_ROLES,
} from "../orchestration/contracts.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { DEFAULT_WORKER_FLEET_LIMITS } from "./worker-fleet-limits.ts";

/** Keep task views within the same durable session fan-out ceiling as the worker fleet. */
export const MAX_WORKER_TASK_VIEW_ENTRIES = Math.min(
	DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession,
	DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches,
);

/** Bound model-facing serialization independently of task-count and field-count limits. */
export const MAX_WORKER_TASK_VIEW_BYTES = 64 * 1024;

export interface WorkerTaskAttemptView {
	agentId?: string;
	status: AttemptStatus;
	reasonCode?: string;
	retry?: {
		retriesUsed: number;
		notBefore: string;
	};
}

export interface WorkerTaskView {
	taskId: string;
	title: string;
	role: WorkerRole;
	status: OrchestrationTaskStatus;
	dependsOn: readonly string[];
	verificationOfTaskId?: string;
	verificationOutcome?: {
		verifierTaskId: string;
		verdict: VerificationVerdict;
		reasonCode: string;
	};
	latestAttempt?: WorkerTaskAttemptView;
}

type VerificationVerdict = "accepted" | "rejected" | "inconclusive";

interface TaskViewCandidate {
	attemptIds: unknown;
	verification: unknown;
	taskId: string;
	title: string;
	role: WorkerRole;
	status: OrchestrationTaskStatus;
	dependsOn: readonly string[];
	createdAt: string;
	verificationOfTaskId?: string;
}

interface TaskViewSelection {
	candidate: TaskViewCandidate;
	view: WorkerTaskView;
	serializedByteLength: number;
}

export interface WorkerTaskSessionView {
	totalTasks: number;
	omittedTaskCount: number;
	tasks: readonly WorkerTaskView[];
}

function boundedString(value: unknown, maxLength: number): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function isListedValue<const Value extends string>(value: unknown, allowed: readonly Value[]): value is Value {
	return typeof value === "string" && allowed.some((candidate) => candidate === value);
}

function boundedIdentifierArray(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	const identifiers: string[] = [];
	for (let index = 0; index < Math.min(value.length, MAX_ORCHESTRATION_COLLECTION_LENGTH); index += 1) {
		const identifier = boundedString(value[index], MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		if (identifier) identifiers.push(identifier);
	}
	return identifiers;
}

function taskViewCandidate(recordTaskId: string, value: unknown): TaskViewCandidate | undefined {
	if (!isPlainRecord(value) || !isPlainRecord(value.task)) return undefined;
	if (value.task.taskId !== recordTaskId) return undefined;
	const taskId = boundedString(value.task.taskId, MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
	const title = boundedString(value.task.title, MAX_ORCHESTRATION_DESCRIPTION_LENGTH);
	const createdAt = boundedString(value.task.createdAt, MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
	if (
		!taskId ||
		!title ||
		!createdAt ||
		!isListedValue(value.task.role, WORKER_ROLES) ||
		!isListedValue(value.task.status, TASK_STATUSES)
	) {
		return undefined;
	}
	const verificationOfTaskId = boundedString(value.task.verificationOfTaskId, MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
	return {
		attemptIds: value.attemptIds,
		verification: value.verification,
		taskId,
		title,
		role: value.task.role,
		status: value.task.status,
		dependsOn: boundedIdentifierArray(value.task.dependsOn),
		createdAt,
		...(verificationOfTaskId ? { verificationOfTaskId } : {}),
	};
}

function latestExistingAttempt(snapshot: TaskRuntimeProjection, attemptIds: unknown): unknown {
	if (!Array.isArray(attemptIds)) return undefined;
	const firstInspectedIndex = Math.max(0, attemptIds.length - MAX_ORCHESTRATION_COLLECTION_LENGTH);
	for (let index = attemptIds.length - 1; index >= firstInspectedIndex; index -= 1) {
		const attemptId = attemptIds[index];
		if (typeof attemptId !== "string" || !Object.hasOwn(snapshot.attempts, attemptId)) continue;
		return snapshot.attempts[attemptId];
	}
	return undefined;
}

function projectAttempt(value: unknown): WorkerTaskAttemptView | undefined {
	if (!isPlainRecord(value) || !isListedValue(value.status, ATTEMPT_STATUSES)) return undefined;
	const dispatch = isPlainRecord(value.dispatch) ? value.dispatch : undefined;
	const agentId =
		boundedString(value.agentId, MAX_ORCHESTRATION_IDENTIFIER_LENGTH) ??
		boundedString(dispatch?.logicalLaneId, MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
	const reasonCode = boundedString(value.reasonCode, MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
	const retry = isPlainRecord(value.retry) ? value.retry : undefined;
	const retriesUsed = retry?.retriesUsed;
	const notBefore = boundedString(retry?.notBefore, MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
	const validRetry = Number.isSafeInteger(retriesUsed) && Number(retriesUsed) > 0 && notBefore;
	return {
		...(agentId ? { agentId } : {}),
		status: value.status,
		...(reasonCode ? { reasonCode } : {}),
		...(validRetry ? { retry: { retriesUsed: Number(retriesUsed), notBefore } } : {}),
	};
}

function projectVerification(value: unknown): WorkerTaskView["verificationOutcome"] {
	if (!isPlainRecord(value) || !isListedValue(value.verdict, ["accepted", "rejected", "inconclusive"] as const)) {
		return undefined;
	}
	const verifierTaskId = boundedString(value.verifierTaskId, MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
	const reasonCode = boundedString(value.reasonCode, MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
	return verifierTaskId && reasonCode ? { verifierTaskId, verdict: value.verdict, reasonCode } : undefined;
}

function projectTask(snapshot: TaskRuntimeProjection, candidate: TaskViewCandidate): WorkerTaskView {
	const attempt = projectAttempt(latestExistingAttempt(snapshot, candidate.attemptIds));
	const verificationOutcome = projectVerification(candidate.verification);
	return {
		taskId: candidate.taskId,
		title: candidate.title,
		role: candidate.role,
		status: candidate.status,
		dependsOn: candidate.dependsOn,
		...(candidate.verificationOfTaskId ? { verificationOfTaskId: candidate.verificationOfTaskId } : {}),
		...(verificationOutcome ? { verificationOutcome } : {}),
		...(attempt ? { latestAttempt: attempt } : {}),
	};
}

function compareTasksNewestFirst(left: TaskViewCandidate, right: TaskViewCandidate): number {
	return right.createdAt.localeCompare(left.createdAt) || left.taskId.localeCompare(right.taskId);
}

/** Maintain the worst retained task at index zero, without allocating for the full task history. */
function admitToNewestWindow(window: TaskViewSelection[], selection: TaskViewSelection): void {
	if (window.length < MAX_WORKER_TASK_VIEW_ENTRIES) {
		window.push(selection);
		let childIndex = window.length - 1;
		while (childIndex > 0) {
			const parentIndex = Math.floor((childIndex - 1) / 2);
			if (
				compareTasksNewestFirst(
					(window[childIndex] as TaskViewSelection).candidate,
					(window[parentIndex] as TaskViewSelection).candidate,
				) <= 0
			) {
				break;
			}
			[window[parentIndex], window[childIndex]] = [
				window[childIndex] as TaskViewSelection,
				window[parentIndex] as TaskViewSelection,
			];
			childIndex = parentIndex;
		}
		return;
	}
	if (compareTasksNewestFirst(selection.candidate, (window[0] as TaskViewSelection).candidate) >= 0) return;

	window[0] = selection;
	let parentIndex = 0;
	while (true) {
		const leftIndex = parentIndex * 2 + 1;
		if (leftIndex >= window.length) return;
		const rightIndex = leftIndex + 1;
		const worseChildIndex =
			rightIndex < window.length &&
			compareTasksNewestFirst(
				(window[rightIndex] as TaskViewSelection).candidate,
				(window[leftIndex] as TaskViewSelection).candidate,
			) > 0
				? rightIndex
				: leftIndex;
		if (
			compareTasksNewestFirst(
				(window[worseChildIndex] as TaskViewSelection).candidate,
				(window[parentIndex] as TaskViewSelection).candidate,
			) <= 0
		) {
			return;
		}
		[window[parentIndex], window[worseChildIndex]] = [
			window[worseChildIndex] as TaskViewSelection,
			window[parentIndex] as TaskViewSelection,
		];
		parentIndex = worseChildIndex;
	}
}

const MIN_WORKER_TASK_VIEW_ENVELOPE_BYTES = Buffer.byteLength(
	JSON.stringify({ totalTasks: 0, omittedTaskCount: 0, tasks: [] }),
	"utf8",
);

function serializedSessionViewByteLength(totalTasks: number, taskCount: number, taskBytes: number): number {
	const envelopeBytes = Buffer.byteLength(
		JSON.stringify({ totalTasks, omittedTaskCount: totalTasks - taskCount, tasks: [] }),
		"utf8",
	);
	return envelopeBytes + taskBytes + Math.max(0, taskCount - 1);
}

/**
 * Derive a provider-neutral, bounded team-task read model from the durable runtime projection.
 * Every returned field is selected explicitly so execution authority and provider diagnostics
 * cannot cross this read boundary through object spread.
 */
export function projectWorkerTaskSessionView(snapshot: TaskRuntimeProjection): WorkerTaskSessionView {
	let totalTasks = 0;
	const selected: TaskViewSelection[] = [];
	for (const taskId in snapshot.tasks) {
		if (!Object.hasOwn(snapshot.tasks, taskId)) continue;
		totalTasks += 1;
		const candidate = taskViewCandidate(taskId, snapshot.tasks[taskId]);
		if (!candidate) continue;
		const view = projectTask(snapshot, candidate);
		const serializedByteLength = Buffer.byteLength(JSON.stringify(view), "utf8");
		if (serializedByteLength + MIN_WORKER_TASK_VIEW_ENVELOPE_BYTES > MAX_WORKER_TASK_VIEW_BYTES) continue;
		admitToNewestWindow(selected, { candidate, view, serializedByteLength });
	}
	selected.sort((left, right) => compareTasksNewestFirst(left.candidate, right.candidate));
	const tasks: WorkerTaskView[] = [];
	let taskBytes = 0;
	for (const selection of selected) {
		const nextTaskCount = tasks.length + 1;
		const nextTaskBytes = taskBytes + selection.serializedByteLength;
		if (serializedSessionViewByteLength(totalTasks, nextTaskCount, nextTaskBytes) > MAX_WORKER_TASK_VIEW_BYTES) {
			continue;
		}
		tasks.push(selection.view);
		taskBytes = nextTaskBytes;
	}
	return {
		totalTasks,
		omittedTaskCount: totalTasks - tasks.length,
		tasks,
	};
}
