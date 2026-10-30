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
	{ additionalProperties: false },
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
			"Plan or delivery review by a distinct host-admitted peer. The owner's /settings > Peer selection is authoritative; omit peer and thinkingLevel to use configured values. With no configured model, use options to choose a peer. Ordinary review works without System One; stronger selection requires its task-strength judgment. Obligations lists pending findings and host receipts; resolve submits receiving-lane proof without another peer. Unavailable or incomplete review grants no validation.",
		promptSnippet:
			"Root-only peer: review plans with material uncertainty and the final delivery; workers report to their parent. Independent review works without System One.",
		promptGuidelines: [
			"If a paid review could not be saved, its retainedReview is visible in status while this session remains alive. After fixing storage, use recover_result with attempt {reviewKey, reason}; it saves that report in its owning branch without another model call, even when the peer is disabled or its quota is exhausted.",
			"Use dispose_attempt with attempt {reviewKey, reason} to release a non-running pending/unavailable receipt after inspecting its failure. This works with System One on or off, never disposes reviewed findings and never counts as a successful review. Active requests cannot be disposed.",
			"The peer serves the root only. Workers report findings and questions to their parent; never create recursive peer chains. Use status to inspect durable review receipts. Identical requests reuse their result; recover true is only for explicit recovery after an unavailable review's cause was addressed, never reroll a completed review.",
			"When System One is off, findings remain advice for the root. Record your evidence and decision with acknowledge and its reviewKey; this is root_decision_only, never System One validation. With System One on, use obligations and resolve. Completion requiring a reviewer consumes a current delivery review; missing, stale, incomplete, or unresolved reviews cannot satisfy that stage.",
			"A peer_review_evidence obligation is a missing-proof gap, not a confirmed defect. Resolve it with disposition rejected and one fresh current-candidate reproduction receipt containing the missing source/check evidence, or evidence of a justified narrower delivery claim that explicitly retains the limitation. No test is required unless the owner requested it. Ordinary peer_review defect findings still require the normal refutation or causal-repair proof.",
			"For ordinary independent review, use the owner's configured peer from peer options; omit peer and thinkingLevel to use it. If no model is configured, choose an exact peer from options and any listed supported thinkingLevel; equal effort is allowed. To request a stronger peer, set selection to stronger and use a listed strongerThinkingLevel. Supply the complete relevant plan/change, source evidence, checks and known limitations; do not hide adverse findings. The reviewer cannot read files: paste the source, diff or check output it must quote, because a file:line pointer alone leaves its findings unverifiable and they are dropped.",
			"Keep executing as the lead. Reproduce every candidate in your own lane, fix confirmed failures, and recheck the revised result before affected work continues. Report rejected candidates with evidence. Peer no_findings is not a completion or approval gate. Outages and insufficient evidence remain unresolved; never reroll an unchanged request for a favorable review.",
			"Use peer obligations to inspect mandatory findings and host-recorded tool receipt IDs. After reproducing a candidate, use peer resolve with disposition rejected and reproduction evidence, or repaired with ordered reproduction, repair and recheck receipt IDs. The host checks actual same-lane evidence against the current candidate; your prose or a successful executor return cannot resolve a finding. This action uses System One and never dispatches another peer.",
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
