import {
	attemptUsageIncrease,
	EMPTY_ATTEMPT_USAGE,
	providerUsageFromAttemptUsage,
	validateAttemptUsageSnapshot,
} from "../orchestration/attempt-usage.ts";
import {
	type AttemptUsageAccounting,
	beginAttemptUsageGeneration,
	reconcileAttemptUsageAccounting,
	recordAttemptGenerationUsage,
} from "../orchestration/attempt-usage-generations.ts";
import type { AttemptUsageSnapshot, OrchestrationEvent } from "../orchestration/contracts.ts";
import type { OrchestrationEventStore } from "../orchestration/event-store.ts";
import { type WorkerReceiptOrigin, workerReceiptOriginFromValue } from "../orchestration/worker-receipt-origin.ts";
import { hasReportableUsage } from "../spawned-usage.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export interface HistoricalWorkerReceipt {
	receiptId: string;
	kind: "baseline" | "increase";
	usage: AttemptUsageSnapshot;
	recordedAt: string;
}

export interface HistoricalWorkerAttempt {
	attemptId: string;
	taskId: string;
	agentId?: string;
	dispatch: { receiptOrigin?: WorkerReceiptOrigin };
	usage?: AttemptUsageSnapshot;
	accounting?: AttemptUsageAccounting;
	usageReceipts: Map<string, HistoricalWorkerReceipt>;
}

export interface HistoricalWorkerContext {
	provider: string;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
}

export interface HistoricalWorkerAccountingState {
	attempts: Map<string, HistoricalWorkerAttempt>;
	tasks: Map<string, { objectiveId: string }>;
	agents: Map<string, { resumeContext: HistoricalWorkerContext }>;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!isPlainRecord(value)) throw new Error(`Invalid archived ${label}.`);
	return value;
}

function identity(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value !== value.trim() ||
		value.length > 4096 ||
		value.includes("\0")
	)
		throw new Error(`Invalid archived ${label}.`);
	return value;
}

function usage(value: unknown): AttemptUsageSnapshot {
	return validateAttemptUsageSnapshot(record(value, "worker usage") as unknown as AttemptUsageSnapshot);
}

function context(value: unknown): HistoricalWorkerContext {
	const source = record(value, "worker context");
	return {
		provider: identity(source.provider, "worker provider"),
		sessionId: identity(source.sessionId, "worker session"),
		cwd: identity(source.cwd, "worker cwd"),
		...(source.sessionFile !== undefined ? { sessionFile: identity(source.sessionFile, "worker file") } : {}),
	};
}

function readAttempt(value: unknown): HistoricalWorkerAttempt {
	const source = record(value, "attempt");
	const dispatch = record(source.dispatch, "dispatch");
	const receipts = new Map<string, HistoricalWorkerReceipt>();
	for (const [key, raw] of Object.entries(
		source.usageReceipts === undefined ? {} : record(source.usageReceipts, "receipts"),
	)) {
		const item = record(raw, "receipt");
		const receiptId = identity(item.receiptId, "receipt identity");
		if (receiptId !== key || (item.kind !== "baseline" && item.kind !== "increase"))
			throw new Error("Invalid archived worker receipt identity.");
		receipts.set(key, {
			receiptId,
			kind: item.kind,
			usage: usage(item.usage),
			recordedAt: identity(item.recordedAt, "receipt time"),
		});
	}
	const accounting =
		source.usageAccounting === undefined
			? undefined
			: reconcileAttemptUsageAccounting(
					undefined,
					record(source.usageAccounting, "usage accounting") as unknown as AttemptUsageAccounting,
				);
	return {
		attemptId: identity(source.attemptId, "attempt identity"),
		taskId: identity(source.taskId, "task identity"),
		...(source.agentId !== undefined ? { agentId: identity(source.agentId, "agent identity") } : {}),
		dispatch: {
			...(dispatch.receiptOrigin !== undefined
				? { receiptOrigin: workerReceiptOriginFromValue(dispatch.receiptOrigin) }
				: {}),
		},
		...(accounting ? { accounting, usage: accounting.total } : {}),
		usageReceipts: receipts,
	};
}

