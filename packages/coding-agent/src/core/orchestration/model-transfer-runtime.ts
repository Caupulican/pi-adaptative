/** Commands over the durable task ledger for an exact worker-model transfer. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { generatedWorkerTransferAgentId } from "../delegation/worker-lane-id.ts";
import { withFileLock } from "../util/atomic-file.ts";
import {
	type AppendOrchestrationEventInput,
	type AttemptLease,
	type OrchestrationDispatchRequest,
	type OrchestrationEvent,
	toJsonObject,
} from "./contracts.ts";
import {
	type ModelTransferInput,
	type ModelTransferRecord,
	modelTransferByCommand,
	modelTransferIsPending,
} from "./model-transfer.ts";
import { pendingModelTransfers, retainedModelTransferCommand } from "./model-transfer-pending-index.ts";
import { dispatchFromValue } from "./task-runtime-codecs.ts";
import { type AttemptRuntimeState, DurableTaskRuntimeError, type TaskRuntimeProjection } from "./task-runtime-state.ts";
import { assertWorkerReceiptAdmission } from "./worker-receipt-origin.ts";

interface ModelTransferPort {
	effectLockDirectory: string;
	read(): TaskRuntimeProjection;
	subscribe(listener: (aggregateId: string) => void): () => void;
	findIdempotentEvent(key: string): OrchestrationEvent | undefined;
	commit(event: AppendOrchestrationEventInput, assertAdmission?: () => void): void;
}

function commandIdentity(sourceAttemptId: string, commandId: string): string {
	return createHash("sha256")
		.update(JSON.stringify([sourceAttemptId, commandId]))
		.digest("hex");
}

function eventKey(stage: "successor" | "settled", sourceAttemptId: string, commandId: string): string {
	return `model-transfer-${stage}:${commandIdentity(sourceAttemptId, commandId)}`;
}

function requestKey(agentId: string, commandId: string): string {
	return `model-transfer-requested:${commandIdentity(agentId, commandId)}`;
}

function requireAttempt(state: TaskRuntimeProjection, attemptId: string): AttemptRuntimeState {
	const attempt = state.attempts[attemptId];
	if (!attempt) throw new DurableTaskRuntimeError(`Unknown model transfer attempt '${attemptId}'.`);
	return attempt;
}

export class ModelTransferRuntime {
	private readonly port: ModelTransferPort;

	constructor(port: ModelTransferPort) {
		this.port = port;
	}

	/** Persist the exact requested target and reserve successor identities before any interruption. */
	request(input: ModelTransferInput): ModelTransferRecord {
		const prior = this.findSourceCommand(input.sourceAgentId, input.commandId);
		if (prior) {
			if (
				prior.commandId !== input.commandId ||
				prior.sourceAgentId !== input.sourceAgentId ||
				prior.targetModelRef !== input.targetModelRef
			)
				throw new DurableTaskRuntimeError("Model transfer request conflicts with the retained command.");
			return structuredClone(prior);
		}
		this.port.read();
		const identity = commandIdentity(input.sourceAttemptId, input.commandId);
		this.port.commit({
			type: "model_transfer.requested",
			aggregateId: input.taskId,
			actor: "runtime",
			idempotencyKey: requestKey(input.sourceAgentId, input.commandId),
			payload: toJsonObject({
				commandId: input.commandId,
				sourceAgentId: input.sourceAgentId,
				taskId: input.taskId,
				sourceAttemptId: input.sourceAttemptId,
				targetModelRef: input.targetModelRef,
				successorAgentId: generatedWorkerTransferAgentId(identity),
				successorAttemptId: `attempt-transfer-${identity}`,
				status: "requested",
			}),
		});
		return structuredClone(
			modelTransferByCommand(requireAttempt(this.port.read(), input.sourceAttemptId), input.commandId)!,
		);
	}

	findSourceCommand(agentId: string, commandId: string): ModelTransferRecord | undefined {
		const event = this.port.findIdempotentEvent(requestKey(agentId, commandId));
		const state = this.port.read();
		if (event) {
			const sourceId = event.payload.sourceAttemptId;
			const source = typeof sourceId === "string" ? state.attempts[sourceId] : undefined;
			const record = source && modelTransferByCommand(source, commandId);
			if (event.type !== "model_transfer.requested" || record?.sourceAgentId !== agentId)
				throw new DurableTaskRuntimeError("The original model transfer command is no longer retained.");
			return structuredClone(record);
		}
		// The bounded journal index may evict a key while the source task is still retained.
		const retained = retainedModelTransferCommand(state, agentId, commandId);
		return retained && structuredClone(retained);
	}

	subscribe(listener: (aggregateId: string) => void): () => void {
		return this.port.subscribe(listener);
	}

	/** Serialize checkout changes and task admission across controllers recovering the same attempt. */
	withEffectsLock(sourceAttemptId: string, effect: () => Promise<void>): Promise<void> {
		const key = createHash("sha256").update(sourceAttemptId).digest("hex");
		return withFileLock(join(this.port.effectLockDirectory, `model-transfer-${key}`), effect);
	}

	listPending(): ModelTransferRecord[] {
		return pendingModelTransfers(this.port.read());
	}

	/** Queue the reserved successor on the same task under the normal attempt budget and dependency rules. */
	admit(
		taskId: string,
		sourceAttemptId: string,
		commandId: string,
		dispatch: OrchestrationDispatchRequest,
	): AttemptRuntimeState {
		const state = this.port.read();
		const transfer = modelTransferByCommand(requireAttempt(state, sourceAttemptId), commandId);
		if (!transfer || transfer.taskId !== taskId || transfer.status === "refused")
			throw new DurableTaskRuntimeError("Model transfer is unavailable for successor admission.");
		const normalized = dispatchFromValue(dispatch, "model transfer dispatch");
		if (transfer.status !== "requested") {
			const successor = requireAttempt(state, transfer.successorAttemptId);
			if (!isDeepStrictEqual(successor.dispatch, normalized))
				throw new DurableTaskRuntimeError("Model transfer successor dispatch has conflicting content.");
			return structuredClone(successor);
		}
		this.port.commit(
			{
				type: "model_transfer.successor_admitted",
				aggregateId: taskId,
				actor: "runtime",
				idempotencyKey: eventKey("successor", sourceAttemptId, commandId),
				payload: toJsonObject({ sourceAttemptId, commandId, dispatch: normalized }),
			},
			() => assertWorkerReceiptAdmission(dispatch.receiptOrigin),
		);
		return structuredClone(requireAttempt(this.port.read(), transfer.successorAttemptId));
	}

	/** The native host accepted its transferred run after checkout binding and credential setup. */
	acceptSuccessorStart(lease: Pick<AttemptLease, "attemptId" | "leaseId" | "fencingToken">): void {
		const state = this.port.read();
		const successor = requireAttempt(state, lease.attemptId);
		const sourceId = successor.modelTransferSourceAttemptId;
		const transfer = sourceId ? state.attempts[sourceId]?.modelTransfer : undefined;
		if (!transfer || transfer.successorAttemptId !== lease.attemptId)
			throw new DurableTaskRuntimeError("Model transfer acceptance has no matching source command.");
		if (transfer.successorStarted) return;
		this.port.commit({
			type: "model_transfer.successor_accepted",
			aggregateId: transfer.taskId,
			actor: "runtime",
			idempotencyKey: `model-transfer-accepted:${lease.attemptId}`,
			payload: toJsonObject({
				attemptId: lease.attemptId,
				leaseId: lease.leaseId,
				fencingToken: lease.fencingToken,
			}),
		});
	}

	settle(
		taskId: string,
		sourceAttemptId: string,
		commandId: string,
		status: "completed" | "refused",
		reasonCode?: string,
	): ModelTransferRecord {
		const state = this.port.read();
		const transfer = modelTransferByCommand(requireAttempt(state, sourceAttemptId), commandId);
		if (!transfer || transfer.taskId !== taskId)
			throw new DurableTaskRuntimeError("Model transfer command is unavailable.");
		if (!modelTransferIsPending(transfer)) {
			if (transfer.status !== status || transfer.reasonCode !== reasonCode)
				throw new DurableTaskRuntimeError("Model transfer already has a different disposition.");
			return structuredClone(transfer);
		}
		this.port.commit({
			type: "model_transfer.settled",
			aggregateId: taskId,
			actor: "runtime",
			idempotencyKey: eventKey("settled", sourceAttemptId, commandId),
			payload: toJsonObject({
				sourceAttemptId,
				commandId,
				status,
				...(reasonCode === undefined ? {} : { reasonCode }),
			}),
		});
		return structuredClone(modelTransferByCommand(requireAttempt(this.port.read(), sourceAttemptId), commandId)!);
	}
}
