import { createHash } from "node:crypto";
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
	readonly task_id?: string;
	readonly edge_type: HumanEdgeType;
	readonly request: string;
	readonly exact_authority?: string;
	readonly action_digest?: string;
	readonly reason: string;
	readonly alternatives_exhausted: readonly string[];
	readonly consequence?: string;
	readonly impact: string;
	readonly work_can_continue: boolean;
	readonly default_if_no_response?: string | null;
	readonly created_at: number;
}

export interface HumanEdgeDecision {
	readonly id: string;
	readonly request_id: string;
	readonly decision: "grant" | "deny";
	readonly exact_scope: string;
	readonly scope_type: "one_shot" | "durable";
	readonly expiry?: number;
	readonly operator_source_event_id?: string;
	readonly timestamp: number;
}

export function computeActionDigest(action: ProposedAction): string {
	const payload = JSON.stringify({
		kind: action.kind,
		targetPath: action.targetPath,
		networkRequested: action.networkRequested,
		pushRequested: action.pushRequested,
		deployRequested: action.deployRequested,
		publishRequested: action.publishRequested,
		destructiveRequested: action.destructiveRequested,
		costIncurred: action.costIncurred,
	});
	return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function buildHumanEdgeRequest(input: {
	readonly objectiveId: string;
	readonly taskId?: string;
	readonly edgeType: HumanEdgeType;
	readonly request: string;
	readonly exactAuthority?: string;
	readonly actionDigest?: string;
	readonly reason: string;
	readonly alternativesExhausted?: readonly string[];
	readonly consequence?: string;
	readonly impact?: string;
	readonly workCanContinue?: boolean;
	readonly defaultIfNoResponse?: string | null;
	readonly createdAt?: number;
}): HumanEdgeRequest {
	const id = `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	return {
		schema_version: "2.0",
		id,
		objective_id: input.objectiveId,
		task_id: input.taskId,
		edge_type: input.edgeType,
		request: input.request,
		exact_authority: input.exactAuthority,
		action_digest: input.actionDigest,
		reason: input.reason,
		alternatives_exhausted: input.alternativesExhausted ?? [],
		consequence: input.consequence,
		impact: input.impact ?? "Operation halted pending explicit operator authorization",
		work_can_continue: input.workCanContinue ?? false,
		default_if_no_response: input.defaultIfNoResponse ?? null,
		created_at: input.createdAt ?? Date.now(),
	};
}

/**
 * FIN-070..FIN-074: Durable ledger for persisting human-edge requests and operator grants/denials.
 */
export class DurableHumanEdgeLedger {
	private readonly requests: Map<string, HumanEdgeRequest>;
	private readonly decisions: Map<string, HumanEdgeDecision>;

	constructor() {
		this.requests = new Map<string, HumanEdgeRequest>();
		this.decisions = new Map<string, HumanEdgeDecision>();
	}

	recordRequest(req: HumanEdgeRequest): void {
		this.requests.set(req.id, req);
	}

	recordDecision(dec: HumanEdgeDecision): void {
		this.decisions.set(dec.id, dec);
	}

	getRequest(id: string): HumanEdgeRequest | undefined {
		return this.requests.get(id);
	}

	getDecision(id: string): HumanEdgeDecision | undefined {
		return this.decisions.get(id);
	}

	getAllRequests(): readonly HumanEdgeRequest[] {
		return Array.from(this.requests.values());
	}

	getAllDecisions(): readonly HumanEdgeDecision[] {
		return Array.from(this.decisions.values());
	}

	/**
	 * FIN-072, FIN-073, FIN-074:
	 * Checks if an action has a matching, unexpired grant.
	 * If scope_type is one_shot, consumes it.
	 * Unrelated actions do not inherit grant.
	 */
	checkAndConsumeGrant(exactScope: string, actionDigest?: string): boolean {
		const now = Date.now();
		for (const [id, dec] of this.decisions.entries()) {
			if (dec.decision !== "grant") {
				continue;
			}
			if (dec.expiry && dec.expiry < now) {
				continue;
			}
			const matches =
				dec.exact_scope === exactScope ||
				(actionDigest !== undefined && dec.exact_scope === actionDigest) ||
				(dec.exact_scope.endsWith("/*") && exactScope.startsWith(dec.exact_scope.slice(0, -2)));

			if (matches) {
				if (dec.scope_type === "one_shot") {
					this.decisions.delete(id);
				}
				return true;
			}
		}
		return false;
	}

	findActiveGrant(exactScope: string): HumanEdgeDecision | undefined {
		const now = Date.now();
		for (const dec of this.decisions.values()) {
			if (dec.decision !== "grant") continue;
			if (dec.expiry && dec.expiry < now) continue;
			if (dec.exact_scope === exactScope) return dec;
		}
		return undefined;
	}
}

/**
 * Checks if a proposed action requires a human edge interruption.
 * If within the authority envelope or matching an active durable grant, returns undefined.
 * Otherwise creates and records a structured HumanEdgeRequest.
 */
export function requiresHumanEdge(
	objectiveId: string,
	action: ProposedAction,
	envelope: AuthorityEnvelope,
	workCanContinue: boolean = false,
	ledger?: DurableHumanEdgeLedger,
	taskId?: string,
): HumanEdgeRequest | undefined {
	const validation = validateProposedAction(action, envelope);
	if (validation.allowed) {
		return undefined;
	}

	const requiredAuthority = validation.requiredAuthority ?? `Authorize action: ${action.kind}`;
	const actionDigest = computeActionDigest(action);

	// Check if ledger already holds an active grant for this specific scope
	if (ledger?.checkAndConsumeGrant(requiredAuthority, actionDigest)) {
		return undefined;
	}

	const req = buildHumanEdgeRequest({
		objectiveId,
		taskId,
		edgeType: validation.edgeType ?? "authority",
		request: requiredAuthority,
		exactAuthority: validation.requiredAuthority,
		actionDigest,
		reason: validation.reason ?? "Action crosses configured authority envelope boundaries",
		alternativesExhausted: validation.alternativesTried,
		consequence: validation.impact,
		impact: validation.impact,
		workCanContinue,
	});

	ledger?.recordRequest(req);
	return req;
}
