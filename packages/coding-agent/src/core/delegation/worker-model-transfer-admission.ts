/** Revalidates the source worker's grant and checkout against the exact requested successor model. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { formatWorkerTaskFitnessFailure } from "../expert-routing/worker-task-fitness.ts";
import { conversationTurnOrigin, nativeAgentIdForAttempt } from "../orchestration/attempt-agent-identity.ts";
import { contractForModelTransfer, type ModelTransferRecord } from "../orchestration/model-transfer.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { resolveWorkerModelPin } from "../orchestration/worker-model-pins.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { boundedUtf8Text } from "../util/bounded-line.ts";
import type { WorkerAuthorityResolution, WorkerAuthorityResolutionInput } from "./worker-authority-resolver.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import { WORKER_DIRECTORY_PREFLIGHT_TIMEOUT_MS, type WorkerDirectoryAdmission } from "./worker-directory-admission.ts";
import type { WorkerAdmission, WorkerFitRoute, WorkerFitRoutePort } from "./worker-fit-route.ts";
import type { WorkerLaneIsolation } from "./worker-lane-isolation.ts";

export interface ModelTransferPreflight {
	readonly sourceAttemptId: string;
	readonly targetModelRef: string;
	readonly admission: Extract<WorkerAdmission, { ok: true }>;
}

interface ModelTransferPorts {
	port: WorkerFitRoutePort;
	fit: WorkerFitRoute;
	directories: WorkerDirectoryAdmission;
	isolation?: WorkerLaneIsolation;
	resolveTarget(
		options: Pick<WorkerAuthorityResolutionInput, "authority" | "modelPin" | "thirdParty">,
	): WorkerAuthorityResolution;
	recover(source: AttemptRuntimeState): WorkerDelegationRequest;
	treeRefusal(request: WorkerDelegationRequest, taskId: string): string | undefined;
}

/** Inherit the complete source contract, changing only its model. Apply the current explicit-model policy at both gates. */
function prepareTransfer(ports: ModelTransferPorts, source: AttemptRuntimeState, target: string) {
	const prior = source.dispatch.executionContract;
	if (!prior?.worker.authority.cwd) throw new Error("worker_transfer_source_directory_unavailable");
	const separator = target.indexOf("/");
	if (separator <= 0 || separator === target.length - 1) throw new Error("worker_transfer_invalid_model");
	const model = { provider: target.slice(0, separator), modelId: target.slice(separator + 1) };
	const policy = ports.port.settings().getWorkerModelPinPolicy();
	if (policy.status === "invalid") throw new Error("worker_model_pins_invalid");
	const turnOrigin = conversationTurnOrigin(ports.port.snapshot(), source);
	const authority = { role: prior.worker.profile.role, model };
	const request: WorkerDelegationRequest = {
		...ports.recover(source),
		authority,
		turnOrigin,
		brief: source.dispatch.brief,
		executionContext: prior.worker.executionContext,
		isolation: "shared",
		forkTurns: "none",
	};
	const pin = resolveWorkerModelPin(policy, authority.role, request);
	const targetResolution = ports.resolveTarget({
		authority,
		...(pin ? { modelPin: pin.binding } : {}),
		thirdParty: turnOrigin?.thirdParty,
	});
	if (!targetResolution.ok) throw new Error(targetResolution.reason);
	const { modelBinding, model: resolved } = targetResolution.shipment;
	if (
		resolved.provider !== model.provider ||
		resolved.id !== model.modelId ||
		!ports.port.isRouteModelAvailable(resolved)
	)
		throw new Error("worker_transfer_target_unavailable");
	const contract = contractForModelTransfer(prior, modelBinding);
	return { request, contract };
}

