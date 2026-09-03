import type { Model } from "@caupulican/pi-ai";
import { classifyFailure } from "../reliability/classifier.ts";
import type { SessionEntry } from "../session/session-manager.ts";
import { type CompactionResult, mergeCompactionVerificationReports } from "./compaction.ts";
import { CompactionVerificationError, type VerificationReport } from "./verification.ts";

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
	shouldCompact(tokens: number): boolean;
	getPostApplyMargin(): number;
	getBranch(): SessionEntry[];
	resolveModelAndAuth(modelTier: CompactionCycleParams["modelTier"]): Promise<ModelAndAuth>;
	summarizeAndVerify(
		params: CompactionCycleParams,
		model: Model<any>,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		branch: SessionEntry[],
	): Promise<{ result: CompactionResult }>;
	buildDeterministicCheckpoint(
		params: CompactionCycleParams,
	): Promise<{ result: CompactionResult }> | { result: CompactionResult };
	apply(result: CompactionResult): Promise<void> | void;
	onTransition(info: { cycle: number; from: string; cause: string; detail?: string }): void;
	getBaseKeepRecentTokens?(): number;
	verifyPostApplyEffect?(): boolean;
	/** Permit one new checkpoint to tighten the immediately preceding compaction during request replanning. */
	allowTrailingCompactionAsPrevious?: boolean;
	/** Skip the summarizer and build the deterministic checkpoint on cycle one. */
	forceDeterministic?: boolean;
	signal?: AbortSignal;
}

export type CompactionLoopOutcome =
	| { kind: "success"; result: CompactionResult; cycles: number }
	| { kind: "skip"; reason: string }
	| { kind: "failed"; reason: string; cycles: number };

const MAX_CYCLES = 4;
const MAX_LLM_CYCLES = 3;
const DEFAULT_KEEP_RECENT = 20_000;

/** A facts-only checkpoint is a fallback, never a success the ledger may report as one. */
function markDeterministic(result: CompactionResult, cause: string): CompactionResult {
	return { ...result, deterministic: { cause } };
}

