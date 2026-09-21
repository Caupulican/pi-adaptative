import { createHash } from "node:crypto";

export type RetentionDisposition = "keep_exact" | "keep_call_truncate_result" | "drop_pair";

export interface ToolCallResultPair {
	readonly callId: string;
	readonly toolName: string;
	readonly callMessage?: unknown;
	readonly resultMessage?: unknown;
	readonly callPayload?: unknown;
	readonly resultPayload?: unknown;
	readonly tokens?: number;
	readonly occurredAt?: string;
	readonly hasError?: boolean;
	readonly isProofObligation?: boolean;
	readonly isRecent?: boolean;
}

export interface EvidenceRetentionDecision {
	readonly callId: string;
	readonly disposition: RetentionDisposition;
	readonly keepCallProbability?: number;
	readonly keepResultProbability?: number;
	readonly artifactRef?: string;
	readonly reason?: string;
}

export interface CompactionAuditStats {
	readonly eligiblePairs: number;
	readonly pinnedPairs: number;
	readonly exactResultsKept: number;
	readonly resultsTruncated: number;
	readonly pairsRemoved: number;
	readonly artifactRefsCreated: number;
	readonly jevRequestCount: number;
	readonly failureReason?: string;
}

export interface DecisionEngineProgram {
	readonly schema_version: "2.0";
	readonly program_id: string;
	readonly description: string;
	readonly decisions: readonly unknown[];
}

export interface DecisionEngine {
	evaluate(
		program: DecisionEngineProgram,
		state?: Record<string, unknown>,
		options?: { consequence?: string; signal?: AbortSignal },
	): Promise<{
		answers?: Record<string, { type?: string; boolean?: boolean; choice?: string; value?: boolean | number }>;
		results?: Record<string, { kind?: string; confidence?: { value?: number }; selected?: unknown }>;
	}>;
}

export interface ArtifactStore {
	saveArtifact(name: string, content: string): Promise<string> | string;
}

export interface RetentionPlanningInput {
	readonly toolPairs: readonly ToolCallResultPair[];
	readonly boundedState?: Record<string, unknown>;
	readonly decisionEngine?: DecisionEngine;
	readonly isDeterministicallyPinned?: (pair: ToolCallResultPair) => boolean;
	readonly unresolvedProofObligations?: readonly string[];
	readonly preserveRecentCount?: number;
	readonly artifactStore?: ArtifactStore;
	readonly maxInlineResultBytes?: number;
	readonly signal?: AbortSignal;
}

export interface RetentionPlanningResult {
	readonly decisions: readonly EvidenceRetentionDecision[];
	readonly stats: CompactionAuditStats;
	readonly summaryEvent: string;
}

/**
 * Builds batched System One program with keep_call and keep_result questions.
 * FR-024, FR-025.
 */
export function buildRetentionProgram(pairs: readonly ToolCallResultPair[]): DecisionEngineProgram {
	const decisions: unknown[] = [];
	for (const pair of pairs) {
		decisions.push({
			id: `keep_call::${pair.callId}`,
			kind: "boolean",
			type: "noul",
			instruction: `Does knowing operation '${pair.toolName}' (id: ${pair.callId}) occurred remain useful to completing the current objective?`,
		});
		decisions.push({
			id: `keep_result::${pair.callId}`,
			kind: "boolean",
			type: "noul",
			instruction: `Does the exact result of '${pair.toolName}' (id: ${pair.callId}) remain useful enough that truncating would risk losing important proof?`,
		});
	}

	return {
		schema_version: "2.0",
		program_id: `retention_eval_${Date.now()}`,
		description: "Evidence-preserving compaction retention evaluation",
		decisions,
	};
}

/**
 * Applies conservative retention policy:
 * - uncertain => retain exact (FR-026, FR-028).
 * - keep_result clearly needed (>= 0.5) => keep_exact
 * - keep_result < 0.5, keep_call >= 0.5 => keep_call_truncate_result
 * - both < 0.5 => drop_pair
 */
export async function applyConservativeRetentionPolicy(
	pairs: readonly ToolCallResultPair[],
	evaluation:
		| {
				answers?: Record<string, { type?: string; boolean?: boolean; value?: boolean | number }>;
				results?: Record<string, { kind?: string; confidence?: { value?: number }; selected?: unknown }>;
		  }
		| undefined,
	artifactStore?: ArtifactStore,
	maxInlineResultBytes = 2048,
): Promise<{ decisions: EvidenceRetentionDecision[]; artifactRefsCreated: number }> {
	const decisions: EvidenceRetentionDecision[] = [];
	let artifactRefsCreated = 0;

	for (const pair of pairs) {
		const callKey = `keep_call::${pair.callId}`;
		const resultKey = `keep_result::${pair.callId}`;

		const callAns = evaluation?.answers?.[callKey] ?? (evaluation?.results?.[callKey] as any);
		const resultAns = evaluation?.answers?.[resultKey] ?? (evaluation?.results?.[resultKey] as any);

		const callProb =
			typeof callAns?.noul === "number"
				? callAns.noul
				: typeof callAns?.value === "number"
					? callAns.value
					: typeof callAns?.confidence?.value === "number"
						? callAns.confidence.value
						: 1.0; // Default to retain if uncertain

		const resultProb =
			typeof resultAns?.noul === "number"
				? resultAns.noul
				: typeof resultAns?.value === "number"
					? resultAns.value
					: typeof resultAns?.confidence?.value === "number"
						? resultAns.confidence.value
						: 1.0; // Default to retain if uncertain

		let disposition: RetentionDisposition;
		let artifactRef: string | undefined;

		if (resultProb >= 0.5) {
			disposition = "keep_exact";
		} else if (callProb >= 0.5) {
			disposition = "keep_call_truncate_result";
			// If result is large, store as artifact (FR-027)
			const resultStr =
				typeof pair.resultPayload === "string"
					? pair.resultPayload
					: JSON.stringify(pair.resultPayload ?? pair.resultMessage ?? "");
			if (resultStr.length > maxInlineResultBytes && artifactStore) {
				const digest = createHash("sha256").update(resultStr).digest("hex");
				const artifactName = `evidence_${pair.callId}_${digest.slice(0, 8)}.txt`;
				artifactRef = await artifactStore.saveArtifact(artifactName, resultStr);
				artifactRefsCreated++;
			}
		} else {
			disposition = "drop_pair";
		}

		decisions.push({
			callId: pair.callId,
			disposition,
			keepCallProbability: callProb,
			keepResultProbability: resultProb,
			artifactRef,
		});
	}

	return { decisions, artifactRefsCreated };
}

