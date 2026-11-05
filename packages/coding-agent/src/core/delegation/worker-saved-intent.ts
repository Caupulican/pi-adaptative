import { isDeepStrictEqual } from "node:util";
import type { KnowledgeGrant, KnowledgeGrantReference } from "../memory/knowledge-grant.ts";
import { parseKnowledgeGrantReferences } from "../memory/knowledge-grant.ts";
import {
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	type WorkerExecutionContract,
	type WorkerProfileExecutionContract,
} from "../orchestration/contracts.ts";
import { isGoalObjectiveId } from "../orchestration/work-state-projection.ts";
import { parseWorkerExecutionContract } from "../orchestration/worker-execution-contract.ts";
import {
	assertWorkerReceiptAdmission,
	type WorkerReceiptOrigin,
	workerReceiptOriginFromValue,
} from "../orchestration/worker-receipt-origin.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import { selectWorkerResourcePointers } from "./worker-resource-catalog.ts";

/** Host-admitted intent. Durable references carry no copied owner knowledge or credentials. */
export interface WorkerSavedIntent {
	readonly executionContract: WorkerExecutionContract;
	readonly knowledgeReferences: readonly KnowledgeGrantReference[];
	/** null deliberately binds this task to no goal, including goals created in the future. */
	readonly objectiveId: string | null;
	readonly receiptOrigin: WorkerReceiptOrigin;
}

export function parseWorkerSavedIntent(value: unknown): WorkerSavedIntent {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["executionContract", "knowledgeReferences", "objectiveId", "receiptOrigin"]) ||
		(value.objectiveId !== null &&
			(typeof value.objectiveId !== "string" ||
				!isGoalObjectiveId(value.objectiveId) ||
				value.objectiveId.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH ||
				value.objectiveId.includes("\0")))
	)
		throw new TypeError("Saved worker intent is invalid.");
	const receiptOrigin = workerReceiptOriginFromValue(value.receiptOrigin);
	const executionContract = parseWorkerExecutionContract(value.executionContract);
	if (
		executionContract.worker.executionContext?.sessionId !== receiptOrigin.sessionId ||
		(executionContract.verifier && executionContract.verifier.executionContext?.sessionId !== receiptOrigin.sessionId)
	)
		throw new TypeError("Saved worker intent has no matching directory identity.");
	return {
		executionContract,
		knowledgeReferences: parseKnowledgeGrantReferences(value.knowledgeReferences),
		objectiveId: value.objectiveId,
		receiptOrigin,
	};
}

interface SavedIntentAdmission {
	readonly executionContract: WorkerExecutionContract;
	readonly knowledgeGrant?: KnowledgeGrant;
	readonly resourcePointerIds: readonly string[];
}

function comparableContract(contract: WorkerExecutionContract) {
	const profile = (value: WorkerProfileExecutionContract) => {
		const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = value.profile;
		return { ...value, profile: definition };
	};
	return {
		...contract,
		worker: profile(contract.worker),
		...(contract.verifier ? { verifier: profile(contract.verifier) } : {}),
	};
}

/** Capture across directory I/O, then recheck the original live grant before saving it. */
export async function captureWorkerSavedIntent(deps: {
	resolve(): SavedIntentAdmission;
	captureDirectory(contract: WorkerExecutionContract): Promise<WorkerExecutionContract>;
	objectiveId(): string | null;
	receiptOrigin: WorkerReceiptOrigin;
	assertCurrent(): void;
}): Promise<WorkerSavedIntent> {
	const objectiveId = deps.objectiveId();
	const initial = deps.resolve();
	const executionContract = await deps.captureDirectory(initial.executionContract);
	deps.assertCurrent();
	assertWorkerReceiptAdmission(deps.receiptOrigin);
	const current = deps.resolve();
	if (
		objectiveId !== deps.objectiveId() ||
		!isDeepStrictEqual(
			comparableContract(initial.executionContract),
			comparableContract(current.executionContract),
		) ||
		!isDeepStrictEqual(initial.resourcePointerIds, current.resourcePointerIds) ||
		(initial.knowledgeGrant && !initial.knowledgeGrant.isCurrent())
	)
		throw new Error("Saved worker intent changed during admission.");
	const resources = selectWorkerResourcePointers(
		executionContract.worker.resourcePointers,
		initial.resourcePointerIds,
	);
	if (!resources.ok) throw new Error(resources.reason);
	return parseWorkerSavedIntent({
		executionContract: {
			...executionContract,
			worker: { ...executionContract.worker, resourcePointers: resources.pointers },
		},
		knowledgeReferences: initial.knowledgeGrant?.references ?? [],
		objectiveId,
		receiptOrigin: deps.receiptOrigin,
	});
}
