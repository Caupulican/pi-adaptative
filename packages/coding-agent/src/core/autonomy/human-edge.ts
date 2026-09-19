import type { AuthorityEnvelope, ProposedAction } from "./authority-envelope.ts";
import { validateProposedAction } from "./authority-envelope.ts";

export type HumanEdgeType =
	| "authority"
	| "information"
	| "product_direction"
	| "legal_identity"
	| "financial"
	| "secret_scope"
	| "irreversible_external"
	| "semantic_gate_unavailable";

export interface HumanEdgeRequest {
	readonly schema_version: "2.0";
	readonly id: string;
	readonly objective_id: string;
	readonly edge_type: HumanEdgeType;
	readonly request: string;
	readonly reason: string;
	readonly alternatives_exhausted: readonly string[];
	readonly impact: string;
	readonly work_can_continue: boolean;
	readonly default_if_no_response?: string | null;
}

export function buildHumanEdgeRequest(input: {
	readonly objectiveId: string;
	readonly edgeType: HumanEdgeType;
	readonly request: string;
	readonly reason: string;
	readonly alternativesExhausted?: readonly string[];
	readonly impact?: string;
	readonly workCanContinue?: boolean;
	readonly defaultIfNoResponse?: string | null;
}): HumanEdgeRequest {
	const id = `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	return {
		schema_version: "2.0",
		id,
		objective_id: input.objectiveId,
		edge_type: input.edgeType,
		request: input.request,
		reason: input.reason,
		alternatives_exhausted: input.alternativesExhausted ?? [],
		impact: input.impact ?? "Operation halted pending explicit operator authorization",
		work_can_continue: input.workCanContinue ?? false,
		default_if_no_response: input.defaultIfNoResponse ?? null,
	};
}

/**
 * Checks if a proposed action requires a human edge interruption.
 * If within the authority envelope, returns undefined (no interruption).
 * If outside the authority envelope, creates a structured HumanEdgeRequest.
 */
export function requiresHumanEdge(
	objectiveId: string,
	action: ProposedAction,
	envelope: AuthorityEnvelope,
	workCanContinue: boolean = false,
): HumanEdgeRequest | undefined {
	const validation = validateProposedAction(action, envelope);
	if (validation.allowed) {
		return undefined;
	}

	return buildHumanEdgeRequest({
		objectiveId,
		edgeType: validation.edgeType ?? "authority",
		request: validation.requiredAuthority ?? `Authorize action: ${action.kind}`,
		reason: validation.reason ?? "Action crosses configured authority envelope boundaries",
		alternativesExhausted: validation.alternativesTried,
		impact: validation.impact,
		workCanContinue,
	});
}
