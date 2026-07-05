import type { Model } from "@caupulican/pi-ai";
import type { SessionEntry } from "../session/session-manager.ts";
import type { CompactionResult } from "./compaction.ts";

export interface CompactionCycleParams {
	modelTier: "cheap" | "session";
	keepRecentTokens: number;
	chunked: boolean;
	deterministicOnly: boolean;
}

export interface ModelAndAuth {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	failure?: string;
}

export interface CompactionLoopDeps {
	measureLiveTokens(): number;
	getTriggerThreshold(): number;
	getMargin(): number;
	getBranch(): SessionEntry[];
	resolveModelAndAuth(modelTier: CompactionCycleParams["modelTier"]): Promise<ModelAndAuth>;
	summarizeAndVerify(
		params: CompactionCycleParams,
		model: Model<any>,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		branch: SessionEntry[],
	): Promise<{ result: CompactionResult }>;
	buildDeterministicCheckpoint(): Promise<{ result: CompactionResult }> | { result: CompactionResult };
	apply(result: CompactionResult): Promise<void> | void;
	onTransition(info: { cycle: number; from: string; cause: string }): void;
	getBaseKeepRecentTokens?(): number;
	signal?: AbortSignal;
}

export type CompactionLoopOutcome =
	| { kind: "success"; result: CompactionResult; cycles: number }
	| { kind: "skip"; reason: string }
	| { kind: "failed"; reason: string; cycles: number };

const MAX_CYCLES = 4;
const MAX_LLM_CYCLES = 3;
const DEFAULT_KEEP_RECENT = 20_000;

export async function runCompactionLoop(deps: CompactionLoopDeps): Promise<CompactionLoopOutcome> {
	let lastCause = "start";
	let lastParams: CompactionCycleParams | undefined;
	let lastObservedTokens: number | undefined;
	let appliedResult: CompactionResult | undefined;
	let baseKeepRecent = deps.getBaseKeepRecentTokens ? deps.getBaseKeepRecentTokens() : DEFAULT_KEEP_RECENT;
	if (!Number.isFinite(baseKeepRecent) || baseKeepRecent <= 0) {
		baseKeepRecent = DEFAULT_KEEP_RECENT;
	}

	for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
		if (deps.signal?.aborted) {
			return { kind: "failed", reason: "aborted", cycles: cycle - 1 };
		}

		const branch = deps.getBranch();
		if (branch.length > 0 && branch[branch.length - 1]?.type === "compaction") {
			if (appliedResult) {
				return { kind: "success", result: appliedResult, cycles: cycle - 1 };
			}
			return { kind: "skip", reason: "already compacted" };
		}

		const observedTokens = deps.measureLiveTokens();
		if (observedTokens <= deps.getTriggerThreshold()) {
			return {
				kind: "skip",
				reason:
					branch.length > 0 && branch[branch.length - 1]?.type === "compaction"
						? "already compacted"
						: "within threshold",
			};
		}

		const selectedParams = selectCycleParams(cycle, lastCause, lastParams, baseKeepRecent);
		const params = enforceMonotonicProgress(selectedParams, lastParams, observedTokens, lastObservedTokens);
		lastObservedTokens = observedTokens;
		lastParams = params;

		if (params.deterministicOnly || cycle > MAX_LLM_CYCLES) {
			if (deps.signal?.aborted) {
				return { kind: "failed", reason: "aborted", cycles: cycle - 1 };
			}
			const { result } = await Promise.resolve(deps.buildDeterministicCheckpoint());
			await deps.apply(result);
			return { kind: "success", result, cycles: cycle };
		}

		let modelInfo: ModelAndAuth;
		try {
			modelInfo = await deps.resolveModelAndAuth(params.modelTier);
		} catch {
			lastCause = "auth-failed";
			deps.onTransition({ cycle: cycle + 1, from: "step0", cause: lastCause });
			continue;
		}
		if (modelInfo.failure) {
			lastCause = "auth-failed";
			deps.onTransition({ cycle: cycle + 1, from: "step0", cause: lastCause });
			continue;
		}

		let result: CompactionResult;
		try {
			({ result } = await deps.summarizeAndVerify(
				params,
				modelInfo.model,
				modelInfo.apiKey,
				modelInfo.headers,
				branch,
			));
		} catch (error) {
			lastCause = mapFailureCause(error);
			if (lastCause === "aborted") {
				return { kind: "failed", reason: "aborted", cycles: cycle };
			}
			deps.onTransition({ cycle: cycle + 1, from: "step3", cause: lastCause });
			continue;
		}

		if (deps.signal?.aborted) {
			return { kind: "failed", reason: "aborted", cycles: cycle };
		}
		await deps.apply(result);
		appliedResult = result;

		const measuredAfter = deps.measureLiveTokens();
		if (measuredAfter <= deps.getTriggerThreshold() - deps.getMargin()) {
			return { kind: "success", result, cycles: cycle };
		}

		lastCause = "effect-not-restored";
		deps.onTransition({ cycle: cycle + 1, from: "step5", cause: lastCause });
	}

	return { kind: "failed", reason: "exhausted-compaction-cycles", cycles: MAX_CYCLES };
}

