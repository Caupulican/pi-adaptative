import type { AssistantMessage } from "@caupulican/pi-ai";
import { isPlainRecord } from "../../kernel/utils/value-guards.ts";
import type { CacheObservationRow } from "../operator-projection/decision-ledger-store.ts";
import { type CacheExpiryPolicy, cacheExpiryPolicyKey } from "./cache-survival.ts";

/** The lane a provider cache lives on: the exact model behind an API. */
export function cacheLaneKey(api: string, provider: string, modelId: string): string {
	return `${api}\u0000${provider}\u0000${modelId}`;
}

export interface CacheObservationInput {
	readonly cachePolicy?: CacheExpiryPolicy;
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
	/** What held the lane while it idled before this request (see {@link idleHolder}). */
	readonly holder?: "owner" | "tool" | "host";
}

/**
 * What held a lane while it idled before a reply's request: whatever the request carried since the
 * previous reply says who woke it. A person's message means `owner`; otherwise tool results mean `tool`;
 * otherwise (host records alone, such as a continuation trigger) `host`. Host records that ride along
 * with a person's message or tool results do not change who woke it.
 */
export type CacheIdleHolder = "owner" | "tool" | "host";

export function addIdleHolderRole(holder: CacheIdleHolder, role: string): CacheIdleHolder {
	if (role === "user") return "owner";
	if (role === "toolResult" && holder === "host") return "tool";
	return holder;
}

export function idleHolder(sincePreviousReply: readonly { role: string }[]): CacheIdleHolder {
	return sincePreviousReply.reduce<CacheIdleHolder>(
		(holder, message) => addIdleHolderRole(holder, message.role),
		"host",
	);
}

/**
 * The lineage a history belongs to: the latest compaction checkpoint it holds, or `root` before the first one. The
 * history is read from its end: a checkpoint scoped to an ICM chat turn follows the rebuilt context of the history
 * before that turn, which may hold checkpoints of its own (`buildSessionContext`), so the latest summary is not
 * necessarily among the first messages.
 */
export function historyLineage(messages: readonly { role: string; timestamp?: number }[]): string {
	const summary = messages.findLast((message) => message.role === "compactionSummary");
	return summary === undefined ? "root" : compactionLineage(summary.timestamp);
}

export function compactionLineage(timestamp: number | undefined): string {
	return `compaction@${timestamp ?? "?"}`;
}

/** A session lane's last recorded response: when it ended and how large its prompt was. */
export interface CacheObservationSeed {
	readonly cachePolicy?: CacheExpiryPolicy;
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
		this.lanes.set(key, {
			respondedAt: input.respondedAt,
			promptTokens,
			...(input.cachePolicy ? { cachePolicy: input.cachePolicy } : {}),
		});
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
		const measuredCachePolicy =
			previous?.cachePolicy?.cacheTouched &&
			previous.cachePolicy.kind !== "unknown" &&
			input.cachePolicy &&
			cacheExpiryPolicyKey(previous.cachePolicy) === cacheExpiryPolicyKey(input.cachePolicy)
				? previous.cachePolicy
				: undefined;
		return {
			...(input.cachePolicy ? { cachePolicy: input.cachePolicy } : {}),
			...(measuredCachePolicy ? { measuredCachePolicy } : {}),
			lane: input.lane,
			observedAt: input.respondedAt,
			promptTokens,
			cacheReadTokens: cacheRead,
			prefixIntact,
			...(gapMs !== undefined ? { gapMs } : {}),
			...(retained !== undefined ? { retained } : {}),
			...(input.divergenceKind ? { divergenceKind: input.divergenceKind } : {}),
			...(input.lineage ? { lineage: input.lineage } : {}),
			...(input.holder ? { holder: input.holder } : {}),
		};
	}
}

export function readCacheExpiryPolicy(value: unknown, lane: string): CacheExpiryPolicy | undefined {
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			return;
		}
	}
	if (
		!isPlainRecord(parsed) ||
		parsed.lane !== lane ||
		typeof parsed.accountScope !== "string" ||
		!parsed.accountScope ||
		parsed.accountScope.length > 256 ||
		!["fixed", "automatic", "disabled", "unknown"].includes(String(parsed.kind)) ||
		typeof parsed.wirePolicy !== "string" ||
		parsed.wirePolicy.length > 512 ||
		!Number.isSafeInteger(parsed.capturedAt) ||
		Number(parsed.capturedAt) < 0 ||
		typeof parsed.cacheTouched !== "boolean" ||
		(parsed.kind === "fixed"
			? !Number.isSafeInteger(parsed.ttlMs) || Number(parsed.ttlMs) <= 0 || Number(parsed.ttlMs) > 3_600_000
			: parsed.ttlMs !== undefined)
	)
		return;
	return {
		lane,
		accountScope: parsed.accountScope,
		kind: parsed.kind as CacheExpiryPolicy["kind"],
		wirePolicy: parsed.wirePolicy,
		capturedAt: parsed.capturedAt as number,
		cacheTouched: parsed.cacheTouched,
		...(parsed.ttlMs !== undefined ? { ttlMs: parsed.ttlMs as number } : {}),
	};
}

export function messageCachePolicy(message: AssistantMessage): CacheExpiryPolicy | undefined {
	if (message.responseModel && message.responseModel !== message.model) return;
	const diagnostic = message.diagnostics?.findLast((entry) => entry.type === "provider_cache_policy");
	const captured = diagnostic?.details;
	if (
		!isPlainRecord(captured) ||
		captured.api !== message.api ||
		captured.provider !== message.provider ||
		captured.modelId !== message.model
	)
		return;
	const lane = cacheLaneKey(message.api, message.provider, message.model);
	return readCacheExpiryPolicy(
		{
			lane,
			accountScope: captured.accountScope,
			ttlMs: captured.ttlMs,
			kind: captured.kind,
			wirePolicy: captured.wirePolicy,
			capturedAt: diagnostic?.timestamp,
			cacheTouched: message.usage.cacheRead + message.usage.cacheWrite > 0,
		},
		lane,
	);
}
