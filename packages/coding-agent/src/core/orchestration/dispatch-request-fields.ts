/**
 * The fields a durable dispatch request may carry (`OrchestrationDispatchRequest`). A stored dispatch that names any other field is
 * refused on read, so a field a writer adds to the request must be added here and read by the dispatch codec in the same change.
 */

export const DISPATCH_FIELDS = new Set([
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
