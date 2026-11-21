/** Decodes persisted cache observations without granting legacy or malformed policy rows expiry evidence. */
import { readCacheExpiryPolicy } from "../context/cache-observation-recorder.ts";
import type { CacheObservationRow } from "./decision-ledger-store.ts";
import { asInteger, asText } from "./semantic-evaluation-row.ts";

export function cacheObservationRows(rows: readonly Record<string, unknown>[]): CacheObservationRow[] {
	const out: CacheObservationRow[] = [];
	for (const row of rows) {
		const sessionId = asText(row.session_id);
		const cwd = asText(row.cwd);
		const observedAt = asInteger(row.observed_at);
		const promptTokens = asInteger(row.prompt_tokens);
		const cacheReadTokens = asInteger(row.cache_read_tokens);
		const lane = asText(row.lane);
		const prefixIntact = asText(row.prefix_intact);
		if (
			lane === undefined ||
			sessionId === undefined ||
			cwd === undefined ||
			observedAt === undefined ||
			promptTokens === undefined ||
			cacheReadTokens === undefined ||
			(prefixIntact !== "true" && prefixIntact !== "false" && prefixIntact !== "unknown")
		)
			continue;
		const gapMs = asInteger(row.gap_ms);
		const retained = typeof row.retained === "number" ? row.retained : undefined;
		const divergenceKind = asText(row.divergence_kind);
		const lineage = asText(row.lineage);
		const holder = asText(row.holder);
		const cachePolicy = readCacheExpiryPolicy(row.cache_policy, lane);
		const measuredCachePolicy = readCacheExpiryPolicy(row.measured_cache_policy, lane);
		out.push({
			sessionId,
			cwd,
			lane,
			observedAt,
			promptTokens,
			cacheReadTokens,
			prefixIntact,
			...(cachePolicy ? { cachePolicy } : {}),
			...(measuredCachePolicy ? { measuredCachePolicy } : {}),
			...(gapMs !== undefined ? { gapMs } : {}),
			...(retained !== undefined ? { retained } : {}),
			...(divergenceKind !== undefined ? { divergenceKind } : {}),
			...(lineage !== undefined ? { lineage } : {}),
			...(holder === "owner" || holder === "tool" || holder === "host" ? { holder } : {}),
		});
	}
	return out;
}
