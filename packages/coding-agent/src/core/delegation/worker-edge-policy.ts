/**
 * The worker policy members the parent's edge answers: its grants, the operation gate a worker's call is refused by
 * unless granted, the delivery binding, and the owner's model-pool policy. Every source is a reader or a gate built
 * from readers (`sessionEdgeGrants` over `edgeRecordsOnBranch`, `createSessionOperationGate`, `ModelPoolPolicyView`),
 * so a parent opened away composes the same members. Owner words exist only in the foreground: a host without them
 * has nothing to settle.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { EdgeGrantView } from "../autonomy/edge-policy.ts";
import type { ModelPoolPolicyView } from "../model-router/owner-model-policy.ts";
import type { OperationGate } from "../system-one/operation-gate.ts";
import type { ParentExecutionPolicy } from "./parent-execution-context.ts";

export interface WorkerEdgeSource {
	getEdgeGrants(): readonly EdgeGrantView[];
	getOperationGate(): Pick<OperationGate, "check">;
	getModelPolicy(): Pick<ModelPoolPolicyView, "allows">;
	/** Whether the model can be allocated at all (the router's pool when it is on). */
	isAllocatable(model: Model<Api>): boolean;
	/** The branch local commits are bound to, as the owner set it. */
	localCommitBranch(): string | undefined;
	/** Settles the owner's queued words; a host without owner words has none. */
	settleOwnerPolicy?(): Promise<void>;
}

export function createWorkerEdgePolicy(
	source: WorkerEdgeSource,
): Required<Pick<ParentExecutionPolicy, "getEdgeGrants" | "checkOperation" | "localCommitBranch" | "isModelAllowed">> &
	Pick<ParentExecutionPolicy, "settleOwnerPolicy"> {
	const settleOwnerPolicy = source.settleOwnerPolicy;
	return {
		getEdgeGrants: () => source.getEdgeGrants(),
		...(settleOwnerPolicy ? { settleOwnerPolicy: () => settleOwnerPolicy() } : {}),
		checkOperation: (tool, args, cwd) => source.getOperationGate().check(tool, args, cwd, "worker"),
		localCommitBranch: () => source.localCommitBranch(),
		isModelAllowed: (model) => source.getModelPolicy().allows(model) && source.isAllocatable(model),
	};
}
