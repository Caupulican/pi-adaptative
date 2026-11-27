/**
 * The fields a durable dispatch request may carry (`OrchestrationDispatchRequest`). A stored dispatch that names any other field is
 * refused on read, so a field a writer adds to the request must be added here and read by the dispatch codec in the same change.
 */

import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "../../kernel/session/agent-identity.ts";
import { readWireRecord } from "../../kernel/wire-record.ts";

/** Host-owned identity of the objective decision that submitted this one worker attempt. */
export interface ObjectiveRouteOrigin {
	readonly sessionId: string;
	readonly objectiveId: string;
	readonly cycleId: string;
	readonly executor: "worker" | "worker:escalated";
}

const originFields = new Set(["sessionId", "objectiveId", "cycleId", "executor"]);

function routeIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		!!value.trim() &&
		value.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH &&
		!value.includes("\0")
	);
}

/** The same strict optional decoder admits a new task, a mailbox replay and a stored attempt. */
export function objectiveRouteOriginFields(value: unknown): { objectiveRouteOrigin?: ObjectiveRouteOrigin } {
	if (value === undefined) return {};
	const origin = readWireRecord(value, originFields);
	if (
		!origin ||
		!routeIdentifier(origin.sessionId) ||
		!routeIdentifier(origin.objectiveId) ||
		!routeIdentifier(origin.cycleId) ||
		(origin.executor !== "worker" && origin.executor !== "worker:escalated")
	)
		throw new TypeError("Invalid objective worker route origin.");
	return {
		objectiveRouteOrigin: {
			sessionId: origin.sessionId,
			objectiveId: origin.objectiveId,
			cycleId: origin.cycleId,
			executor: origin.executor,
		},
	};
}

export function assertObjectiveRouteOwner(
	origin: ObjectiveRouteOrigin | undefined,
	sessionId: string,
	objectiveId: string | null | undefined,
): void {
	if (origin && (origin.sessionId !== sessionId || origin.objectiveId !== objectiveId))
		throw new Error("Objective worker route belongs to another session or objective.");
}

export const DISPATCH_FIELDS = new Set([
	"objectiveRouteOrigin",
	"knowledgeReferences",
	"subscriptions",
	"receiptOrigin",
	"turnOrigin",
	"taskId",
	"profileId",
	"instructions",
	"brief",
	"resourcePointerIds",
	"parentAgentId",
	"requirementIds",
	"goalRequirementKeys",
	"executionKind",
	"logicalLaneId",
	"dispatchSequence",
	"controlMessageId",
	"controlForkMode",
	"provider",
	"authorizationId",
	"worktreeLaneKey",
	"worktreeLanePath",
	"placement",
	"birthContextForkReference",
	"executionContract",
	"modelRouteSource",
	"modelPinSource",
	"senderAgentId",
]);
