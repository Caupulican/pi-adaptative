import { type Static, Type } from "typebox";
import type { PeerReviewController } from "../expert-routing/peer-review.ts";
import { peerReviewRequestSchema } from "../expert-routing/peer-review.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { VerificationCoordinator } from "../system-one/verification-coordinator.ts";

const resolutionSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 256 }),
		disposition: Type.Union([Type.Literal("rejected"), Type.Literal("repaired")]),
		evidence: Type.Array(
			Type.Object(
				{
					receiptId: Type.String({ minLength: 1, maxLength: 256 }),
					role: Type.Union([Type.Literal("reproduction"), Type.Literal("repair"), Type.Literal("recheck")]),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 16 },
		),
	},
	{ additionalProperties: false },
);

const schema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("options"),
			Type.Literal("review"),
			Type.Literal("obligations"),
			Type.Literal("resolve"),
		]),
		review: Type.Optional(peerReviewRequestSchema),
		resolution: Type.Optional(resolutionSchema),
	},
	{ additionalProperties: false },
);

export function createPeerReviewToolDefinition(
	controller: PeerReviewController,
	getVerification?: () => VerificationCoordinator | undefined,
): ToolDefinition {
	return {
		name: "peer",
		label: "Peer review",
		readOnly: true,
		description:
			"Explicit independent plan or delivery review by a distinct host-admitted peer at higher supported thinking. Options lists peers; review asks Jev whether the peer is stronger at >=0.95 confidence. Obligations lists pending findings and host receipts; resolve submits receiving-lane proof without another peer. Lead retains execution, permissions and responsibility. Unavailable or incomplete review grants no validation.",
		promptSnippet: "Request a stronger peer's plan or delivery review with peer.",
		promptGuidelines: [
			"When a stronger peer review is requested, call peer options and explicitly request peer review with the exact peer and a strictly higher supported thinkingLevel. Supply the complete relevant plan/change, source evidence, checks and known limitations; do not hide adverse findings.",
			"Keep executing as the lead. Reproduce every candidate in your own lane, fix confirmed failures, and recheck the revised result before affected work continues. Report rejected candidates with evidence. Peer no_findings is not a completion or approval gate. Outages and insufficient evidence remain unresolved; never reroll an unchanged request for a favorable review.",
			"Use peer obligations to inspect mandatory findings and host-recorded tool receipt IDs. After reproducing a candidate, use peer resolve with disposition rejected and reproduction evidence, or repaired with ordered reproduction, repair and recheck receipt IDs. The host checks actual same-lane evidence against the current candidate; your prose or a successful executor return cannot resolve a finding. This action uses System One and never dispatches another peer.",
		],
		parameters: schema,
		async execute(_toolCallId, input: Static<typeof schema>, signal, _onUpdate, context) {
			if (input.action === "obligations" || input.action === "resolve") {
				const verification = getVerification?.();
				const result = !verification
					? { status: "unavailable", reason: "System One verification is unavailable" }
					: input.action === "obligations"
						? verification.status()
						: input.resolution
							? await verification.resolve(input.resolution, context?.executionContext?.sessionId, signal)
							: { status: "unresolved", reason: "resolution with finding ID and host receipt IDs is required" };
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					details: result,
					isError: result.status !== "obligations" && result.status !== "resolved",
				};
			}
			const result =
				input.action === "options"
					? controller.options()
					: input.review
						? await controller.review(input.review, signal)
						: {
								status: "unavailable" as const,
								reason: "review is required; use peer options to discover eligible peers",
							};
			const { usage, ...receipt } = "usage" in result ? result : { ...result, usage: undefined };
			return {
				content: [{ type: "text" as const, text: JSON.stringify(receipt) }],
				details: receipt,
				...(usage ? { usage } : {}),
				isError: result.status === "unavailable",
			};
		},
	};
}
