/**
 * How long the provider's prompt cache for the session's last request lives.
 *
 * Each response that read or wrote cache restarts the provider's clock, so the cache expires its documented
 * lifetime after that response finished. A provider with no published lifetime has no clock: the display shows
 * nothing rather than a guess. Driven by session events, never polled.
 */
import type { CacheRetention } from "@caupulican/pi-ai";
import type { AgentSessionEvent } from "./agent-session-contracts.ts";
import { cacheLaneKey } from "./context/cache-observation-recorder.ts";
import { cacheHost, providerCacheTtlMs } from "./context/cache-survival.ts";

export class CacheClock {
	private readonly retention: () => CacheRetention;
	private expiresAt: number | undefined;

	constructor(retention: () => CacheRetention) {
		this.retention = retention;
	}

	observe(event: AgentSessionEvent, now = Date.now()): void {
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		const { usage, api, provider, model } = event.message;
		if ((usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0) <= 0) return;
		const retention = this.retention();
		const ttlMs =
			retention === "none"
				? undefined
				: providerCacheTtlMs(cacheHost(cacheLaneKey(api, provider, model)).vendor, retention);
		this.expiresAt = ttlMs === undefined ? undefined : now + ttlMs;
	}

	/** Milliseconds left on the cache (0 once expired); undefined with no cache request seen or no known lifetime. */
	remainingMs(now = Date.now()): number | undefined {
		return this.expiresAt === undefined ? undefined : Math.max(0, this.expiresAt - now);
	}
}