export async function preflightWorkerTransfer(
	ports: ModelTransferPorts,
	source: AttemptRuntimeState,
	targetModelRef: string,
): Promise<ModelTransferPreflight> {
	const { contract, request } = prepareTransfer(ports, source, targetModelRef);
	const sessionId = ports.port.sessionId();
	const signal = AbortSignal.any([
		ports.port.abortSignal(),
		AbortSignal.timeout(WORKER_DIRECTORY_PREFLIGHT_TIMEOUT_MS),
	]);
	const sourceAgentId = nativeAgentIdForAttempt(source);
	if (!sourceAgentId) throw new Error("worker_transfer_source_missing");
	await ports.isolation?.assertTransferOwner(
		contract.worker.authority.cwd!,
		sourceAgentId,
		source.modelTransfer?.status === "requested" && source.modelTransfer.targetModelRef === targetModelRef
			? source.modelTransfer.successorAgentId
			: undefined,
	);
	const captured = await ports.directories.capture(contract, sessionId, signal);
	signal.throwIfAborted();
	if (ports.port.sessionId() !== sessionId) throw new Error("worker_directory_session_changed");
	const treeRefusal = ports.treeRefusal(request, source.taskId);
	if (treeRefusal) throw new Error(treeRefusal);
	const admission = ports.port.admitNewWorker(request, captured);
	if (!admission.ok) throw new Error(admission.skipReason);
	const origin = { ...admission, modelRouteSource: "authority" as const };
	const failure = await ports.fit.check(request, origin, signal);
	signal.throwIfAborted();
	if (failure) throw new Error(formatWorkerTaskFitnessFailure(failure));
	return { sourceAttemptId: source.attemptId, targetModelRef, admission: origin };
}

export function admitWorkerTransfer(
	ports: ModelTransferPorts,
	source: AttemptRuntimeState,
	transfer: ModelTransferRecord,
	prepared: ModelTransferPreflight,
) {
	if (
		source.attemptId !== prepared.sourceAttemptId ||
		source.attemptId !== transfer.sourceAttemptId ||
		source.taskId !== transfer.taskId ||
		transfer.targetModelRef !== prepared.targetModelRef
	)
		throw new Error("worker_transfer_source_changed");
	const { request, contract } = prepareTransfer(ports, source, transfer.targetModelRef);
	if (!isDeepStrictEqual(contract.worker.modelBinding, prepared.admission.executionContract.worker.modelBinding))
		throw new Error("worker_transfer_target_changed");
	request.modelTransfer = {
		commandId: transfer.commandId,
		taskId: transfer.taskId,
		sourceAttemptId: source.attemptId,
		successorAgentId: transfer.successorAgentId,
	};
	request.executionContext = prepared.admission.executionContract.worker.executionContext;
	const admission = ports.fit.revalidateFreshStart(request, prepared.admission);
	return { request, admission };
}

/** Read a single fenced checkpoint and the source result. Keep the durable task brief intact on repeated transfers. */
export function transferTaskInstructions(
	state: TaskRuntimeProjection,
	attempt: AttemptRuntimeState,
	instructions: string,
): string {
	if (!attempt.modelTransferSourceAttemptId) return instructions;
	const source = state.attempts[attempt.modelTransferSourceAttemptId];
	if (!source) throw new Error("worker_transfer_source_missing");
	const last = source.checkpointIds.at(-1);
	const checkpoint = last ? state.checkpoints[last] : undefined;
	const result = source.result;
	const evidence = {
		reason: source.reasonCode ?? result?.reasonCode,
		requirements: source.dispatch.requirementIds?.slice(0, 6),
		criteria: state.tasks[attempt.taskId]?.task.acceptanceCriterionIds.slice(0, 6),
		failures: result?.errors.slice(0, 4).map((error) => ({ code: error.code, message: error.message.slice(0, 192) })),
		diagnostic: source.reasonDetail?.slice(0, 384),
		checkpoint: checkpoint?.summary.slice(0, 1024),
		artifactIds: checkpoint?.artifactIds.slice(0, 6),
		summary: result?.summary.slice(0, 1024),
		checkpointEvidence: checkpoint?.evidenceIds.slice(0, 6),
		evidence: result?.evidence
			.slice(0, 4)
			.map((item) => ({ id: item.evidenceId, summary: item.summary.slice(0, 192) })),
		artifacts: result?.artifacts.slice(0, 6).map((item) => item.uri.slice(0, 256)),
		nextAction: result?.nextAction?.slice(0, 384),
	};
	const id = source.attemptId;
	const nonce = createHash("sha256").update(`worker-model-transfer\0${id}`).digest("hex").slice(0, 32);
	const summary = wrapUntrustedText(boundedUtf8Text(JSON.stringify(evidence), 4096), "previous-worker", { nonce });
	return `${instructions}\n\nContinuing task ${attempt.taskId} from attempt ${id} (${source.status}). Prior worker evidence:\n${summary}`;
}
