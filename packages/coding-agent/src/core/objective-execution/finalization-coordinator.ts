import type { TerminalCompletionProof } from "../system-one/controller.ts";
import { TerminalCompletionConflictError, TerminalHookRejectedError } from "../system-one/controller.ts";
import {
	buildDeliveryBundle,
	type DeliveryBundle,
	type DeliverySideEffects,
	type DeliveryTerminalStatus,
} from "./delivery-bundle.ts";
import { judgeTransition, type TransitionCertifier } from "./transition-judgment.ts";

export interface FinalizationCertificate {
	readonly certificate_id: string;
	readonly semantic_outcome?: string;
	readonly failed_semantic_predicates?: readonly string[];
}

/**
 * JEV-027 and the terminal store transition. No repo mutation runs here.
 * The terminal hook is a read-only notification inside commitTerminalCompletion, before complete is stored.
 */
export async function finalizeDelivery(input: {
	readonly bundle: DeliveryBundle;
	readonly sideEffects: DeliverySideEffects;
	readonly objectiveId: string;
	readonly evidenceRevision: number;
	readonly candidateDigest: string;
	readonly snapshotIdentity: DeliveryBundle["candidate_snapshot"];
	readonly steeringCertRefs: string[];
	readonly signal?: AbortSignal;
	readonly steeringPlane?: TransitionCertifier<FinalizationCertificate>;
	readonly systemOne?: {
		commitTerminalCompletion(proof: TerminalCompletionProof, options?: { signal?: AbortSignal }): Promise<void>;
	};
}): Promise<
	| { readonly status: "complete"; readonly bundle: DeliveryBundle; readonly reasonCodes: readonly string[] }
	| { readonly status: "unrecoverable"; readonly bundle: DeliveryBundle; readonly reasonCodes: readonly string[] }
	| {
			readonly status: "semantic_gate_unavailable";
			readonly bundle: DeliveryBundle;
			readonly reasonCodes: readonly string[];
	  }
> {
	let bundle = input.bundle;
	const steeringCertRefs = input.steeringCertRefs;
	if (input.steeringPlane) {
		const judgment = await judgeTransition(
			input.steeringPlane,
			"JEV-027",
			{ ...bundle, candidateSnapshot: input.snapshotIdentity },
			{ objectiveId: input.objectiveId, evidenceRevision: input.evidenceRevision, signal: input.signal },
		);
		if (judgment.certificate) steeringCertRefs.push(judgment.certificate.certificate_id);
		if (judgment.kind === "held") {
			// The side effects already ran; completion is not stored until System One judges the delivery.
			return {
				status: "semantic_gate_unavailable",
				reasonCodes: judgment.reasonCodes,
				bundle: certifiedBundle(input, bundle, steeringCertRefs, "semantic_gate_unavailable", [
					...judgment.reasonCodes,
				]),
			};
		}
		const certificate = judgment.certificate;
		if (certificate.semantic_outcome !== "pass") {
			return {
				status: "unrecoverable",
				reasonCodes: ["delivery_certificate_rejected"],
				bundle: certifiedBundle(input, bundle, steeringCertRefs, "unrecoverable", [
					"delivery_certificate_rejected",
					...(certificate.failed_semantic_predicates ?? []),
				]),
			};
		}
		bundle = certifiedBundle(input, bundle, steeringCertRefs, "complete");
	}

	if (input.systemOne?.commitTerminalCompletion) {
		try {
			await input.systemOne.commitTerminalCompletion(
				{
					objectiveId: input.objectiveId,
					candidateDigest: input.candidateDigest,
					deliveryCertificateId: steeringCertRefs[steeringCertRefs.length - 1],
					finalCommit: bundle.final_commit,
					pushRefs: bundle.push_refs,
				},
				{ signal: input.signal },
			);
		} catch (error) {
			if (error instanceof TerminalCompletionConflictError || error instanceof TerminalHookRejectedError) {
				return {
					status: "unrecoverable",
					reasonCodes: [
						"terminal_completion_rejected",
						error instanceof TerminalCompletionConflictError ? error.reason : error.message,
					],
					bundle,
				};
			}
			throw error;
		}
	}

	return { status: "complete", bundle, reasonCodes: ["completion_passed"] };
}

function certifiedBundle(
	input: {
		readonly objectiveId: string;
		readonly sideEffects: DeliverySideEffects;
		readonly snapshotIdentity: DeliveryBundle["candidate_snapshot"];
	},
	bundle: DeliveryBundle,
	steeringCertRefs: readonly string[],
	terminalStatus: DeliveryTerminalStatus,
	failedGates?: readonly string[],
): DeliveryBundle {
	return buildDeliveryBundle({
		objectiveId: input.objectiveId,
		terminalStatus,
		sourceRevision: bundle.source_revision,
		acceptance: bundle.acceptance,
		verification: bundle.verification,
		artifacts: bundle.artifacts,
		limitations: bundle.limitations,
		diffDigest: bundle.diff_digest,
		finalCommit: bundle.final_commit,
		pushRefs: bundle.push_refs,
		sideEffects: input.sideEffects,
		candidateSnapshot: input.snapshotIdentity,
		steeringCertificateRefs: steeringCertRefs,
		assuranceProfileRequested: bundle.assurance_profile_requested,
		assuranceProfileUsed: bundle.assurance_profile_used,
		decisionRefs: bundle.decision_refs,
		reviewerRefs: bundle.reviewer_refs,
		failedGates,
	});
}