/**
 * EvidenceRetentionPlanner:
 * Orchestrates deterministic proof pinning, batched Jev retention assessment,
 * conservative policy application, large evidence artifactization, and durable audit stats.
 * Implements FR-020..FR-030.
 */
export class EvidenceRetentionPlanner {
	private lastStats?: CompactionAuditStats;

	getLastAuditStats(): CompactionAuditStats | undefined {
		return this.lastStats;
	}

	async plan(input: RetentionPlanningInput): Promise<RetentionPlanningResult> {
		input.signal?.throwIfAborted();

		const totalPairs = input.toolPairs.length;
		const pinnedPairsList: ToolCallResultPair[] = [];
		const eligiblePairsList: ToolCallResultPair[] = [];

		// 1. Deterministic Proof Pinning (FR-021, FR-022)
		const preserveRecentThreshold =
			input.preserveRecentCount !== undefined && input.preserveRecentCount > 0
				? Math.max(0, totalPairs - input.preserveRecentCount)
				: -1;

		for (let i = 0; i < totalPairs; i++) {
			const pair = input.toolPairs[i]!;
			const isRecent = i >= preserveRecentThreshold;
			const isPinned =
				isRecent ||
				pair.isRecent ||
				pair.hasError ||
				pair.isProofObligation ||
				Boolean(input.isDeterministicallyPinned?.(pair));

			if (isPinned) {
				pinnedPairsList.push(pair);
			} else {
				eligiblePairsList.push(pair);
			}
		}

		const pinnedDecisions: EvidenceRetentionDecision[] = pinnedPairsList.map((pair) => ({
			callId: pair.callId,
			disposition: "keep_exact",
			reason: "deterministically_pinned",
		}));

		// If no eligible pairs to prune or no decision engine, keep all exact (FR-028, FR-029)
		if (eligiblePairsList.length === 0 || !input.decisionEngine) {
			const stats: CompactionAuditStats = {
				eligiblePairs: 0,
				pinnedPairs: pinnedPairsList.length,
				exactResultsKept: totalPairs,
				resultsTruncated: 0,
				pairsRemoved: 0,
				artifactRefsCreated: 0,
				jevRequestCount: 0,
			};
			this.lastStats = stats;
			return {
				decisions: [...pinnedDecisions],
				stats,
				summaryEvent: `Context optimized · ${totalPairs} tool results → ${totalPairs} retained · proof preserved`,
			};
		}

		// 2. Batched System One Evaluation (FR-024, FR-025)
		let evaluatedDecisions: EvidenceRetentionDecision[] = [];
		let artifactRefsCount = 0;
		let failureReason: string | undefined;

		try {
			const program = buildRetentionProgram(eligiblePairsList);
			const evaluation = await input.decisionEngine.evaluate(program, input.boundedState ?? {}, {
				consequence: "medium",
				signal: input.signal,
			});

			// 3. Conservative retention policy (FR-026, FR-027)
			const outcome = await applyConservativeRetentionPolicy(
				eligiblePairsList,
				evaluation,
				input.artifactStore,
				input.maxInlineResultBytes,
			);
			evaluatedDecisions = outcome.decisions;
			artifactRefsCount = outcome.artifactRefsCreated;
		} catch (error) {
			// Jev failure never causes deletion (FR-028)
			failureReason = error instanceof Error ? error.message : String(error);
			evaluatedDecisions = eligiblePairsList.map((pair) => ({
				callId: pair.callId,
				disposition: "keep_exact",
				reason: `fallback_after_jev_error: ${failureReason}`,
			}));
		}

		const allDecisions = [...pinnedDecisions, ...evaluatedDecisions];

		let exactResultsKept = 0;
		let resultsTruncated = 0;
		let pairsRemoved = 0;

		for (const d of allDecisions) {
			if (d.disposition === "keep_exact") {
				exactResultsKept++;
			} else if (d.disposition === "keep_call_truncate_result") {
				resultsTruncated++;
			} else if (d.disposition === "drop_pair") {
				pairsRemoved++;
			}
		}

		const retainedCount = exactResultsKept + resultsTruncated;

		const stats: CompactionAuditStats = {
			eligiblePairs: eligiblePairsList.length,
			pinnedPairs: pinnedPairsList.length,
			exactResultsKept,
			resultsTruncated,
			pairsRemoved,
			artifactRefsCreated: artifactRefsCount,
			jevRequestCount: failureReason ? 0 : 1,
			failureReason,
		};
		this.lastStats = stats;

		// One-line compact operator summary event (FR-131)
		const summaryEvent = `Context optimized · ${totalPairs} tool results → ${retainedCount} retained · proof preserved`;

		return {
			decisions: allDecisions,
			stats,
			summaryEvent,
		};
	}
}
