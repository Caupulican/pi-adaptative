/**
 * Seeded fault-injecting response generator for the H2 (chaos-provider) destructive harnesses. Does
 * NOT reimplement or extend the faux provider (`@caupulican/pi-ai/faux`) — the faux provider already
 * accepts a `FauxResponseFactory` per queued response step (see `registerFauxProvider`'s
 * `RegisterFauxProviderOptions`/`FauxResponseStep`), so ChaosProvider is just a seeded generator of
 * those factories, consumed via the existing `createHarness({...}).setResponses([...])` mechanism
 * (`test/suite/harness.ts`). This answers blueprint §7 Q2: the faux provider lives in
 * `packages/ai/src/providers/faux.ts`; ChaosProvider extends its behavior purely by composition
 * (generating `FauxResponseFactory` values), with zero duplication of its streaming/registration
 * internals.
 *
 * Fault menu (blueprint §2), each producing a `FauxResponseFactory`:
 *  - hang               — never settles until the request's AbortSignal fires (mirrors the existing
 *                          `hangUntilAborted` precedent in test/suite/stream-stall-retry.test.ts).
 *  - midStreamDrop       — throws after a virtual-time delay, simulating a connection that dropped
 *                          after it had already started (stopReason "error" via the faux provider's
 *                          own createErrorMessage conversion).
 *  - http429/http500/http529 — throws an Error whose message matches the reliability classifier's
 *                          regexes (packages/agent/src/reliability/classifier.ts: RATE_LIMIT,
 *                          SERVER_ERROR, OVERLOADED) so retry classification exercises the same path
 *                          real HTTP errors would.
 *  - malformedToolCall   — a well-formed AssistantMessage (this generator sits above wire parsing)
 *                          whose tool call targets a name/argument shape no real tool would ever
 *                          register, exercising the same "the model asked for something impossible to
 *                          honor" handling a truly malformed tool-call payload would eventually reach.
 *  - truncatedFinalMessage — a "stop"-reason message whose text is cut off mid-sentence.
 *  - oversizedOutput     — a very large text blob, well past any single-turn budget.
 *  - slowDripStreaming   — resolves after a virtual-time delay before the (otherwise normal) message
 *                          is handed back. NOTE: real per-token trickle pacing is a harness-level
 *                          option (`RegisterFauxProviderOptions.tokensPerSecond`), not a per-response
 *                          one, so this mode approximates "slow" at the connect/first-byte stage
 *                          rather than true token-by-token drip; scenarios that need real per-token
 *                          pacing should also pass a low `tokensPerSecond` to `createHarness`.
 *  - stopReasonLength    — a "length" stopReason message (provider hit its own output cap).
 *  - clean               — a normal, healthy response (supplied by the caller, not generated here).
 *
 * All delays use `setTimeout`, meant to be driven under `vi.useFakeTimers()` +
 * `vi.advanceTimersByTimeAsync`/`runAllTimersAsync` — never real wall-clock time (design rule §0.1).
 */

import type { AssistantMessage, FauxResponseFactory, FauxResponseStep } from "@caupulican/pi-ai/faux";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { SeededRandom } from "./seeded-random.ts";

export type ChaosFaultKind =
	| "hang"
	| "midStreamDrop"
	| "http429"
	| "http500"
	| "http529"
	| "malformedToolCall"
	| "truncatedFinalMessage"
	| "oversizedOutput"
	| "slowDripStreaming"
	| "stopReasonLength";

export const CHAOS_FAULT_KINDS: readonly ChaosFaultKind[] = [
	"hang",
	"midStreamDrop",
	"http429",
	"http500",
	"http529",
	"malformedToolCall",
	"truncatedFinalMessage",
	"oversizedOutput",
	"slowDripStreaming",
	"stopReasonLength",
];

/** Default weights: every fault kind equally likely, tuned low relative to a scenario's own "clean"
 * weight so a chaos run still makes forward progress most of the time (see `chaosifySequence`). */
const DEFAULT_FAULT_WEIGHTS: Readonly<Record<ChaosFaultKind, number>> = {
	hang: 1,
	midStreamDrop: 1,
	http429: 2,
	http500: 2,
	http529: 1,
	malformedToolCall: 1,
	truncatedFinalMessage: 1,
	oversizedOutput: 1,
	slowDripStreaming: 1,
	stopReasonLength: 1,
};

const MID_STREAM_DROP_DELAY_MS = 50;
const SLOW_DRIP_DELAY_MS = 15_000;
const OVERSIZED_OUTPUT_CHARS = 400_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** hang: resolves only when the request is aborted, exactly like the precedented
 * `hangUntilAborted` faux factory in test/suite/stream-stall-retry.test.ts. */
