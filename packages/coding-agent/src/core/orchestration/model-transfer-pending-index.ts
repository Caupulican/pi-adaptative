/** Derived indexes for mailbox admission and transfer replay between durable ledger projections. */
import type { OrchestrationEvent } from "./contracts.ts";
import { type ModelTransferRecord, modelTransferByCommand, modelTransferIsPending } from "./model-transfer.ts";
import type { TaskRuntimeProjection } from "./task-runtime-state.ts";

interface TransferIndex {
	pending: ReadonlyMap<string, string>;
	commands: Map<string, string>;
}
const byProjection = new WeakMap<TaskRuntimeProjection, TransferIndex>();

function commandKey(agentId: string, commandId: string): string {
	return JSON.stringify([agentId, commandId]);
}

function indexFor(state: TaskRuntimeProjection): TransferIndex {
	const cached = byProjection.get(state);
	if (cached) return cached;
	const pending = new Map<string, string>();
	const commands = new Map<string, string>();
	const add = (t: ModelTransferRecord) => commands.set(commandKey(t.sourceAgentId, t.commandId), t.sourceAttemptId);
	for (const attempt of Object.values(state.attempts)) {
		const t = attempt.modelTransfer;
		if (!t) continue;
		add(t);
		if (modelTransferIsPending(t)) pending.set(t.sourceAgentId, t.sourceAttemptId);
		for (const prior of attempt.modelTransferRefusals ?? []) add(prior);
	}
	const rebuilt = { pending, commands };
	byProjection.set(state, rebuilt);
	return rebuilt;
}

export function modelTransferPendingForAgent(state: TaskRuntimeProjection, agentId: string): boolean {
	return indexFor(state).pending.has(agentId);
}

export function pendingModelTransfers(state: TaskRuntimeProjection): ModelTransferRecord[] {
	return Array.from(indexFor(state).pending.values(), (id) => state.attempts[id]!.modelTransfer!);
}

export function retainedModelTransferCommand(
	state: TaskRuntimeProjection,
	agentId: string,
	commandId: string,
): ModelTransferRecord | undefined {
	const attemptId = indexFor(state).commands.get(commandKey(agentId, commandId));
	const attempt = attemptId && state.attempts[attemptId];
	// The append-only hint table can be shared with older snapshots. Only their own source record proves a match.
	return attempt ? modelTransferByCommand(attempt, commandId) : undefined;
}

export function carryPendingModelTransferSources(
	previous: TaskRuntimeProjection,
	next: TaskRuntimeProjection,
	event: OrchestrationEvent,
): void {
	const prior = byProjection.get(previous);
	if (!prior || event.type === "retention.pruned") return;
	if (event.type !== "model_transfer.requested" && event.type !== "model_transfer.settled") {
		byProjection.set(next, prior);
		return;
	}
	const sourceId = event.payload.sourceAttemptId;
	const t = typeof sourceId === "string" ? next.attempts[sourceId]?.modelTransfer : undefined;
	if (!t) return;
	const pending = new Map(prior.pending);
	if (modelTransferIsPending(t)) pending.set(t.sourceAgentId, t.sourceAttemptId);
	else pending.delete(t.sourceAgentId);
	const key = commandKey(t.sourceAgentId, t.commandId);
	const existing = prior.commands.get(key);
	// Divergent speculative reductions keep distinct hints for the same command. Ordinary appends share the table.
	const commands = existing && existing !== t.sourceAttemptId ? new Map(prior.commands) : prior.commands;
	commands.set(key, t.sourceAttemptId);
	byProjection.set(next, { pending, commands });
}
