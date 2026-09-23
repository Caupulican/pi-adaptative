/**
 * An objective transition (JEV-024..028: completion plausibility, primary completion, the cold
 * challenge, delivery truth, release readiness) asks System One and follows the authority line: it
 * never closes on a doubt and holds on an outage. A judged certificate, pass or fail, goes back to the
 * caller, whose own branches turn a failure into repair work or a rejection. An ambiguity that
 * outlived its gather-more budget and a System One that could not judge both hold: the objective is
 * not closed and the hold names why. Nothing else is caught.
 */

import { SteeringJudgmentUnavailableError } from "../steering/system-one-steering-plane.ts";

export interface TransitionCertificate {
	readonly certificate_id: string;
	readonly semantic_outcome?: string;
	readonly failed_semantic_predicates?: readonly string[];
}

export interface TransitionCertifier<C extends TransitionCertificate> {
	requireCertificate(
		checkpoint: string,
		state: unknown,
		options: { objectiveId: string; evidenceRevision: number; signal?: AbortSignal; requirePass?: boolean },
	): Promise<C>;
}

export type TransitionJudgment<C extends TransitionCertificate> =
	| { readonly kind: "judged"; readonly certificate: C }
	| { readonly kind: "held"; readonly reasonCodes: readonly string[]; readonly certificate?: C };

export async function judgeTransition<C extends TransitionCertificate>(
	plane: TransitionCertifier<C>,
	checkpointId: string,
	state: unknown,
	options: { objectiveId: string; evidenceRevision: number; signal?: AbortSignal },
): Promise<TransitionJudgment<C>> {
	const id = checkpointId.toLowerCase().replace(/-/g, "_");
	try {
		const certificate = await plane.requireCertificate(checkpointId, state, { ...options, requirePass: false });
		if (certificate.semantic_outcome === "gather_more") {
			return {
				kind: "held",
				certificate,
				reasonCodes: ["system_one_ambiguous", `${id}_ambiguous`, ...(certificate.failed_semantic_predicates ?? [])],
			};
		}
		return { kind: "judged", certificate };
	} catch (error) {
		if (error instanceof SteeringJudgmentUnavailableError) {
			return { kind: "held", reasonCodes: ["system_one_required_but_unavailable", `${id}_unavailable`] };
		}
		throw error;
	}
}
