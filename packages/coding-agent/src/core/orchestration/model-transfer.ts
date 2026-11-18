/** Durable commands that hand the current task to a separately bound worker. */
import { isDeepStrictEqual } from "node:util";
import { conversationTurnOrigin, nativeAgentIdForAttempt } from "./attempt-agent-identity.ts";
import { latestAgentAttemptByDurableOrder } from "./attempt-ordering.ts";
import { dispatchIdentifier } from "./codec-primitives.ts";
import {
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
	type OrchestrationDispatchRequest,
	type OrchestrationModelBinding,
	type WorkerExecutionContract,
	type WorkerProfileExecutionContract,
} from "./contracts.ts";
import { exactRecord } from "./task-runtime-projection.ts";
import {
	type AttemptRuntimeState,
	attemptModelBinding,
	DurableTaskRuntimeError,
	type TaskRuntimeProjection,
	terminalAttemptStatus,
} from "./task-runtime-state.ts";

export const MAX_MODEL_TRANSFER_REFUSALS = 8;
export const MODEL_TRANSFER_INTERRUPTION = "worker_model_transfer";

export interface ModelTransferInput {
	readonly commandId: string;
	readonly sourceAgentId: string;
	readonly taskId: string;
	readonly sourceAttemptId: string;
	readonly targetModelRef: string;
}

export interface ModelTransferDispatch {
	readonly commandId: string;
	readonly sourceAttemptId: string;
	readonly successorAgentId: string;
	readonly taskId: string;
}

export interface ModelTransferRecord extends ModelTransferInput {
	readonly successorAgentId: string;
	readonly successorAttemptId: string;
	readonly status: "requested" | "successor_admitted" | "completed" | "refused";
	readonly reasonCode?: string;
	/** The successor host bound its checkout and accepted its credentials under the exact live lease. */
	readonly successorStarted?: true;
}

export function modelTransferIsPending(transfer: ModelTransferRecord | undefined): boolean {
	return transfer?.status === "requested" || transfer?.status === "successor_admitted";
}

export function assertModelTransferAllowsNewAgentTurn(basis: AttemptRuntimeState | undefined, agentId: string): void {
	if (modelTransferIsPending(basis?.modelTransfer))
		throw new DurableTaskRuntimeError(`Logical worker agent '${agentId}' is transferring its task.`);
}

export function modelTransferByCommand(
	source: AttemptRuntimeState,
	commandId: string,
): ModelTransferRecord | undefined {
	return source.modelTransfer?.commandId === commandId
		? source.modelTransfer
		: source.modelTransferRefusals?.find((transfer) => transfer.commandId === commandId);
}

export function pendingModelTransferForTask(
	state: TaskRuntimeProjection,
	taskId: string,
): ModelTransferRecord | undefined {
	const latestId = state.tasks[taskId]?.attemptIds.at(-1);
	const latest = latestId ? state.attempts[latestId] : undefined;
	const originatingSource = latest?.modelTransferSourceAttemptId
		? state.attempts[latest.modelTransferSourceAttemptId]
		: undefined;
	const transfer = latest?.modelTransfer ?? originatingSource?.modelTransfer;
	return modelTransferIsPending(transfer) ? transfer : undefined;
}

/** A source's late result cannot place another attempt while a successor owns its task. */
export function modelTransferSuppressesSourceEscalation(attempt: AttemptRuntimeState | undefined): boolean {
	return (
		attempt !== undefined &&
		(modelTransferIsPending(attempt.modelTransfer) ||
			attempt.modelTransfer?.status === "completed" ||
			isModelTransferInterrupted(attempt))
	);
}

function modelTransferBySuccessor(
	source: AttemptRuntimeState,
	successorAttemptId: string,
): ModelTransferRecord | undefined {
	return source.modelTransfer?.successorAttemptId === successorAttemptId
		? source.modelTransfer
		: source.modelTransferRefusals?.find((transfer) => transfer.successorAttemptId === successorAttemptId);
}

export function isRefusedModelTransferSuccessor(source: AttemptRuntimeState, successor: AttemptRuntimeState): boolean {
	return (
		successor.modelTransferSourceAttemptId === source.attemptId &&
		terminalAttemptStatus(successor.status) &&
		modelTransferBySuccessor(source, successor.attemptId)?.status === "refused"
	);
}

