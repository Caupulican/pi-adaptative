/**
 * Public Execution-Integrity Substrate SDK.
 * Exposes stable, generic, evidence-backed execution and semantic-validation primitives.
 *
 * Conforms to:
 * - reference/public-integrity-api.ts
 * - schemas/policy-pack.schema.json
 * - schemas/integrity-audit-record.schema.json
 * - schemas/integrity-hook-context.schema.json
 * - schemas/semantic-validation-request.schema.json
 * - schemas/semantic-validation-response.schema.json
 */

import { createHash } from "node:crypto";

export type IntegrityImpact =
	| "read_only"
	| "local_reversible"
	| "repo_mutation"
	| "external_side_effect"
	| "destructive";

export interface PolicyPackRef {
	readonly id: string;
	readonly version: string;
	readonly digest: string;
}

export interface IntegrityValidationRequest {
	readonly runId: string;
	readonly stage: string;
	readonly impact: IntegrityImpact;
	readonly policyPack: PolicyPackRef;
	readonly state: unknown;
	readonly questionIds: readonly string[];
}

export type IntegrityValidationStatus = "ok" | "unavailable" | "rejected" | "error";

export interface IntegrityValidationResult {
	readonly status: IntegrityValidationStatus;
	readonly provider: string;
	readonly model: string;
	readonly answers: Readonly<Record<string, unknown>>;
	readonly projectionDigest: string;
	readonly policyPackDigest: string;
	readonly latencyMs?: number;
	readonly usage?: {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
	};
	readonly errorCode?: string | null;
}

export interface SemanticValidator {
	evaluate(
		request: IntegrityValidationRequest,
		options?: { signal?: AbortSignal },
	): Promise<IntegrityValidationResult>;
}

export interface ValidationPolicyPackStage {
	readonly id: string;
	readonly hook: IntegrityHookName;
	readonly required: boolean;
	readonly fail_mode: "open_unavailable" | "closed";
	readonly question_ids?: readonly string[];
}

export interface ValidationPolicyPackQuestion {
	readonly type: "noul" | "choice" | "score";
	readonly instruction: string;
	readonly criteria?: unknown;
}

export interface ValidationPolicyPack {
	readonly schema_version: "1.0";
	readonly id: string;
	readonly version: string;
	readonly digest: string;
	readonly stages: readonly ValidationPolicyPackStage[];
	readonly questions: Readonly<Record<string, ValidationPolicyPackQuestion>>;
}

export interface ValidationPolicyProvider {
	getPolicyPack(ref: { id: string; version?: string }): Promise<{
		ref: PolicyPackRef;
		questions: Readonly<Record<string, unknown>>;
		stages: ReadonlyArray<unknown>;
	}>;
}

export interface IntegrityStateAdapter<TDomainState = unknown> {
	project(input: { stage: string; state: TDomainState; questionIds: readonly string[] }): Promise<unknown> | unknown;
}

export type IntegrityDecision = "allow" | "deny" | "replan" | "unavailable";

export interface IntegrityGateResult {
	readonly decision: IntegrityDecision;
	readonly reasonCodes: readonly string[];
	readonly validationRefs: readonly string[];
}

export type IntegrityHookName =
	| "session_start"
	| "resume"
	| "worker_assignment"
	| "worker_turn"
	| "before_tool"
	| "after_tool"
	| "before_mutation"
	| "after_mutation"
	| "completion_candidate"
	| "terminal";

