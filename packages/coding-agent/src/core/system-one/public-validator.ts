/**
 * Public SemanticValidator implementation.
 * Bridges external versioned validation requests with Pi's JevAdapter and policy engine.
 *
 * Strict Rules:
 * - R-017: Expose stable SemanticValidator SDK.
 * - R-028: Private audit defaults to ids/digests.
 * - R-029: Private question body absent from default telemetry.
 * - R-030: Private state body absent from default telemetry.
 * - R-031: Secrets redacted before remote validation.
 * - R-036: Validate question structure before dispatch.
 * - R-037: Private semantics remain opaque to Pi.
 * - R-063: Full private payload debug is explicit local opt-in.
 * - R-064: Production audit is metadata/digest-first.
 */

import {
	canonicalJsonStringify,
	computeSha256,
	type IntegrityAuditRecord,
	type IntegrityStateAdapter,
	type IntegrityValidationRequest,
	type IntegrityValidationResult,
	type SemanticValidator,
	type ValidationPolicyPackQuestion,
	type ValidationPolicyProvider,
} from "../hooks/index.ts";
import type { JevAdapter } from "./adapter.ts";
import { resolveVerifiedPolicyPack } from "./policy-pack.ts";

export interface DefaultSemanticValidatorOptions {
	adapter: JevAdapter;
	provider?: string;
	policyProvider?: ValidationPolicyProvider;
	stateAdapter?: IntegrityStateAdapter;
	canaries?: readonly string[];
	canaryAction?: "redact" | "block";
	debugAudit?: boolean;
	onAuditRecord?: (record: IntegrityAuditRecord) => void;
}

export class DefaultSemanticValidator implements SemanticValidator {
	private readonly adapter: JevAdapter;
	private readonly provider: string;
	private readonly policyProvider?: ValidationPolicyProvider;
	private readonly stateAdapter?: IntegrityStateAdapter;
	private readonly canaries: readonly string[];
	private readonly canaryAction: "redact" | "block";
	private readonly debugAudit: boolean;
	private readonly onAuditRecord?: (record: IntegrityAuditRecord) => void;

	constructor(options: DefaultSemanticValidatorOptions) {
		this.adapter = options.adapter;
		this.provider = options.provider ?? "typesafe";
		this.policyProvider = options.policyProvider;
		this.stateAdapter = options.stateAdapter;
		this.canaries = options.canaries ?? [];
		this.canaryAction = options.canaryAction ?? "redact";
		this.debugAudit = options.debugAudit ?? process.env.PI_INTEGRITY_AUDIT_DEBUG === "1";
		this.onAuditRecord = options.onAuditRecord;
	}

