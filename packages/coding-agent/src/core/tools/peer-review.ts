import { type Static, Type } from "typebox";
import type { PeerReviewController } from "../expert-routing/peer-review.ts";
import { peerReviewRequestSchema } from "../expert-routing/peer-review.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { VerificationCoordinator } from "../system-one/verification-coordinator.ts";

const resolutionSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 256 }),
		disposition: Type.Enum(["rejected", "repaired"]),
		evidence: Type.Array(
			Type.Object(
				{
					receiptId: Type.String({ minLength: 1, maxLength: 256 }),
					role: Type.Enum(["reproduction", "repair", "recheck"]),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 16 },
		),
	},
	{
		additionalProperties: false,
		description:
			"Closes a mandatory finding after you reproduced it: rejected needs reproduction evidence; repaired needs ordered reproduction, repair and recheck receipt ids. The host checks same-lane receipts against the current candidate; prose or an executor return cannot resolve a finding. A peer_review_evidence obligation is a missing-proof gap, not a defect: reject it with one fresh current-candidate reproduction receipt of the missing source/check evidence, or evidence of a justified narrower delivery claim that retains the limitation; no test is needed unless the owner asked. Ordinary defect findings still need the normal refutation or causal-repair proof.",
	},
);

const schema = Type.Object(
	{
		action: Type.Enum([
			"options",
			"review",
			"status",
			"recover_result",
			"dispose_attempt",
			"acknowledge",
			"obligations",
			"resolve",
		]),
		review: Type.Optional(peerReviewRequestSchema),
		resolution: Type.Optional(resolutionSchema),
		attempt: Type.Optional(
			Type.Object(
				{
					reviewKey: Type.String({ minLength: 1, maxLength: 256 }),
					reason: Type.String({ minLength: 1, maxLength: 4000 }),
				},
				{ additionalProperties: false },
			),
		),
		acknowledgement: Type.Optional(
			Type.Object(
				{
					reviewKey: Type.String({ minLength: 1, maxLength: 256 }),
					evidence: Type.String({ minLength: 1, maxLength: 4000 }),
				},
				{ additionalProperties: false },
			),
		),
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
			"Plan or delivery review by a distinct host-admitted peer; the owner's /settings > Peer selection is authoritative, so omit peer and thinkingLevel to use it. Without a configured model, pick a peer from options (equal effort is allowed); selection stronger needs a listed strongerThinkingLevel. Review works without System One; stronger selection needs its task-strength judgment. status shows durable receipts, including a retainedReview whose paid result could not be saved; after fixing storage, recover_result {reviewKey, reason} saves it in its owning branch without another model call, even with the peer disabled. dispose_attempt {reviewKey, reason} releases a non-running pending or unavailable receipt after you inspect its failure (never reviewed findings, never counts as a review). With System One off, findings are advice: record your evidence and decision with acknowledge {reviewKey, evidence} (root_decision_only, not validation). With it on, obligations lists mandatory findings and host receipt ids, and resolve closes them without another peer. Unavailable or incomplete review grants no validation.",
		promptSnippet: "Peer review of uncertain plans and the final delivery (root only).",
		promptGuidelines: [
			"The peer serves the root only; workers report findings to their parent. Never chain peers.",
			"Identical requests reuse their stored result.",
			"Keep executing: reproduce every candidate in your own lane, fix confirmed failures, recheck, report rejected ones with evidence.",
			"no_findings is not an approval gate; outages and insufficient evidence stay unresolved. Never reroll an unchanged request.",
			"Completion requiring a reviewer consumes a current delivery review; a missing, stale, incomplete or unresolved one cannot satisfy it.",
		],
		parameters: schema,
		async execute(_toolCallId, input: Static<typeof schema>, signal, _onUpdate, context) {
			if (input.action === "dispose_attempt") {
				const result = input.attempt
					? await controller.disposeAttempt(input.attempt.reviewKey, input.attempt.reason, signal)
					: { status: "unavailable", reason: "attempt with reviewKey and reason is required" };
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					details: result,
					isError: result.status === "unavailable",
				};
			}
			if (input.action === "status" || input.action === "acknowledge") {
				if (input.action === "status") {
					const result = controller.status();
					return {
						content: [{ type: "text", text: JSON.stringify(result) }],
						details: result,
						isError: false,
					};
				}
				if (!input.acknowledgement) {
					const unavailable = {
						status: "unavailable" as const,
						reason: "acknowledgement with reviewKey and concrete evidence is required",
					};
					return {
						content: [{ type: "text", text: JSON.stringify(unavailable) }],
						details: unavailable,
						isError: true,
					};
				}
				try {
					const ack = await controller.acknowledge(
						input.acknowledgement.reviewKey,
						input.acknowledgement.evidence,
					);
					const closed =
						getVerification?.()?.acknowledgePeerFindings(
							input.acknowledgement.reviewKey,
							input.acknowledgement.evidence,
						) ?? [];
					const result = {
						...ack,
						closedObligationIds: closed.map((item) => item.id),
					};
					return {
						content: [{ type: "text", text: JSON.stringify(result) }],
						details: result,
						isError: false,
					};
				} catch (error) {
					const unavailable = {
						status: "unavailable" as const,
						reason: error instanceof Error ? error.message : String(error),
					};
					return {
						content: [{ type: "text", text: JSON.stringify(unavailable) }],
						details: unavailable,
						isError: true,
					};
				}
			}
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
				input.action === "recover_result"
					? input.attempt
						? await controller.recoverResult(input.attempt.reviewKey, input.attempt.reason, signal)
						: { status: "unavailable" as const, reason: "attempt with reviewKey and reason is required" }
					: input.action === "options"
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
