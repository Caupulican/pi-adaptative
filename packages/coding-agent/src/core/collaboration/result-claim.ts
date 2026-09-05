import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { MAX_MANAGED_LANE_SUMMARY_BYTES } from "../extensions/types.ts";
import { collaborationUsageSchema } from "./launch-profile.ts";

const turnId = Type.String({ minLength: 1, maxLength: 128 });
const evidence = Type.String({ minLength: 1, maxLength: MAX_MANAGED_LANE_SUMMARY_BYTES });

function validEvidence(value: string): boolean {
	return !!value.trim() && !value.includes("\0") && Buffer.byteLength(value) <= MAX_MANAGED_LANE_SUMMARY_BYTES;
}

/** Cooperative result evidence, never proof that the native process has stopped. */
export const collaborationResultClaimSchema = Type.Object(
	{
		turnId,
		status: Type.Union([Type.Literal("done"), Type.Literal("blocked")]),
		evidence,
		usage: Type.Optional(collaborationUsageSchema),
	},
	{ additionalProperties: false },
);
export type CollaborationResultClaim = Static<typeof collaborationResultClaimSchema>;

export function validateCollaborationResultClaim(raw: unknown): CollaborationResultClaim {
	if (
		!Value.Check(collaborationResultClaimSchema, raw) ||
		!validEvidence(raw.evidence) ||
		Buffer.byteLength(JSON.stringify(raw)) > MAX_MANAGED_LANE_SUMMARY_BYTES + 2048
	)
		throw new Error("Invalid or oversized collaboration result claim.");
	return raw;
}

export const collaborationPendingQuestionSchema = Type.Object(
	{ turnId, requestId: Type.String({ minLength: 1, maxLength: 128 }), evidence },
	{ additionalProperties: false },
);
export type CollaborationPendingQuestion = Static<typeof collaborationPendingQuestionSchema>;
export type CollaborationQuestionReceipt = Pick<CollaborationPendingQuestion, "turnId" | "requestId">;

export function validateCollaborationPendingQuestion(raw: unknown): CollaborationPendingQuestion {
	if (
		!Value.Check(collaborationPendingQuestionSchema, raw) ||
		!validEvidence(raw.evidence) ||
		raw.requestId.includes("\0")
	)
		throw new Error("Invalid or oversized collaboration pending question.");
	return raw;
}