const hangFault: FauxResponseFactory = (_context, options) =>
	new Promise<AssistantMessage>((resolve) => {
		const finish = () =>
			resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" }));
		if (options?.signal?.aborted) {
			finish();
			return;
		}
		options?.signal?.addEventListener("abort", finish, { once: true });
	});

const midStreamDropFault: FauxResponseFactory = async () => {
	await delay(MID_STREAM_DROP_DELAY_MS);
	throw new Error("Connection dropped mid-stream (simulated chaos fault).");
};

function httpFault(message: string): FauxResponseFactory {
	return () => {
		throw new Error(message);
	};
}

const malformedToolCallFault: FauxResponseFactory = () =>
	fauxAssistantMessage(
		[
			fauxToolCall("__chaos_malformed_tool_call__", {
				__chaos__: true,
				// Deliberately not shaped like any real tool's schema — this stands in for a tool call
				// whose JSON, at the wire level, a real provider would have sent malformed; this
				// generator sits above wire parsing (ToolCall.arguments is already a parsed
				// Record<string, any> at this layer — see packages/ai/src/types.ts), so "malformed" is
				// represented as "impossible to honor" rather than literally unpars: whichever tool
				// name resolution / argument validation path handles an unknown tool is exercised the
				// same way a truly malformed payload would eventually reach it.
				unexpectedNesting: { a: { b: { c: [1, 2, 3] } } },
			}),
		],
		{ stopReason: "toolUse" },
	);

const truncatedFinalMessageFault: FauxResponseFactory = () =>
	fauxAssistantMessage("I will now run the tes", { stopReason: "stop" });

const oversizedOutputFault: FauxResponseFactory = () =>
	fauxAssistantMessage("x".repeat(OVERSIZED_OUTPUT_CHARS), { stopReason: "stop" });

const slowDripStreamingFault: FauxResponseFactory = async () => {
	await delay(SLOW_DRIP_DELAY_MS);
	return fauxAssistantMessage("eventually arrived after a slow drip", { stopReason: "stop" });
};

const stopReasonLengthFault: FauxResponseFactory = () =>
	fauxAssistantMessage("truncated by the provider's own output cap", { stopReason: "length" });

const FAULT_FACTORIES: Readonly<Record<ChaosFaultKind, FauxResponseFactory>> = {
	hang: hangFault,
	midStreamDrop: midStreamDropFault,
	http429: httpFault("HTTP 429: rate limited (simulated chaos fault)."),
	http500: httpFault("HTTP 500: internal server error (simulated chaos fault)."),
	http529: httpFault("HTTP 529: overloaded (simulated chaos fault)."),
	malformedToolCall: malformedToolCallFault,
	truncatedFinalMessage: truncatedFinalMessageFault,
	oversizedOutput: oversizedOutputFault,
	slowDripStreaming: slowDripStreamingFault,
	stopReasonLength: stopReasonLengthFault,
};

/**
 * Fault kinds that resolve to a stream-protocol failure (a thrown Error -> "error" stopReason via
 * the faux provider's own createErrorMessage, or an eventual "aborted" stopReason once the
 * stream-idle watchdog fires) — the product's retry/reliability layer treats these as retryable and
 * calls the provider again, consuming the NEXT queued response. Safe to prepend ahead of a healthy
 * step: the healthy step is still the one eventually delivered, after N retries.
 */
const RETRYABLE_FAULT_KINDS: readonly ChaosFaultKind[] = ["hang", "midStreamDrop", "http429", "http500", "http529"];

/**
 * Fault kinds that resolve to a well-formed, "successful" AssistantMessage (a real stopReason, no
 * thrown error) — nothing retries these, so the product consumes them AS the turn's real response.
 * These must never be prepended ahead of a healthy step (they would silently consume that step's
 * queue slot and desynchronize the whole scripted sequence — see this module's chaosifySequence
 * header). They are instead used to occasionally REPLACE a healthy step outright, exercising "the
 * loop must tolerate a well-formed but useless/oversized/truncated/malformed response" rather than
 * "the loop must retry past a transport failure".
 */
const SUCCEEDING_FAULT_KINDS: readonly ChaosFaultKind[] = [
	"malformedToolCall",
	"truncatedFinalMessage",
	"oversizedOutput",
	"slowDripStreaming",
	"stopReasonLength",
];