export function modelTransferFromValue(value: unknown, label: string): ModelTransferRecord {
	const raw = exactRecord(value, label, [
		"commandId",
		"sourceAgentId",
		"taskId",
		"sourceAttemptId",
		"targetModelRef",
		"successorAgentId",
		"successorAttemptId",
		"status",
		"reasonCode",
		"successorStarted",
	]);
	const identifier = (key: string) => dispatchIdentifier(raw[key], `${label}.${key}`);
	const status = raw.status;
	if (status !== "requested" && status !== "successor_admitted" && status !== "completed" && status !== "refused")
		throw new DurableTaskRuntimeError(`${label}.status is invalid.`);
	const reasonCode = raw.reasonCode === undefined ? undefined : identifier("reasonCode");
	if ((status === "refused") !== (reasonCode !== undefined))
		throw new DurableTaskRuntimeError(`${label}.reasonCode is required only for a refusal.`);
	const sourceAgentId = identifier("sourceAgentId");
	const successorAgentId = identifier("successorAgentId");
	const sourceAttemptId = identifier("sourceAttemptId");
	const successorAttemptId = identifier("successorAttemptId");
	if (sourceAgentId === successorAgentId || sourceAttemptId === successorAttemptId)
		throw new DurableTaskRuntimeError(`${label} requires distinct successor identities.`);
	const targetModelRef = raw.targetModelRef;
	const target = typeof targetModelRef === "string" ? /^([^/\s]+)\/(\S+)$/.exec(targetModelRef) : undefined;
	if (
		typeof targetModelRef !== "string" ||
		!target ||
		target[1]!.length > MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH ||
		target[2]!.length > MAX_ORCHESTRATION_MODEL_ID_LENGTH
	)
		throw new DurableTaskRuntimeError(`${label}.targetModelRef must be an exact provider/model reference.`);
	const successorStarted = raw.successorStarted;
	if (
		successorStarted !== undefined &&
		(successorStarted !== true || (status !== "successor_admitted" && status !== "completed"))
	)
		throw new DurableTaskRuntimeError(`${label}.successorStarted conflicts with its disposition.`);
	if (status === "completed" && !successorStarted)
		throw new DurableTaskRuntimeError(`${label} lacks evidence that the successor started.`);
	return {
		commandId: identifier("commandId"),
		sourceAgentId,
		taskId: identifier("taskId"),
		sourceAttemptId,
		targetModelRef,
		successorAgentId,
		successorAttemptId,
		status,
		...(reasonCode === undefined ? {} : { reasonCode }),
		...(successorStarted === true ? { successorStarted } : {}),
	};
}

export function modelTransferRefusalsFromValue(value: unknown, label: string): readonly ModelTransferRecord[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODEL_TRANSFER_REFUSALS) {
		throw new DurableTaskRuntimeError(`${label} exceeds its retained collection limit.`);
	}
	const refusals = value.map((record, index) => modelTransferFromValue(record, `${label}[${index}]`));
	if (
		refusals.some((record) => record.status !== "refused") ||
		new Set(refusals.map((record) => record.commandId)).size !== refusals.length ||
		new Set(refusals.map((record) => record.successorAttemptId)).size !== refusals.length
	)
		throw new DurableTaskRuntimeError(`${label} contains a non-refused or duplicated command.`);
	return refusals;
}

function isCurrentTaskGeneration(
	state: TaskRuntimeProjection,
	source: AttemptRuntimeState,
	attemptIds: readonly string[],
): boolean {
	const index = attemptIds.indexOf(source.attemptId);
	return (
		index >= 0 &&
		attemptIds.slice(index + 1).every((attemptId) => {
			const attempt = state.attempts[attemptId];
			return attempt !== undefined && isRefusedModelTransferSuccessor(source, attempt);
		})
	);
}

export function assertCurrentModelTransferSource(
	state: TaskRuntimeProjection,
	transfer: ModelTransferInput,
): AttemptRuntimeState {
	const source = state.attempts[transfer.sourceAttemptId];
	const task = state.tasks[transfer.taskId];
	const sourceAgent = state.agents[transfer.sourceAgentId];
	if (
		!source ||
		!task ||
		!sourceAgent ||
		sourceAgent.status === "retired" ||
		source.taskId !== transfer.taskId ||
		nativeAgentIdForAttempt(source) !== transfer.sourceAgentId ||
		!isCurrentTaskGeneration(state, source, task.attemptIds) ||
		latestAgentAttemptByDurableOrder(state, transfer.sourceAgentId)?.attemptId !== source.attemptId
	)
		throw new DurableTaskRuntimeError("Model transfer source is no longer the current worker attempt.");
	const binding = attemptModelBinding(source);
	if (!binding || `${binding.provider}/${binding.modelId}` === transfer.targetModelRef)
		throw new DurableTaskRuntimeError("Model transfer requires a different exact model from the source binding.");
	return source;
}

/** Rebind only the worker's model; the task's admitted authority and verifier remain in custody. */
export function contractForModelTransfer(
	source: WorkerExecutionContract,
	modelBinding: OrchestrationModelBinding,
): WorkerExecutionContract {
	return {
		...source,
		worker: {
			...source.worker,
			modelBinding,
			profile: { ...source.worker.profile, modelPolicy: { mode: "fixed", candidates: [modelBinding] } },
		},
	};
}

function withDirectoryCapture(
	source: WorkerProfileExecutionContract,
	captured: WorkerProfileExecutionContract | undefined,
): WorkerProfileExecutionContract {
	return source.executionContext || !captured?.executionContext
		? source
		: { ...source, executionContext: captured.executionContext };
}

function hasExactSourceAuthority(source: WorkerExecutionContract, successor: WorkerExecutionContract): boolean {
	const expected = contractForModelTransfer(source, successor.worker.modelBinding);
	return isDeepStrictEqual(
		{
			...expected,
			worker: withDirectoryCapture(expected.worker, successor.worker),
			...(expected.verifier ? { verifier: withDirectoryCapture(expected.verifier, successor.verifier) } : {}),
		},
		successor,
	);
}

