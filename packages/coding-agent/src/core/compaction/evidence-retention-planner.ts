import { createHash } from "node:crypto";
import { isNoulProbability } from "../decision/noul.ts";

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
	readonly systemOneRequestCount: number;
	readonly failureReason?: string;
}

/** A retention answer: the engine's probability that the call or its exact result is still worth keeping. */
export interface RetentionAnswer {
	readonly type?: string;
	readonly noul?: number;
	readonly probabilityTrue?: number;
}

export interface DecisionEngineProgram {
	readonly schema_version: "2.0";
	readonly program_id: string;
	readonly description: string;
	readonly decisions: readonly unknown[];
}

export interface DecisionEngine {
	/** The model behind the engine, when it is known. */
	readonly model?: string;
	evaluate(
		program: DecisionEngineProgram,
		state?: Record<string, unknown>,
		options?: { consequence?: string; signal?: AbortSignal },
	): Promise<{
		/** The model that answered, when the engine reports it. */
		model?: string;
		answers?: Record<string, RetentionAnswer>;
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

/** The retention program's stable id: the questions are fixed and point at `pairs[i]` in state. */
export const RETENTION_PROGRAM_ID = "retention_eval_v2";

/** Bounded views of one pair's result and arguments. */
const MAX_PAIR_EXCERPT_CHARS = 600;
const MAX_ARGUMENTS_EXCERPT_CHARS = 300;
/**
 * One request holds at most 12 pairs (24 questions, within the 25-question request) and 24 KiB of serialized state;
 * more pairs go to further requests, sent together.
 */
const RETENTION_PAIRS_PER_REQUEST = 12;
const RETENTION_REQUEST_STATE_BYTES = 24 * 1024;

/**
 * The advisory yes/no band (0.7 / 0.3) with its middle read as keep: a call or an exact result is let go only on a
 * settled "no longer useful" (P(keep) <= 0.3). An unanswered question keeps it too.
 */
const RETENTION_LET_GO_AT_MOST = 0.3;

/**
 * Builds batched System One program with keep_call and keep_result questions, one pair of questions per entry of
 * `pairs` in state; the ids carry the call id, the questions carry nothing but the index. FR-024, FR-025.
 */
export function buildRetentionProgram(pairs: readonly ToolCallResultPair[]): DecisionEngineProgram {
	const decisions: unknown[] = [];
	pairs.forEach((pair, index) => {
		decisions.push({
			id: `keep_call::${pair.callId}`,
			kind: "boolean",
			type: "noul",
			instruction: `Does knowing that the tool call in \`pairs[${index}]\` happened remain useful to completing the current objective?`,
		});
		decisions.push({
			id: `keep_result::${pair.callId}`,
			kind: "boolean",
			type: "noul",
			instruction: `Is the exact result of the tool call in \`pairs[${index}]\` still needed, so that truncating it would risk losing important proof? \`resultExcerpt\` shows its start and end; \`resultBytes\` is its full size.`,
		});
	});

	return {
		schema_version: "2.0",
		program_id: RETENTION_PROGRAM_ID,
		description: "Evidence-preserving compaction retention evaluation",
		decisions,
	};
}

function excerpt(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const half = Math.floor(limit / 2);
	return `${text.slice(0, half)}\n[... ${text.length - 2 * half} characters omitted ...]\n${text.slice(text.length - half)}`;
}

function payloadText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (payload === undefined) return "";
	try {
		return JSON.stringify(payload) ?? "";
	} catch {
		return String(payload);
	}
}

/** What the judge sees of a pair: its identity and flags, its result's size, and bounded views of its result and arguments. */
function retentionPairState(pair: ToolCallResultPair): Record<string, unknown> {
	const result = payloadText(pair.resultPayload ?? pair.resultMessage);
	return {
		callId: pair.callId,
		toolName: pair.toolName,
		...(pair.hasError !== undefined ? { hasError: pair.hasError } : {}),
		...(pair.isProofObligation !== undefined ? { isProofObligation: pair.isProofObligation } : {}),
		...(pair.isRecent !== undefined ? { isRecent: pair.isRecent } : {}),
		resultBytes: Buffer.byteLength(result, "utf8"),
		resultExcerpt: excerpt(result, MAX_PAIR_EXCERPT_CHARS),
		argumentsExcerpt: excerpt(payloadText(pair.callPayload), MAX_ARGUMENTS_EXCERPT_CHARS),
	};
}

/** The requests one plan sends: each the shared state plus the `pairs` it judges, within the request bounds. */
export function planRetentionRequests(
	pairs: readonly ToolCallResultPair[],
	sharedState: Record<string, unknown>,
): { pairs: ToolCallResultPair[]; state: Record<string, unknown> }[] {
	const requests: { pairs: ToolCallResultPair[]; state: Record<string, unknown> }[] = [];
	let current: { pairs: ToolCallResultPair[]; views: Record<string, unknown>[] } = { pairs: [], views: [] };
	const flush = () => {
		if (current.pairs.length === 0) return;
		requests.push({ pairs: current.pairs, state: { ...sharedState, pairs: current.views } });
		current = { pairs: [], views: [] };
	};
	for (const pair of pairs) {
		const view = retentionPairState(pair);
		const bytes = Buffer.byteLength(JSON.stringify({ ...sharedState, pairs: [...current.views, view] }), "utf8");
		if (
			current.pairs.length >= RETENTION_PAIRS_PER_REQUEST ||
			(current.pairs.length > 0 && bytes > RETENTION_REQUEST_STATE_BYTES)
		)
			flush();
		current.pairs.push(pair);
		current.views.push(view);
	}
	flush();
	return requests;
}

/** P(keep), or undefined when the question was not answered with a probability. */
function keepProbability(answer: RetentionAnswer | undefined): number | undefined {
	const probability = answer?.probabilityTrue ?? answer?.noul;
	return isNoulProbability(probability) ? probability : undefined;
}

/**
 * Applies conservative retention policy (FR-026, FR-028), on the advisory band with its middle read as keep:
 * - keep_result not settled as unneeded => keep_exact
 * - keep_result settled unneeded, keep_call not => keep_call_truncate_result
 * - both settled unneeded => drop_pair
 */
export async function applyConservativeRetentionPolicy(
	pairs: readonly ToolCallResultPair[],
	evaluation: { answers?: Record<string, RetentionAnswer> } | undefined,
	artifactStore?: ArtifactStore,
	maxInlineResultBytes = 2048,
): Promise<{ decisions: EvidenceRetentionDecision[]; artifactRefsCreated: number }> {
	const decisions: EvidenceRetentionDecision[] = [];
	let artifactRefsCreated = 0;

	for (const pair of pairs) {
		const callProb = keepProbability(evaluation?.answers?.[`keep_call::${pair.callId}`]);
		const resultProb = keepProbability(evaluation?.answers?.[`keep_result::${pair.callId}`]);
		const letGo = (probability: number | undefined) =>
			probability !== undefined && probability <= RETENTION_LET_GO_AT_MOST;

		let disposition: RetentionDisposition;
		let artifactRef: string | undefined;

		if (!letGo(resultProb)) {
			disposition = "keep_exact";
		} else if (!letGo(callProb)) {
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
			...(callProb !== undefined ? { keepCallProbability: callProb } : {}),
			...(resultProb !== undefined ? { keepResultProbability: resultProb } : {}),
			...(artifactRef !== undefined ? { artifactRef } : {}),
		});
	}

