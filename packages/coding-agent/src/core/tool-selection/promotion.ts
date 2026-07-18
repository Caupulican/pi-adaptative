/**
 * Evidence-gated tool-selection promotion (closing the observe/promote loop).
 *
 * `tool-selection-controller.ts` records, per tool call, a full expected-utility decision
 * (`ToolSelectionController.begin()`), but that per-call decision is scoped to whichever
 * tool the model already chose — only the chosen tool is ever eligible to be "recommended"
 * (see `candidateFor` in tool-selection-controller.ts), so it can validate a choice but never
 * suggest a different one. This module is the SEPARATE, aggregate read-side: given the
 * per-(model,intent,tool) track record accumulated in `ToolPerformanceStore` over many calls,
 * decide whether one tool has become the clear, evidence-backed default for a (model, intent)
 * pair — and if so, render a compact, cache-stable prompt hint.
 *
 * Reuses the exact same expected-utility gate (`decideExpectedUtility`) as call-time decisions,
 * so promotion and the call-time recommend/shortlist/abstain gate share one threshold
 * vocabulary: positive best-utility, a minimum margin over the runner-up, bounded entropy, and a
 * minimum sample count. A tool is promoted only when the gate returns "recommend"; ambiguous
 * (high-entropy/low-margin) or thin-evidence buckets never surface a hint — they stay silent,
 * which is the "shortlist on high entropy, never a false-confident pick" behavior.
 *
 * Purely functional: no store/env access, so it is trivial to unit test and never mutates state.
 * The stateful pieces (kill switches, reading the store, formatting into the live system prompt)
 * live in `tool-selection-controller.ts` and `system-prompt-builder.ts`.
 */

import {
	DEFAULT_EXPECTED_UTILITY_WEIGHTS,
	decideExpectedUtility,
	type ExpectedUtilityCandidate,
	type ExpectedUtilityWeights,
} from "./expected-utility.ts";
import type { ToolPerformanceStats, ToolSelectionIntentClass } from "./tool-performance-store.ts";

export interface ToolSelectionHint {
	modelRef: string;
	intentClass: ToolSelectionIntentClass;
	tool: string;
	sampleCount: number;
	margin: number;
	entropy: number;
}

export interface ToolPromotionDecision {
	/** The promoted tool, present only when the evidence gate returned "recommend". */
	tool?: string;
	sampleCount: number;
	margin: number;
	entropy: number;
}

function candidateFromStats(stats: ToolPerformanceStats): ExpectedUtilityCandidate {
	return {
		tool: stats.tool,
		// All candidates here were recorded under the SAME (modelRef, intentClass) bucket — the
		// write path only ever stores a tool's stats under its own classified intent (see
		// classifyToolIntent + candidateFor in tool-selection-controller.ts) — so there is no
		// per-candidate affinity prior left to apply; every candidate is equally "in scope".
		value: 1,
		alpha: stats.alpha,
		beta: stats.beta,
		sampleCount: stats.sampleCount,
		latencyMs: stats.latencyEwmaMs,
		tokenEstimate:
			stats.inputTokenEstimateEwma === undefined && stats.outputTokenEstimateEwma === undefined
				? undefined
				: (stats.inputTokenEstimateEwma ?? 0) + (stats.outputTokenEstimateEwma ?? 0),
	};
}

/**
 * Evidence-gated promotion for one (model, intentClass) bucket: which tool, if any, has become
 * the clear default given its accumulated track record. `statsForIntent` should already be
 * scoped to a single (modelRef, intentClass) — see `ToolPerformanceStore.getStatsForIntent`.
 */
export function evaluateToolPromotion(
	statsForIntent: readonly ToolPerformanceStats[],
	weights: ExpectedUtilityWeights = DEFAULT_EXPECTED_UTILITY_WEIGHTS,
): ToolPromotionDecision {
	if (statsForIntent.length === 0) {
		return { sampleCount: 0, margin: 0, entropy: 0 };
	}
	const decision = decideExpectedUtility(statsForIntent.map(candidateFromStats), weights);
	if (decision.disposition !== "recommend" || !decision.recommendation) {
		return { sampleCount: 0, margin: decision.margin, entropy: decision.entropy };
	}
	const winner = decision.ranked.find((candidate) => candidate.tool === decision.recommendation);
	return {
		tool: decision.recommendation,
		sampleCount: winner?.sampleCount ?? 0,
		margin: decision.margin,
		entropy: decision.entropy,
	};
}

/**
 * Renders the active hints into a small, stable prompt block. Deliberately omits live numbers
 * (sample counts, rates) that would change every time evidence accumulates — only the SET of
 * (intent -> tool) pairs is included, so the block's text changes only when the promoted tool for
 * an intent actually flips, not on every tool call (system-prompt cache stability).
 */
export function formatToolSelectionHints(hints: readonly ToolSelectionHint[]): string | undefined {
	if (hints.length === 0) return undefined;
	const lines = [...hints]
		.sort((left, right) => left.intentClass.localeCompare(right.intentClass))
		.map((hint) => `- ${hint.intentClass}: \`${hint.tool}\` has the established track record for this model.`);
	return [
		"Learned tool preferences (evidence-gated observation, not a directive):",
		...lines,
		"Treat as a shortlist signal only — use judgment for the actual task at hand.",
	].join("\n");
}