export function assertModelTransferDispatch(
	state: TaskRuntimeProjection,
	source: AttemptRuntimeState,
	transfer: ModelTransferRecord,
	dispatch: OrchestrationDispatchRequest,
): void {
	const contract = dispatch.executionContract;
	const binding = contract?.worker.modelBinding;
	const sourceContract = source.dispatch.executionContract;
	const turnOrigin = conversationTurnOrigin(state, source);
	if (
		dispatch.taskId !== transfer.taskId ||
		dispatch.logicalLaneId !== transfer.successorAgentId ||
		dispatch.executionKind === "managed-process" ||
		!binding ||
		`${binding.provider}/${binding.modelId}` !== transfer.targetModelRef ||
		!contract ||
		!sourceContract ||
		!hasExactSourceAuthority(sourceContract, contract) ||
		dispatch.profileId !== source.dispatch.profileId ||
		dispatch.parentAgentId !== source.dispatch.parentAgentId ||
		(turnOrigin?.thirdParty && !isDeepStrictEqual(turnOrigin, dispatch.turnOrigin))
	)
		throw new DurableTaskRuntimeError(
			"Model transfer dispatch conflicts with its source or exact successor binding.",
		);
}

export function isModelTransferInterrupted(source: AttemptRuntimeState): boolean {
	return source.status === "cancelled" && source.reasonCode === MODEL_TRANSFER_INTERRUPTION;
}

export function assertModelTransferQuiescent(source: AttemptRuntimeState): void {
	if (!terminalAttemptStatus(source.status))
		throw new DurableTaskRuntimeError("Model transfer source has not settled.");
}

export function modelTransferAttemptFieldsFromValue(
	attempt: Record<string, unknown>,
	label: string,
): Pick<AttemptRuntimeState, "modelTransfer" | "modelTransferRefusals" | "modelTransferSourceAttemptId"> {
	const modelTransfer =
		attempt.modelTransfer === undefined
			? undefined
			: modelTransferFromValue(attempt.modelTransfer, `${label}.modelTransfer`);
	if (
		modelTransfer &&
		(modelTransfer.sourceAttemptId !== attempt.attemptId || modelTransfer.taskId !== attempt.taskId)
	)
		throw new DurableTaskRuntimeError(`${label}.modelTransfer does not identify its source attempt.`);
	return {
		...(modelTransfer ? { modelTransfer } : {}),
		...(attempt.modelTransferRefusals === undefined
			? {}
			: {
					modelTransferRefusals: modelTransferRefusalsFromValue(
						attempt.modelTransferRefusals,
						`${label}.modelTransferRefusals`,
					),
				}),
		...(attempt.modelTransferSourceAttemptId === undefined
			? {}
			: {
					modelTransferSourceAttemptId: dispatchIdentifier(
						attempt.modelTransferSourceAttemptId,
						`${label}.modelTransferSourceAttemptId`,
					),
				}),
	};
}

/** The source, command and admitted successor remain in the same task retention unit. */
export function assertModelTransferSnapshotBinding(state: TaskRuntimeProjection, attempt: AttemptRuntimeState): void {
	const transfer = attempt.modelTransfer;
	const refusals = attempt.modelTransferRefusals ?? [];
	const sourceAgentId = nativeAgentIdForAttempt(attempt);
	if (
		refusals.some(
			(refusal) =>
				!transfer ||
				refusal.commandId === transfer.commandId ||
				refusal.successorAttemptId === transfer.successorAttemptId ||
				refusal.sourceAttemptId !== attempt.attemptId ||
				refusal.taskId !== attempt.taskId ||
				refusal.sourceAgentId !== sourceAgentId,
		)
	)
		throw new DurableTaskRuntimeError("Model transfer snapshot has inconsistent refusal history.");
	if (transfer) {
		const successor = state.attempts[transfer.successorAttemptId];
		if (
			sourceAgentId !== transfer.sourceAgentId ||
			(successor && successor.modelTransferSourceAttemptId !== attempt.attemptId) ||
			((transfer.status === "successor_admitted" || transfer.status === "completed") && !successor) ||
			(transfer.status === "requested" && successor)
		)
			throw new DurableTaskRuntimeError("Model transfer snapshot has an inconsistent source command.");
	}
	if (!attempt.modelTransferSourceAttemptId) return;
	const source = state.attempts[attempt.modelTransferSourceAttemptId];
	const sourceTransfer = source && modelTransferBySuccessor(source, attempt.attemptId);
	const binding = attemptModelBinding(attempt);
	if (
		!sourceTransfer ||
		sourceTransfer.status === "requested" ||
		sourceTransfer.successorAttemptId !== attempt.attemptId ||
		sourceTransfer.taskId !== attempt.taskId ||
		nativeAgentIdForAttempt(attempt) !== sourceTransfer.successorAgentId ||
		!binding ||
		`${binding.provider}/${binding.modelId}` !== sourceTransfer.targetModelRef
	)
		throw new DurableTaskRuntimeError("Model transfer snapshot has an inconsistent successor.");
}