	return { decisions, artifactRefsCreated };
}

/**
 * EvidenceRetentionPlanner:
 * Orchestrates deterministic proof pinning, batched System One retention assessment,
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
				systemOneRequestCount: 0,
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
		const requests = planRetentionRequests(eligiblePairsList, {
			...(input.boundedState ?? {}),
			...(input.unresolvedProofObligations !== undefined
				? { unresolvedProofObligations: input.unresolvedProofObligations }
				: {}),
		});

		try {
			const engine = input.decisionEngine;
			const evaluations = await Promise.all(
				requests.map((request) =>
					engine.evaluate(buildRetentionProgram(request.pairs), request.state, {
						consequence: "medium",
						signal: input.signal,
					}),
				),
			);

			// 3. Conservative retention policy (FR-026, FR-027)
			const outcome = await applyConservativeRetentionPolicy(
				eligiblePairsList,
				{ answers: Object.assign({}, ...evaluations.map((evaluation) => evaluation.answers ?? {})) },
				input.artifactStore,
				input.maxInlineResultBytes,
			);
			evaluatedDecisions = outcome.decisions;
			artifactRefsCount = outcome.artifactRefsCreated;
		} catch (error) {
			// A System One failure never causes deletion (FR-028)
			failureReason = error instanceof Error ? error.message : String(error);
			evaluatedDecisions = eligiblePairsList.map((pair) => ({
				callId: pair.callId,
				disposition: "keep_exact",
				reason: `fallback_after_system_one_error: ${failureReason}`,
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
			systemOneRequestCount: failureReason ? 0 : requests.length,
			...(failureReason !== undefined ? { failureReason } : {}),
		};
		this.lastStats = stats;

		// One-line compact operator summary event (FR-131)
		const summaryEvent = failureReason
			? `Context retention unavailable · ${totalPairs} tool results retained exactly · proof preserved`
			: `Context optimized · ${totalPairs} tool results → ${retainedCount} retained · proof preserved`;

		return {
			decisions: allDecisions,
			stats,
			summaryEvent,
		};
	}
}
