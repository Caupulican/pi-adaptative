/**
 * Reports conservative configured cache-retention bounds from the request policy captured before transport.
 * A known cache touch can establish a warm lower bound and a cold upper bound; the interval between them,
 * unknown policy and missing timing have no countdown. The response's lane/account policy owns the bounds.
 */
import type { AgentSessionEvent } from "./agent-session-contracts.ts";
import { messageCachePolicy } from "./context/cache-observation-recorder.ts";
import { type CacheResponsePolicy, cacheExpiryBounds } from "./context/cache-survival.ts";

export class CacheClock {
	private response: CacheResponsePolicy | undefined;

	observe(event: AgentSessionEvent, now = Date.now()): void {
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		this.response = { observedAt: now, cachePolicy: messageCachePolicy(event.message) };
	}

	remainingMs(now = Date.now()): number | undefined {
		return this.status(now)?.remainingMs;
	}

	nextBoundaryMs(now = Date.now()): number | undefined {
		return this.status(now)?.nextBoundaryMs;
	}

	private status(now: number): { remainingMs?: number; nextBoundaryMs?: number } | undefined {
		const response = this.response;
		const bounds = cacheExpiryBounds(response);
		if (!response || !bounds || now < response.observedAt) return;
		const elapsed = now - response.observedAt;
		if (elapsed < bounds.warmUntilMs) {
			const remainingMs = bounds.warmUntilMs - elapsed;
			return { remainingMs, nextBoundaryMs: remainingMs };
		}
		if (elapsed < bounds.coldAfterMs) return { nextBoundaryMs: bounds.coldAfterMs - elapsed };
		return { remainingMs: 0 };
	}
}
