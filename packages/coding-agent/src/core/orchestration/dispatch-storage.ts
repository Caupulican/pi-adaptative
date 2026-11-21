/**
 * Durable representations of a worker dispatch and the projection records that retain it. The runtime
 * compares and delivers plain instructions. Oversized text is stored atomically with its holder,
 * including the last dispatch a pruned agent carries forward and the corresponding retained-byte charge.
 */
import {
	type AgentBindingContract,
	MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH,
	type OrchestrationDispatchRequest,
	toJsonObject,
} from "./contracts.ts";
import { type AttemptRuntimeState, DurableTaskRuntimeError, type TaskRuntimeProjection } from "./task-runtime-state.ts";
import { encodeWorkerBrief } from "./worker-brief-attachment.ts";

export function dispatchForStorage(dispatch: OrchestrationDispatchRequest, encode = encodeWorkerBrief) {
	if (typeof dispatch.instructions !== "string")
		throw new DurableTaskRuntimeError("Dispatch instructions must be text.");
	const instructions = encode(dispatch.instructions, MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH);
	return instructions === dispatch.instructions ? dispatch : { ...dispatch, instructions };
}

function storedDispatchHolder<T extends { readonly dispatch: OrchestrationDispatchRequest }>(
	holder: T,
	encode: typeof encodeWorkerBrief,
) {
	const dispatch = dispatchForStorage(holder.dispatch, encode);
	return dispatch === holder.dispatch ? holder : { ...holder, dispatch };
}

/** A projection map and its wire record are paired for both snapshot encoding and byte accounting. */
export function projectionRecordForStorage(field: string, value: object, encode = encodeWorkerBrief): object {
	if (field === "attempts") return storedDispatchHolder(value as AttemptRuntimeState, encode);
	if (field !== "agents") return value;
	const agent = value as AgentBindingContract;
	const last = agent.prunedTurns?.last;
	if (!last) return agent;
	const stored = storedDispatchHolder(last, encode);
	return stored === last ? agent : { ...agent, prunedTurns: { ...agent.prunedTurns, last: stored } };
}

export function projectionForStorage(state: TaskRuntimeProjection) {
	const stored = {
		...state,
		agents: { ...state.agents } as Record<string, object>,
		attempts: { ...state.attempts } as Record<string, object>,
	};
	for (const field of ["agents", "attempts"] as const)
		for (const [id, record] of Object.entries(stored[field]))
			stored[field][id] = projectionRecordForStorage(field, record);
	return toJsonObject(stored);
}
