/**
 * An objective transition (JEV-024..028: completion plausibility, primary completion, the cold
 * challenge, delivery truth, release readiness) asks System One and follows the configured authority
 * line. Received concerns and ambiguity are actionable findings for the receiving agent to verify.
 * Only an evaluator outage can be advisory; required mode retains its availability gate.
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
	| { readonly kind: "advisory"; readonly reasonCodes: readonly string[]; readonly certificate?: C }
	| { readonly kind: "held"; readonly reasonCodes: readonly string[]; readonly certificate?: C };

export async function judgeTransition<C extends TransitionCertificate>(
	plane: TransitionCertifier<C>,
	checkpointId: string,
	state: unknown,
	options: {
		objectiveId: string;
		evidenceRevision: number;
		signal?: AbortSignal;
		holdOnUnsettled?: boolean;
		onAdvisory?: (advice: string) => void;
	},
): Promise<TransitionJudgment<C>> {
	const id = checkpointId.toLowerCase().replace(/-/g, "_");
	const unsettledKind = options.holdOnUnsettled === false ? "advisory" : "held";
	let judgment: TransitionJudgment<C>;
	try {
		const { holdOnUnsettled: _holdOnUnsettled, onAdvisory: _onAdvisory, ...certificateOptions } = options;
		const certificate = await plane.requireCertificate(checkpointId, state, {
			...certificateOptions,
			requirePass: false,
		});
		judgment = { kind: "judged", certificate };
	} catch (error) {
		options.signal?.throwIfAborted();
		if (error instanceof SteeringJudgmentUnavailableError) {
			judgment = {
				kind: unsettledKind,
				reasonCodes: [
					unsettledKind === "held" ? "system_one_required_but_unavailable" : "system_one_advice_unavailable",
					`${id}_unavailable`,
				],
			};
		} else {
			throw error;
		}
	}
	if (judgment.kind === "advisory")
		options.onAdvisory?.(`Completion advice: ${judgment.reasonCodes.join(", ").slice(0, 2000)}`);
	return judgment;
}
