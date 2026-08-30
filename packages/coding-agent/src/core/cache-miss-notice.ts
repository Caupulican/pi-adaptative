import type { Usage } from "@caupulican/pi-ai";

/** Default Anthropic-style prompt-cache TTL, used only to ANNOTATE an already-detected miss. */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export interface CacheMissObservation {
	usage: Usage;
	modelKey: string;
	timestamp: number;
}

export interface CacheMissNotice {
	reason: "model_switch" | "idle_gap";
	message: string;
}

/**
 * Detect an EVIDENCED prompt-cache miss between two consecutive turns (P1m). Upstream's local
 * predecessor guessed BEFORE the prompt from wall-clock alone, with no evidence a miss actually
 * happened. This instead compares the current turn's real `usage.cacheRead` against the previous
 * turn's total prompt size: if most of that prior prompt should have carried over from cache but
 * didn't, AND the gap is explained by a model switch or an idle span past the cache TTL, return a
 * notice. An unmissed cache, or a miss with no explanation, returns undefined rather than guessing.
 */
export function detectCacheMissNotice(
	current: CacheMissObservation,
	previous: CacheMissObservation | undefined,
	idleTtlMs: number = DEFAULT_CACHE_TTL_MS,
): CacheMissNotice | undefined {
	if (!previous) return undefined;

	const previousPromptTokens = previous.usage.input + previous.usage.cacheRead + previous.usage.cacheWrite;
	if (previousPromptTokens <= 0) return undefined;

	// Most of the previous prompt should reappear as cacheRead on the next request when caching is
	// working; well under half is treated as evidence of a miss.
	const missed = current.usage.cacheRead < previousPromptTokens * 0.5;
	if (!missed) return undefined;

	if (current.modelKey !== previous.modelKey) {
		return {
			reason: "model_switch",
			message: `Notice: prompt cache reset -- model changed from ${previous.modelKey} to ${current.modelKey}.`,
		};
	}

	const idleMs = current.timestamp - previous.timestamp;
	if (idleMs > idleTtlMs) {
		const idleMinutes = Math.round(idleMs / 60_000);
		return {
			reason: "idle_gap",
			message: `Notice: prompt cache miss after an idle gap of ~${idleMinutes}m.`,
		};
	}

	return undefined;
}

/**
 * The cache observation a completed turn provides, or undefined when the turn produced no usable
 * response. An errored or aborted turn yields nothing to learn from, so the caller keeps its
 * previous observation as the baseline rather than overwriting it with nothing.
 */
export function observeCacheStateFromMessages(messages: readonly { role: string }[]): CacheMissObservation | undefined {
	const last = [...messages]
		.reverse()
		.find((message): message is { role: "assistant" } & CacheMissObservationSource => message.role === "assistant");
	if (!last || last.stopReason === "error" || last.stopReason === "aborted") return undefined;
	return {
		usage: last.usage,
		modelKey: `${last.provider}/${last.model}`,
		timestamp: last.timestamp,
	};
}

interface CacheMissObservationSource {
	usage: CacheMissObservation["usage"];
	provider: string;
	model: string;
	timestamp: number;
	stopReason?: string;
}