export async function runCompactionLoop(deps: CompactionLoopDeps): Promise<CompactionLoopOutcome> {
	let lastCause = "start";
	let lastParams: CompactionCycleParams | undefined;
	let lastObservedTokens: number | undefined;
	let appliedResult: CompactionResult | undefined;
	let lastModelKey: string | undefined;
	let ownTrailingCompactionId: string | undefined;
	let ownTrailingCompactionNeedsRetry = false;
	const pendingVerificationReports: VerificationReport[] = [];
	let baseKeepRecent = deps.getBaseKeepRecentTokens ? deps.getBaseKeepRecentTokens() : DEFAULT_KEEP_RECENT;
	if (!Number.isFinite(baseKeepRecent) || baseKeepRecent <= 0) {
		baseKeepRecent = DEFAULT_KEEP_RECENT;
	}

	for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
		if (deps.signal?.aborted) {
			return { kind: "failed", reason: "aborted", cycles: cycle - 1 };
		}

		const branch = deps.getBranch();
		const trailingEntry = branch[branch.length - 1];
		if (branch.length > 0 && trailingEntry?.type === "compaction") {
			if (appliedResult && trailingEntry.id === ownTrailingCompactionId) {
				if (!ownTrailingCompactionNeedsRetry) return { kind: "success", result: appliedResult, cycles: cycle - 1 };
			} else if (!(cycle === 1 && deps.allowTrailingCompactionAsPrevious)) {
				return { kind: "skip", reason: "already compacted" };
			}
		}

		const observedTokens = deps.measureLiveTokens();
		if (cycle === 1 && !deps.shouldCompact(observedTokens)) {
			return {
				kind: "skip",
				reason:
					branch.length > 0 && branch[branch.length - 1]?.type === "compaction"
						? "already compacted"
						: "within threshold",
			};
		}

		const selectedParams = deps.forceDeterministic
			? {
					...selectCycleParams(cycle, lastCause, lastParams, baseKeepRecent),
					deterministicOnly: true,
				}
			: selectCycleParams(cycle, lastCause, lastParams, baseKeepRecent);
		let params = enforceMonotonicProgress(selectedParams, lastParams, observedTokens, lastObservedTokens, lastCause);
		lastObservedTokens = observedTokens;

		if (params.deterministicOnly || cycle > MAX_LLM_CYCLES) {
			if (deps.signal?.aborted) {
				return { kind: "failed", reason: "aborted", cycles: cycle - 1 };
			}
			try {
				const built = await Promise.resolve(deps.buildDeterministicCheckpoint(params));
				const result = markDeterministic(
					mergeCompactionVerificationReports(built.result, pendingVerificationReports),
					// "start" is the loop's own sentinel for "no summarizer attempt yet", not a cause.
					lastCause !== "start" ? lastCause : params.deterministicOnly ? "deterministic-only" : "max-llm-cycles",
				);
				pendingVerificationReports.length = 0;
				await deps.apply(result);
				return { kind: "success", result, cycles: cycle };
			} catch (error) {
				return { kind: "failed", reason: mapFailureCause(error).cause, cycles: cycle };
			}
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
		const currentModelKey = modelKey(modelInfo.model);
		if (
			(lastCause === "gate-failed" || lastCause === "length-stop") &&
			lastParams &&
			params.modelTier !== lastParams.modelTier &&
			lastModelKey === currentModelKey
		) {
			params = { ...params, modelTier: lastParams.modelTier };
		}
		lastParams = params;
		lastModelKey = currentModelKey;

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
			if (deps.signal?.aborted) {
				return { kind: "failed", reason: "aborted", cycles: cycle };
			}
			if (error instanceof CompactionVerificationError) {
				pendingVerificationReports.push(...error.reports);
			}
			const failure = mapFailureCause(error, modelInfo.model.provider);
			lastCause = failure.cause;
			if (lastCause === "aborted") {
				return { kind: "failed", reason: lastCause, cycles: cycle };
			}
			if (lastCause === "provider-failure") {
				return { kind: "failed", reason: error instanceof Error ? error.message : String(error), cycles: cycle };
			}
			if (lastCause === "deterministic-required") {
				try {
					const built = await Promise.resolve(deps.buildDeterministicCheckpoint(params));
					const deterministicResult = markDeterministic(
						mergeCompactionVerificationReports(built.result, pendingVerificationReports),
						"deterministic-required",
					);
					pendingVerificationReports.length = 0;
					await deps.apply(deterministicResult);
					return { kind: "success", result: deterministicResult, cycles: cycle };
				} catch (deterministicError) {
					return { kind: "failed", reason: mapFailureCause(deterministicError).cause, cycles: cycle };
				}
			}
			deps.onTransition({ cycle: cycle + 1, from: "step3", cause: lastCause, detail: failure.detail });
			continue;
		}

		if (deps.signal?.aborted) {
			return { kind: "failed", reason: "aborted", cycles: cycle };
		}
		mergeCompactionVerificationReports(result, pendingVerificationReports);
		pendingVerificationReports.length = 0;
		await deps.apply(result);
		appliedResult = result;
		const branchAfterApply = deps.getBranch();
		const trailingAfterApply = branchAfterApply[branchAfterApply.length - 1];
		ownTrailingCompactionId = trailingAfterApply?.type === "compaction" ? trailingAfterApply.id : undefined;

		if (deps.verifyPostApplyEffect?.() === false) {
			ownTrailingCompactionNeedsRetry = false;
			return { kind: "success", result, cycles: cycle };
		}

		const measuredAfter = deps.measureLiveTokens();
		if (!deps.shouldCompact(measuredAfter + deps.getPostApplyMargin())) {
			ownTrailingCompactionNeedsRetry = false;
			return { kind: "success", result, cycles: cycle };
		}

		ownTrailingCompactionNeedsRetry = true;
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

	if (cause === "gate-failed" || cause === "auth-failed" || cause === "length-stop") {
		params.modelTier = "session";
	} else if (cause === "input-overflow") {
		params.chunked = true;
	} else if (cause === "effect-not-restored") {
		params.chunked = true;
		params.keepRecentTokens = Math.max(1, Math.floor(lastParams.keepRecentTokens / 2));
		// The first verified summary already paid the model cost. If applying it did not restore
		// headroom, repeating the same summarization request can stall a tool loop for minutes while
		// protected recent/image content remains unchanged. Finish the bounded retry with the
		// deterministic checkpoint at the stricter cut instead of buying two more equivalent calls.
		params.deterministicOnly = true;
	}

	return params;
}

function enforceMonotonicProgress(
	params: CompactionCycleParams,
	lastParams: CompactionCycleParams | undefined,
	observedTokens: number,
	lastObservedTokens: number | undefined,
	lastCause: string,
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
	if (lastCause === "gate-failed") {
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

function modelKey(model: Model<any>): string {
	return `${model.provider}:${model.id}:${model.api}:${model.baseUrl ?? ""}`;
}

function sameParams(a: CompactionCycleParams, b: CompactionCycleParams): boolean {
	return (
		a.modelTier === b.modelTier &&
		a.keepRecentTokens === b.keepRecentTokens &&
		a.chunked === b.chunked &&
		a.deterministicOnly === b.deterministicOnly
	);
}

function mapFailureCause(error: unknown, provider?: string): { cause: string; detail?: string } {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (message.includes("gate-failed")) return { cause: "gate-failed", detail: boundedDetail(message) };
	if (message.includes("summary-demand-exceeds-reserve"))
		return { cause: "deterministic-required", detail: boundedDetail(message) };
	if (message.includes("input-overflow")) return { cause: "input-overflow", detail: boundedDetail(message) };
	// A length-stopped summary lost gated sections; escalating the tier buys a larger output cap.
	if (message.includes("summary-length-stop")) return { cause: "length-stop", detail: boundedDetail(message) };
	if (message.includes("auto-compaction-cancelled")) return { cause: "aborted", detail: boundedDetail(message) };
	const classified = classifyFailure({ message, provider });
	if (classified.retryable) return { cause: "provider-failure", detail: boundedDetail(message) };
	if (
		classified.reason === "auth" ||
		classified.reason === "billing_or_quota" ||
		message.includes("api key") ||
		message.includes("not compacted")
	)
		return { cause: "auth-failed", detail: boundedDetail(message) };
	return { cause: "unknown-failure", detail: boundedDetail(message) };
}

function boundedDetail(message: string): string | undefined {
	if (!message) return undefined;
	return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
