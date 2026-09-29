import { type Static, Type } from "typebox";
import type { PeerReviewController } from "../expert-routing/peer-review.ts";
import { peerReviewRequestSchema } from "../expert-routing/peer-review.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const schema = Type.Object(
	{
		action: Type.Union([Type.Literal("options"), Type.Literal("review")]),
		review: Type.Optional(peerReviewRequestSchema),
	},
	{ additionalProperties: false },
);

export function createPeerReviewToolDefinition(controller: PeerReviewController): ToolDefinition {
	return {
		name: "peer",
		label: "Peer review",
		readOnly: true,
		description:
			"Explicit independent plan or delivery review by a distinct host-admitted peer at higher supported thinking. Options lists available peers; review asks Jev whether the selected peer is stronger for this task at >=0.95 confidence. Lead retains execution, permissions and responsibility to resolve findings. Unavailable or incomplete review grants no validation.",
		promptSnippet: "Request a stronger peer's plan or delivery review with peer.",
		promptGuidelines: [
			"When a stronger peer review is requested, call peer options and explicitly request peer review with the exact peer and a strictly higher supported thinkingLevel. Supply the complete relevant plan/change, source evidence, checks and known limitations; do not hide adverse findings.",
			"Keep executing as the lead. Reproduce every candidate in your own lane, fix confirmed failures, and recheck the revised result before affected work continues. Report rejected candidates with evidence. Peer no_findings is not a completion or approval gate. Outages and insufficient evidence remain unresolved; never reroll an unchanged request for a favorable review.",
		],
		parameters: schema,
		async execute(_toolCallId, input: Static<typeof schema>, signal) {
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
