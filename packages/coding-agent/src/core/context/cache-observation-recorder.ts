import type { CacheObservationRow } from "../operator-projection/decision-ledger-store.ts";

/** The lane a provider cache lives on: the exact model behind an API. */
export function cacheLaneKey(api: string, provider: string, modelId: string): string {
	return `${api}\u0000${provider}\u0000${modelId}`;
}

export interface CacheObservationInput {
	readonly lane: string;
	/** When this response's request opened (its request snapshot). */
	readonly requestOpenedAt?: number;
	/** When this response ended. */
	readonly respondedAt: number;
	readonly usage: { readonly input?: number; readonly cacheRead?: number; readonly cacheWrite?: number };
	readonly prefixIntact?: boolean | "unknown";
	readonly divergenceKind?: string;
}

/**
 * Turns each provider response into one cache observation: the idle gap since the lane's previous
 * response (wall time, host suspension included, because the provider's cache keeps aging while the
 * host sleeps), the prompt size, and how much of the previous prompt the provider served from cache.
 */
export class CacheObservationRecorder {
	private readonly lanes = new Map<string, { respondedAt: number; promptTokens: number }>();

	observe(input: CacheObservationInput): Omit<CacheObservationRow, "sessionId" | "cwd"> | undefined {
		const cacheRead = input.usage.cacheRead ?? 0;
		const promptTokens = (input.usage.input ?? 0) + cacheRead + (input.usage.cacheWrite ?? 0);
		if (promptTokens <= 0) return undefined;
		const previous = this.lanes.get(input.lane);
		this.lanes.set(input.lane, { respondedAt: input.respondedAt, promptTokens });
		const gapMs =
			previous && input.requestOpenedAt !== undefined
				? Math.max(0, input.requestOpenedAt - previous.respondedAt)
				: undefined;
		const retained =
			previous && previous.promptTokens > 0
				? Math.min(1, Math.max(0, cacheRead / previous.promptTokens))
				: undefined;
		const prefixIntact =
			input.prefixIntact === undefined || input.prefixIntact === "unknown"
				? "unknown"
				: input.prefixIntact
					? "true"
					: "false";
		return {
			lane: input.lane,
			observedAt: input.respondedAt,
			promptTokens,
			cacheReadTokens: cacheRead,
			prefixIntact,
			...(gapMs !== undefined ? { gapMs } : {}),
			...(retained !== undefined ? { retained } : {}),
			...(input.divergenceKind ? { divergenceKind: input.divergenceKind } : {}),
		};
	}
}
