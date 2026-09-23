import type { CacheObservationRow } from "../operator-projection/decision-ledger-store.ts";

/** The lane a provider cache lives on: the exact model behind an API. */
export function cacheLaneKey(api: string, provider: string, modelId: string): string {
	return `${api}\u0000${provider}\u0000${modelId}`;
}

export interface CacheObservationInput {
	/** The session whose history the request carried: a gap is measured on one history, never across two. */
	readonly sessionId: string;
	readonly lane: string;
	/** When this response's request opened (its request snapshot). */
	readonly requestOpenedAt?: number;
	/** When this response ended. */
	readonly respondedAt: number;
	readonly usage: { readonly input?: number; readonly cacheRead?: number; readonly cacheWrite?: number };
	readonly prefixIntact?: boolean | "unknown";
	readonly divergenceKind?: string;
	/** The history lineage the request was made on (see {@link historyLineage}). */
	readonly lineage?: string;
}

/**
 * The lineage a history belongs to: the compaction it follows, or `root` before the first one. A
 * compacted history carries its summary at index 0, or at 1 behind the original-user anchor that
 * session-replacement retention keeps (`buildSessionContext`), so only those two slots are read.
 */
export function historyLineage(messages: readonly { role: string; timestamp?: number }[]): string {
	for (const message of messages.slice(0, 2)) {
		if (message.role === "compactionSummary") return `compaction@${message.timestamp ?? "?"}`;
	}
	return "root";
}

/** A session lane's last recorded response: when it ended and how large its prompt was. */
export interface CacheObservationSeed {
	readonly respondedAt: number;
	readonly promptTokens: number;
}

/**
 * Turns each provider response into one cache observation: the idle gap since the lane's previous
 * response (wall time, host suspension included, because the provider's cache keeps aging while the
 * host sleeps), the prompt size, and how much of the previous prompt the provider served from cache.
 * A session lane this process has not answered on yet starts from `seed` (the ledger's last recorded
 * response), so a session resumed in a new process measures the gap it was resumed after.
 */
export class CacheObservationRecorder {
	private readonly lanes = new Map<string, CacheObservationSeed | undefined>();
	private readonly seed: ((sessionId: string, lane: string) => CacheObservationSeed | undefined) | undefined;

	constructor(seed?: (sessionId: string, lane: string) => CacheObservationSeed | undefined) {
		this.seed = seed;
	}

	observe(input: CacheObservationInput): Omit<CacheObservationRow, "sessionId" | "cwd"> | undefined {
		const cacheRead = input.usage.cacheRead ?? 0;
		const promptTokens = (input.usage.input ?? 0) + cacheRead + (input.usage.cacheWrite ?? 0);
		if (promptTokens <= 0) return undefined;
		const key = `${input.sessionId}\u0000${input.lane}`;
		const previous = this.lanes.has(key) ? this.lanes.get(key) : this.seed?.(input.sessionId, input.lane);
		this.lanes.set(key, { respondedAt: input.respondedAt, promptTokens });
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
			...(input.lineage ? { lineage: input.lineage } : {}),
		};
	}
}