	async evaluate(
		request: IntegrityValidationRequest,
		options?: { signal?: AbortSignal },
	): Promise<IntegrityValidationResult> {
		const startedAt = Date.now();
		options?.signal?.throwIfAborted();

		if (!request.questionIds || request.questionIds.length === 0) {
			throw new Error("IntegrityValidationRequest must specify at least one questionId");
		}

		// 1. Resolve policy pack questions
		const questionsMap: Record<string, unknown> = {};
		let policyPackDigest = request.policyPack.digest;

		if (this.policyProvider) {
			const verifiedPack = await resolveVerifiedPolicyPack(this.policyProvider, request.policyPack);
			policyPackDigest = verifiedPack.digest;
			for (const qId of request.questionIds) {
				const q = verifiedPack.questions[qId];
				if (!q) {
					throw new Error(`Question '${qId}' not declared in policy pack '${request.policyPack.id}'`);
				}
				questionsMap[qId] = {
					type: q.type,
					instruction: q.instruction,
					criteria: q.criteria,
				};
			}
		} else {
			// Without an external provider, questions must be declared in state or pre-bound
			const rawQuestions = (request.state as { questions?: Record<string, ValidationPolicyPackQuestion> })
				?.questions;
			if (rawQuestions) {
				for (const qId of request.questionIds) {
					if (rawQuestions[qId]) {
						questionsMap[qId] = rawQuestions[qId];
					}
				}
			}
		}

		if (Object.keys(questionsMap).length === 0) {
			throw new Error(`No questions could be resolved for questionIds: ${request.questionIds.join(", ")}`);
		}

		// 2. Project domain state (via stateAdapter if registered, otherwise keep raw state)
		let projectedState: unknown = request.state;
		if (this.stateAdapter) {
			projectedState = await this.stateAdapter.project({
				stage: request.stage,
				state: request.state,
				questionIds: request.questionIds,
			});
		}

		projectedState = this.processCanaries(projectedState);

		const projectionDigest = computeSha256(canonicalJsonStringify(projectedState));
		const questionDigest = computeSha256(canonicalJsonStringify(questionsMap));

		// 3. Dispatch to JevAdapter
		try {
			const response = await this.adapter.evaluate(
				{
					state: projectedState,
					questions: questionsMap,
				},
				{
					signal: options?.signal,
					impact: request.impact,
				},
			);

			const latencyMs = Date.now() - startedAt;
			const result: IntegrityValidationResult = {
				status: "ok",
				provider: this.provider,
				model: response.model,
				answers: Object.freeze(response.answers),
				projectionDigest,
				policyPackDigest,
				latencyMs,
				usage: response.usage
					? {
							inputTokens: response.usage.input_tokens,
							outputTokens: response.usage.output_tokens,
						}
					: undefined,
			};

			// 4. Record minimized audit record (R-028, R-064)
			this.emitAudit(
				request,
				{ policy: policyPackDigest, projection: projectionDigest, question: questionDigest },
				result.model,
				"ok",
				latencyMs,
				response.answers,
				result.usage,
			);
			return result;
		} catch (err) {
			const latencyMs = Date.now() - startedAt;
			const errMsg = err instanceof Error ? err.message : String(err);
			const isUnavailable =
				errMsg.includes("unavailable") ||
				errMsg.includes("ECONNREFUSED") ||
				errMsg.includes("ETIMEDOUT") ||
				errMsg.includes("rate limit");

			const status = isUnavailable ? "unavailable" : "error";
			const result: IntegrityValidationResult = {
				status,
				provider: this.provider,
				model: "unknown",
				answers: Object.freeze({}),
				projectionDigest,
				policyPackDigest,
				latencyMs,
				errorCode: errMsg,
			};

			this.emitAudit(
				request,
				{ policy: policyPackDigest, projection: projectionDigest, question: questionDigest },
				"unknown",
				status,
				latencyMs,
			);
			return result;
		}
	}

	private emitAudit(
		request: IntegrityValidationRequest,
		digests: { policy: string; projection: string; question: string },
		model: string,
		result: string,
		latencyMs: number,
		answers?: Record<string, unknown>,
		usage?: { inputTokens?: number; outputTokens?: number },
	): void {
		if (!this.onAuditRecord) return;
		const auditRecord: IntegrityAuditRecord = {
			schema_version: "1.0",
			run_id: request.runId,
			stage: request.stage,
			policy_id: request.policyPack.id,
			policy_version: request.policyPack.version,
			policy_digest: digests.policy,
			projection_digest: digests.projection,
			question_digest: digests.question,
			provider: this.provider,
			model,
			result,
			timestamp: new Date().toISOString(),
			answer_summary: answers ? Object.freeze(this.summarizeAnswers(answers)) : undefined,
			latency_ms: latencyMs,
			usage: usage ? { ...usage } : undefined,
		};
		this.onAuditRecord(auditRecord);
	}

	private processCanaries(state: unknown): unknown {
		if (this.canaries.length === 0 || state === null || state === undefined) {
			return state;
		}
		let serialized = canonicalJsonStringify(state);
		for (const canary of this.canaries) {
			if (!canary || canary.length < 4) continue;
			if (serialized.includes(canary)) {
				if (this.canaryAction === "block") {
					throw new Error("Secret canary detected in validation payload; evaluation blocked");
				}
				serialized = serialized.split(canary).join("[REDACTED_CANARY]");
			}
		}
		try {
			return JSON.parse(serialized);
		} catch {
			return serialized;
		}
	}

	/**
	 * Extract safe scalar summaries of answers without embedding full open-ended text.
	 */
	private summarizeAnswers(answers: Record<string, unknown>): Record<string, unknown> {
		const summary: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(answers)) {
			if (!v || typeof v !== "object") {
				summary[k] = v;
				continue;
			}
			const ans = v as Record<string, unknown>;
			if (ans.choice !== undefined) {
				summary[k] = { choice: ans.choice, confidence: ans.confidence };
			} else if (ans.noul !== undefined) {
				summary[k] = { noul: ans.noul };
			} else if (ans.score !== undefined) {
				summary[k] = { score: ans.score, confidence: ans.confidence };
			} else {
				summary[k] = "[complex_answer]";
			}
		}
		return summary;
	}
}