export interface ChaosProviderOptions {
	seed: number;
	/** Override the default per-fault-kind weights (blueprint §2: "weights per scenario config"). */
	weights?: Partial<Record<ChaosFaultKind, number>>;
}

function weightedKinds(
	kinds: readonly ChaosFaultKind[],
	weights: Partial<Record<ChaosFaultKind, number>> | undefined,
): ReadonlyArray<readonly [ChaosFaultKind, number]> {
	return kinds
		.map((kind) => [kind, weights?.[kind] ?? DEFAULT_FAULT_WEIGHTS[kind]] as const)
		.filter(([, weight]) => weight > 0);
}

/** One seeded chaos fault factory, deterministic given (seed, draw index). */
export function createChaosProvider(options: ChaosProviderOptions): {
	random: SeededRandom;
	next(): FauxResponseFactory;
	nextKind(): ChaosFaultKind;
} {
	const random = new SeededRandom(options.seed);
	const weighted = weightedKinds(CHAOS_FAULT_KINDS, options.weights);
	return {
		random,
		nextKind: () => random.weightedPick(weighted),
		next(): FauxResponseFactory {
			const kind = random.weightedPick(weighted);
			return FAULT_FACTORIES[kind];
		},
	};
}

export interface ChaosifySequenceOptions extends ChaosProviderOptions {
	/** Max RETRYABLE fault steps injected before each healthy step (each consumes one queued
	 * response slot); kept modest relative to the product's default retry budget (packages/agent's
	 * DEFAULT_RETRY_POLICY.maxAttempts is 3) so a scenario can still make real progress. */
	maxFaultsPerStep?: number;
	/** Probability in [0, 1] that a given healthy step gets retryable chaos prepended ahead of it. */
	faultProbability?: number;
	/** Probability in [0, 1] that a given healthy step is REPLACED outright by a succeeding-but-weird
	 * fault instead of delivered as scripted. Independent of `faultProbability` (mutually exclusive
	 * per step: a replaced step is never also chaos-prepended, since there is no "healthy step"
	 * response left to prepend ahead of). */
	replaceProbability?: number;
}

const DEFAULT_MAX_FAULTS_PER_STEP = 2;
const DEFAULT_FAULT_PROBABILITY = 0.5;
const DEFAULT_REPLACE_PROBABILITY = 0.15;

/**
 * Interleave seeded chaos faults around a caller-supplied sequence of healthy response steps (the
 * steps that actually progress the scenario — e.g. a "goal" tool call, then work, then completion).
 * The result is a `FauxResponseStep[]` ready for `harness.setResponses(...)`. For each healthy step,
 * one of three things happens, chosen deterministically from the seed:
 *  - unchanged (delivered as scripted);
 *  - 1..maxFaultsPerStep RETRYABLE faults are prepended ahead of it (the product's retry/reliability
 *    layer must recover from each one before the healthy step is eventually delivered);
 *  - the step is REPLACED by one succeeding-but-weird fault (the product must tolerate a well-formed
 *    but garbage/oversized/truncated/malformed response without the scenario ever seeing that
 *    step's real content).
 */
export function chaosifySequence(
	healthySteps: readonly FauxResponseStep[],
	options: ChaosifySequenceOptions,
): FauxResponseStep[] {
	const random = new SeededRandom(options.seed);
	const retryableWeighted = weightedKinds(RETRYABLE_FAULT_KINDS, options.weights);
	const succeedingWeighted = weightedKinds(SUCCEEDING_FAULT_KINDS, options.weights);
	const maxFaultsPerStep = options.maxFaultsPerStep ?? DEFAULT_MAX_FAULTS_PER_STEP;
	const faultProbability = options.faultProbability ?? DEFAULT_FAULT_PROBABILITY;
	const replaceProbability = options.replaceProbability ?? DEFAULT_REPLACE_PROBABILITY;
	const result: FauxResponseStep[] = [];
	for (const healthyStep of healthySteps) {
		if (succeedingWeighted.length > 0 && random.nextFloat() < replaceProbability) {
			const kind = random.weightedPick(succeedingWeighted);
			result.push(FAULT_FACTORIES[kind]);
			continue;
		}
		if (retryableWeighted.length > 0 && random.nextFloat() < faultProbability) {
			const faultCount = random.nextInt(1, Math.max(1, maxFaultsPerStep));
			for (let i = 0; i < faultCount; i++) {
				const kind = random.weightedPick(retryableWeighted);
				result.push(FAULT_FACTORIES[kind]);
			}
		}
		result.push(healthyStep);
	}
	return result;
}