function selectCycleParams(
	cycle: number,
	cause: string,
	lastParams: CompactionCycleParams | undefined,
	baseKeepRecent: number,
): CompactionCycleParams {
	if (cycle >= MAX_CYCLES) {
		return {
			modelTier: lastParams?.modelTier ?? "session",
			keepRecentTokens: Math.max(1, Math.floor((lastParams?.keepRecentTokens ?? baseKeepRecent) / 2)),
			chunked: true,
			deterministicOnly: true,
		};
	}

	if (!lastParams) {
		return {
			modelTier: "cheap",
			keepRecentTokens: Math.max(1, baseKeepRecent),
			chunked: false,
			deterministicOnly: false,
		};
	}

	const params: CompactionCycleParams = {
		...lastParams,
		deterministicOnly: false,
	};

	if (cause === "gate-failed" || cause === "auth-failed") {
		params.modelTier = "session";
	} else if (cause === "input-overflow") {
		params.chunked = true;
	} else if (cause === "effect-not-restored") {
		params.chunked = true;
		params.keepRecentTokens = Math.max(1, Math.floor(lastParams.keepRecentTokens / 2));
	}

	return params;
}

function enforceMonotonicProgress(
	params: CompactionCycleParams,
	lastParams: CompactionCycleParams | undefined,
	observedTokens: number,
	lastObservedTokens: number | undefined,
): CompactionCycleParams {
	if (
		!lastParams ||
		params.deterministicOnly ||
		(lastObservedTokens !== undefined && observedTokens < lastObservedTokens)
	) {
		return params;
	}
	if (!sameParams(params, lastParams)) {
		return params;
	}

	const keepRecentTokens = Math.max(1, Math.floor(params.keepRecentTokens / 2));
	if (keepRecentTokens !== params.keepRecentTokens) {
		return { ...params, chunked: true, keepRecentTokens };
	}
	if (!params.chunked) {
		return { ...params, chunked: true };
	}
	return { ...params, modelTier: params.modelTier === "cheap" ? "session" : "cheap" };
}

function sameParams(a: CompactionCycleParams, b: CompactionCycleParams): boolean {
	return (
		a.modelTier === b.modelTier &&
		a.keepRecentTokens === b.keepRecentTokens &&
		a.chunked === b.chunked &&
		a.deterministicOnly === b.deterministicOnly
	);
}

function mapFailureCause(error: unknown): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (message.includes("gate-failed")) return "gate-failed";
	if (message.includes("input-overflow")) return "input-overflow";
	if (message.includes("auto-compaction-cancelled") || message.includes("aborted")) return "aborted";
	if (message.includes("auth") || message.includes("api key") || message.includes("not compacted"))
		return "auth-failed";
	return "unknown-failure";
}