/** Read accounting facts only. Retired execution tools/policies are never re-admitted or revalidated. */
export function readHistoricalWorkerAccountingState(store: OrchestrationEventStore): HistoricalWorkerAccountingState {
	const snapshot = store.readProjectionSnapshot();
	const state: HistoricalWorkerAccountingState = { attempts: new Map(), tasks: new Map(), agents: new Map() };
	const readTask = (raw: unknown) => {
		const task = record(raw, "task");
		state.tasks.set(identity(task.taskId, "task identity"), {
			objectiveId: identity(task.objectiveId, "objective identity"),
		});
	};
	const readAgent = (raw: unknown) => {
		const agent = record(raw, "agent");
		state.agents.set(identity(agent.agentId, "agent identity"), { resumeContext: context(agent.resumeContext) });
	};
	if (snapshot) {
		const raw = snapshot.projection;
		for (const [key, value] of Object.entries(record(raw.tasks, "tasks"))) {
			const task = record(record(value, "task state").task, "task");
			if (task.taskId !== key) throw new Error("Archived task key conflicts with its identity.");
			readTask(task);
		}
		for (const [key, value] of Object.entries(record(raw.agents, "agents"))) {
			if (record(value, "agent").agentId !== key) throw new Error("Archived agent key conflicts with its identity.");
			readAgent(value);
		}
		const checkpoints = record(raw.checkpoints, "checkpoints");
		for (const [key, value] of Object.entries(record(raw.attempts, "attempts"))) {
			const attempt = readAttempt(value);
			if (attempt.attemptId !== key) throw new Error("Archived attempt key conflicts with its identity.");
			if (!attempt.usage) {
				const ids = record(value, "attempt").checkpointIds;
				if (!Array.isArray(ids)) throw new Error("Invalid archived checkpoint identities.");
				for (const id of ids) {
					const checkpoint = checkpoints[identity(id, "checkpoint identity")];
					if (isPlainRecord(checkpoint) && checkpoint.usage !== undefined) attempt.usage = usage(checkpoint.usage);
				}
			}
			state.attempts.set(key, attempt);
		}
	}
	const events = snapshot ? store.readAfter(snapshot.throughOrdinal) : store.readAll();
	for (const event of events) applyAccountingEvent(state, event, readTask, readAgent);
	return state;
}

function applyAccountingEvent(
	state: HistoricalWorkerAccountingState,
	event: OrchestrationEvent,
	readTask: (raw: unknown) => void,
	readAgent: (raw: unknown) => void,
): void {
	const payload = event.payload;
	if (event.type === "task.created" || event.type === "task.attempt_prepared") readTask(payload.task);
	if (event.type === "agent.registered") readAgent(payload.agent);
	if (event.type === "attempt.queued" || event.type === "task.attempt_prepared") {
		const attempt = readAttempt({ ...payload, usageReceipts: {} });
		state.attempts.set(attempt.attemptId, attempt);
		return;
	}
	if (event.type === "attempt.leased") {
		const lease = record(payload.lease, "lease");
		const attempt = state.attempts.get(identity(lease.attemptId, "leased attempt"));
		if (attempt && payload.agentId !== undefined) attempt.agentId = identity(payload.agentId, "leased agent");
		return;
	}
	if (event.type === "attempt.checkpointed") {
		const checkpoint = record(payload.checkpoint, "checkpoint");
		const attempt = state.attempts.get(identity(checkpoint.attemptId, "checkpoint attempt"));
		if (attempt && !attempt.accounting && checkpoint.usage !== undefined) attempt.usage = usage(checkpoint.usage);
		return;
	}
	if (
		event.type !== "attempt.usage_registered" &&
		event.type !== "attempt.usage_recorded" &&
		event.type !== "attempt.usage_delivered"
	)
		return;
	const attempt = state.attempts.get(identity(payload.attemptId, "usage attempt"));
	if (!attempt) throw new Error("Archived usage names an unknown attempt.");
	if (event.type === "attempt.usage_delivered") {
		attempt.usageReceipts.delete(identity(payload.receiptId, "delivered receipt"));
		return;
	}
	if (!Number.isSafeInteger(payload.fencingToken) || Number(payload.fencingToken) < 1)
		throw new Error("Invalid archived usage generation fence.");
	const generation = {
		leaseId: identity(payload.leaseId, "usage lease"),
		fencingToken: payload.fencingToken as number,
	};
	const previous = attempt.accounting;
	if (event.type === "attempt.usage_recorded" && !previous) throw new Error("Archived usage generation is missing.");
	const accounting =
		event.type === "attempt.usage_registered"
			? beginAttemptUsageGeneration(
					previous,
					generation,
					payload.baseline === undefined ? undefined : usage(payload.baseline),
				)
			: recordAttemptGenerationUsage(previous!, generation, usage(payload.usage));
	const increase = attemptUsageIncrease(accounting.total, previous?.total ?? EMPTY_ATTEMPT_USAGE);
	attempt.accounting = accounting;
	attempt.usage = accounting.total;
	if (hasReportableUsage(providerUsageFromAttemptUsage(increase)))
		attempt.usageReceipts.set(event.eventId, {
			receiptId: event.eventId,
			kind: previous ? "increase" : "baseline",
			usage: increase,
			recordedAt: event.occurredAt,
		});
}
