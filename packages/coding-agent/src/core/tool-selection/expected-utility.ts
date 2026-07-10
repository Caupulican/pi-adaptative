export interface ExpectedUtilityWeights {
	latency: number;
	tokens: number;
	risk: number;
	context: number;
	latencyScaleMs: number;
	tokenScale: number;
	minimumEvidence: number;
	minimumMargin: number;
	highEntropy: number;
}

export const DEFAULT_EXPECTED_UTILITY_WEIGHTS: ExpectedUtilityWeights = {
	latency: 0.15,
	tokens: 0.1,
	risk: 0.2,
	context: 0.1,
	latencyScaleMs: 5_000,
	tokenScale: 1_000,
	minimumEvidence: 3,
	minimumMargin: 0.1,
	highEntropy: 0.85,
};

export interface ExpectedUtilityCandidate {
	tool: string;
	value: number;
	alpha: number;
	beta: number;
	sampleCount: number;
	latencyMs?: number;
	tokenEstimate?: number;
	riskCost?: number;
	contextCost?: number;
	deterministicMatch?: boolean;
	/** Candidates with unresolved paths may be observed/shortlisted but never recommended. */
	automaticEligible?: boolean;
	/** `no_tool` uses a known probability rather than a learned posterior. */
	successProbability?: number;
}

export interface RankedToolCandidate extends ExpectedUtilityCandidate {
	successProbability: number;
	latencyCost: number;
	tokenCost: number;
	riskCost: number;
	contextCost: number;
	utility: number;
	probability: number;
}

export type ToolSelectionDisposition = "recommend" | "shortlist" | "abstain";

export interface ToolSelectionDecision {
	disposition: ToolSelectionDisposition;
	recommendation?: string;
	shortlist: string[];
	entropy: number;
	margin: number;
	ranked: RankedToolCandidate[];
}

function clampUnit(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function betaSuccessProbability(alpha: number, beta: number): number {
	const positiveAlpha = Math.max(0, finiteOr(alpha, 0));
	const positiveBeta = Math.max(0, finiteOr(beta, 0));
	const total = positiveAlpha + positiveBeta;
	return total > 0 ? positiveAlpha / total : 0.5;
}

export function normalizedEntropy(probabilities: readonly number[]): number {
	if (probabilities.length <= 1) return 0;
	const positive = probabilities.filter((probability) => probability > 0 && Number.isFinite(probability));
	if (positive.length === 0) return 0;
	const entropy = -positive.reduce((total, probability) => total + probability * Math.log(probability), 0);
	return entropy <= 0 ? 0 : entropy / Math.log(probabilities.length);
}

function softmax(utilities: readonly number[]): number[] {
	if (utilities.length === 0) return [];
	const maximum = Math.max(...utilities);
	const exponentials = utilities.map((utility) => Math.exp(Math.max(-60, utility - maximum)));
	const total = exponentials.reduce((sum, value) => sum + value, 0);
	return total > 0 ? exponentials.map((value) => value / total) : utilities.map(() => 1 / utilities.length);
}

export function rankExpectedUtilityCandidates(
	candidates: readonly ExpectedUtilityCandidate[],
	weights: ExpectedUtilityWeights = DEFAULT_EXPECTED_UTILITY_WEIGHTS,
): RankedToolCandidate[] {
	const unranked = candidates.map((candidate) => {
		const successProbability = clampUnit(
			candidate.successProbability ?? betaSuccessProbability(candidate.alpha, candidate.beta),
		);
		const latencyCost = clampUnit(finiteOr(candidate.latencyMs, 0) / Math.max(1, weights.latencyScaleMs));
		const tokenCost = clampUnit(finiteOr(candidate.tokenEstimate, 0) / Math.max(1, weights.tokenScale));
		const riskCost = clampUnit(finiteOr(candidate.riskCost, 0));
		const contextCost = clampUnit(finiteOr(candidate.contextCost, 0));
		const utility =
			successProbability * clampUnit(candidate.value) -
			weights.latency * latencyCost -
			weights.tokens * tokenCost -
			weights.risk * riskCost -
			weights.context * contextCost;
		return { ...candidate, successProbability, latencyCost, tokenCost, riskCost, contextCost, utility };
	});
	const probabilities = softmax(unranked.map((candidate) => candidate.utility));
	return unranked
		.map((candidate, index) => ({ ...candidate, probability: probabilities[index] ?? 0 }))
		.sort((left, right) => right.utility - left.utility || left.tool.localeCompare(right.tool));
}

export function decideExpectedUtility(
	candidates: readonly ExpectedUtilityCandidate[],
	weights: ExpectedUtilityWeights = DEFAULT_EXPECTED_UTILITY_WEIGHTS,
): ToolSelectionDecision {
	const ranked = rankExpectedUtilityCandidates(candidates, weights);
	const best = ranked[0];
	const runnerUp = ranked[1];
	const entropy = normalizedEntropy(ranked.map((candidate) => candidate.probability));
	const margin = best && runnerUp ? best.utility - runnerUp.utility : (best?.utility ?? 0);
	const shortlist = ranked.slice(0, 3).map((candidate) => candidate.tool);
	if (!best || best.utility <= 0) {
		return { disposition: "abstain", shortlist: [], entropy, margin, ranked };
	}
	if (entropy >= weights.highEntropy || margin < weights.minimumMargin) {
		return { disposition: "shortlist", shortlist, entropy, margin, ranked };
	}
	if (best.automaticEligible !== false && (best.deterministicMatch || best.sampleCount >= weights.minimumEvidence)) {
		return {
			disposition: "recommend",
			recommendation: best.tool,
			shortlist: [],
			entropy,
			margin,
			ranked,
		};
	}
	return { disposition: "abstain", shortlist: [], entropy, margin, ranked };
}