export interface IntegrityHookContext {
	readonly schema_version: "1.0";
	readonly run_id: string;
	readonly session_id: string;
	readonly hook: IntegrityHookName;
	readonly impact: IntegrityImpact;
	readonly tool?: string | null;
	readonly evidence_ids?: readonly string[];
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface IntegrityAuditRecord {
	readonly schema_version: "1.0";
	readonly run_id: string;
	readonly stage: string;
	readonly policy_id: string;
	readonly policy_version: string;
	readonly policy_digest: string;
	readonly projection_digest: string;
	readonly question_digest: string;
	readonly provider: string;
	readonly model: string;
	readonly result: string;
	readonly timestamp: string;
	readonly answer_summary?: Readonly<Record<string, unknown>>;
	readonly latency_ms?: number | null;
	readonly usage?: Readonly<Record<string, unknown>>;
}

export interface IntegrityExtension<TDomainState = unknown> {
	readonly id: string;
	readonly policyProvider?: ValidationPolicyProvider;
	readonly stateAdapter?: IntegrityStateAdapter<TDomainState>;
	onHook?(hook: IntegrityHookName, context: IntegrityHookContext): Promise<IntegrityGateResult | undefined>;
}

/**
 * Deterministically compute canonical JSON string of a serializable object.
 */
export function canonicalJsonStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const pairs = keys
		.filter((k) => (value as Record<string, unknown>)[k] !== undefined)
		.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify((value as Record<string, unknown>)[k])}`);
	return `{${pairs.join(",")}}`;
}

export function computeSha256(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

export function computePolicyPackDigest(pack: Omit<ValidationPolicyPack, "digest"> | ValidationPolicyPack): string {
	const normalized = {
		schema_version: pack.schema_version,
		id: pack.id,
		version: pack.version,
		stages: pack.stages,
		questions: pack.questions,
	};
	return computeSha256(canonicalJsonStringify(normalized));
}

export function validatePolicyPackStructure(pack: unknown): { valid: boolean; errors: string[] } {
	const errors: string[] = [];
	if (!pack || typeof pack !== "object") {
		return { valid: false, errors: ["Policy pack must be a non-null object"] };
	}
	const p = pack as Record<string, unknown>;
	if (p.schema_version !== "1.0") {
		errors.push("schema_version must be '1.0'");
	}
	if (typeof p.id !== "string" || !p.id.trim()) {
		errors.push("id must be a non-empty string");
	}
	if (typeof p.version !== "string" || !p.version.trim()) {
		errors.push("version must be a non-empty string");
	}
	if (typeof p.digest !== "string" || !/^[a-fA-F0-9]{64}$/.test(p.digest)) {
		errors.push("digest must be a 64-character hex SHA-256 string");
	}
	if (!Array.isArray(p.stages)) {
		errors.push("stages must be an array");
	} else {
		for (let i = 0; i < p.stages.length; i++) {
			const s = p.stages[i];
			if (!s || typeof s !== "object") {
				errors.push(`stages[${i}] must be an object`);
				continue;
			}
			const stageObj = s as Record<string, unknown>;
			if (typeof stageObj.id !== "string" || !stageObj.id.trim()) {
				errors.push(`stages[${i}].id must be a non-empty string`);
			}
			const validHooks = [
				"session_start",
				"resume",
				"worker_assignment",
				"worker_turn",
				"before_tool",
				"after_tool",
				"before_mutation",
				"after_mutation",
				"completion_candidate",
				"terminal",
			];
			if (typeof stageObj.hook !== "string" || !validHooks.includes(stageObj.hook)) {
				errors.push(`stages[${i}].hook must be one of: ${validHooks.join(", ")}`);
			}
			if (typeof stageObj.required !== "boolean") {
				errors.push(`stages[${i}].required must be a boolean`);
			}
			if (stageObj.fail_mode !== "open_unavailable" && stageObj.fail_mode !== "closed") {
				errors.push(`stages[${i}].fail_mode must be 'open_unavailable' or 'closed'`);
			}
		}
	}
	if (!p.questions || typeof p.questions !== "object" || Array.isArray(p.questions)) {
		errors.push("questions must be a non-null object map");
	} else {
		for (const [qId, q] of Object.entries(p.questions as Record<string, unknown>)) {
			if (!q || typeof q !== "object") {
				errors.push(`questions.${qId} must be an object`);
				continue;
			}
			const qObj = q as Record<string, unknown>;
			if (qObj.type !== "noul" && qObj.type !== "choice" && qObj.type !== "score") {
				errors.push(`questions.${qId}.type must be 'noul', 'choice', or 'score'`);
			}
			if (typeof qObj.instruction !== "string" || !qObj.instruction.trim()) {
				errors.push(`questions.${qId}.instruction must be a non-empty string`);
			}
		}
	}
	return { valid: errors.length === 0, errors };
}
