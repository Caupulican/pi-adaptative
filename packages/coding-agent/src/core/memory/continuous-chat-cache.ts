/** Host-only provenance for a rendered ICM view. Provider adapters project only the text and cache boundary. */

import { createHash } from "node:crypto";
import type { TextContent } from "@caupulican/pi-ai";
import { isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";
import {
	type ContinuousChatNodeCoordinate,
	continuousChatNodeFirstMessage,
	continuousChatNodeKey,
	continuousChatNodeMessageCount,
	parseContinuousChatNodeCoordinate,
} from "./continuous-chat-tree.ts";

export interface ContinuousChatCacheLine extends ContinuousChatNodeCoordinate {
	/** Required projection revision for this line's causal range, independent of ordinary tree publication. */
	projectionRevision: number;
}

export interface ContinuousChatViewCache {
	readonly authority: string;
	/** Consecutive built rows before the first unresolved row. Zero is an explicit stability declaration. */
	readonly stablePrefixLineCount: number;
	readonly lines: readonly ContinuousChatCacheLine[];
}

export interface RenderedContinuousChatView {
	readonly text: string;
	readonly cache: ContinuousChatViewCache;
}

/** The first text block carries provenance through normal message cloning, without adding model-visible text. */
export interface ContinuousChatCacheTextContent extends TextContent {
	icmCache: ContinuousChatViewCache;
}

export interface ContinuousChatViewProjection {
	readonly identity: string;
	requiredRevision(endMessage: number): number;
}

interface CacheLineFingerprint extends ContinuousChatCacheLine {
	readonly key: string;
	readonly text: string;
}

export interface ContinuousChatCacheFingerprint {
	readonly authority: string;
	readonly identity: string;
	readonly stableLines: number;
	readonly lines: readonly CacheLineFingerprint[];
}

export interface ContinuousChatCacheRewrite {
	readonly reason: "partition" | "reconciliation" | "partition-and-reconciliation";
	readonly before: string;
	readonly after: string;
}

export interface ContinuousChatCacheComparison {
	warning?: string;
	rewrite?: ContinuousChatCacheRewrite;
}

/** Validates host metadata against the actual block layout. No summary or pending-line text is interpreted. */
export function fingerprintContinuousChatCache(
	blocks: readonly TextContent[],
): ContinuousChatCacheFingerprint | undefined {
	const first = blocks[0];
	if (!first || !("icmCache" in first)) return undefined;
	const cache = first.icmCache;
	if (
		!isPlainRecord(cache) ||
		typeof cache.authority !== "string" ||
		!cache.authority ||
		!isNonNegativeSafeInteger(cache.stablePrefixLineCount) ||
		!Array.isArray(cache.lines)
	)
		return undefined;
	const texts = blocks
		.map((block) => block.text)
		.join("")
		.split("\n");
	if (
		texts.shift() !== "<chat>" ||
		texts.pop() !== "</chat>" ||
		texts.length !== cache.lines.length ||
		cache.stablePrefixLineCount > texts.length
	)
		return undefined;
	let end = 0;
	const lines: CacheLineFingerprint[] = [];
	for (const [index, value] of cache.lines.entries()) {
		const coordinate = parseContinuousChatNodeCoordinate(value);
		if (
			!coordinate ||
			!isPlainRecord(value) ||
			!isNonNegativeSafeInteger(value.projectionRevision) ||
			continuousChatNodeFirstMessage(coordinate) !== end
		)
			return undefined;
		end += continuousChatNodeMessageCount(coordinate.level);
		lines.push({
			...coordinate,
			projectionRevision: value.projectionRevision,
			key: continuousChatNodeKey(coordinate),
			text: texts[index]!,
		});
	}
	const marker = blocks.findLastIndex((block) => block.cacheBoundary === true);
	const stableLines =
		marker < 0
			? 0
			: blocks
					.slice(0, marker + 1)
					.map((block) => block.text)
					.join("")
					.split("\n").length - 2;
	if (stableLines > cache.stablePrefixLineCount) return undefined;
	return {
		authority: cache.authority,
		identity: createHash("sha256")
			.update(JSON.stringify([cache.authority, cache.lines]))
			.digest("hex"),
		stableLines,
		lines,
	};
}

/**
 * A partition can change a prefix's spelling without changing any node. Reconciliation can replace only rows whose
 * causal projection revision changed. Shared, previously stable coordinates must otherwise retain their exact text,
 * even when another row is being repartitioned or reconciled. A shorter causal view simply omits its trailing rows.
 */
export function compareContinuousChatCache(
	before: ContinuousChatCacheFingerprint,
	after: ContinuousChatCacheFingerprint,
): ContinuousChatCacheComparison {
	if (before.authority !== after.authority) return { warning: "chat view projection authority changed" };
	const current = new Map(after.lines.map((line) => [line.key, line]));
	const last = after.lines.at(-1);
	const currentEnd = last ? continuousChatNodeFirstMessage(last) + continuousChatNodeMessageCount(last.level) : 0;
	let partition = false;
	let reconciliation = false;
	for (const old of before.lines.slice(0, before.stableLines)) {
		if (continuousChatNodeFirstMessage(old) >= currentEnd) break;
		const line = current.get(old.key);
		if (!line) {
			partition = true;
			continue;
		}
		if (old.text === line.text) continue;
		if (old.projectionRevision !== line.projectionRevision) reconciliation = true;
		else return { warning: `chat view stable node ${old.key} changed without a projection revision` };
	}
	if (!partition && !reconciliation) return {};
	return {
		rewrite: {
			reason:
				partition && reconciliation ? "partition-and-reconciliation" : partition ? "partition" : "reconciliation",
			before: before.identity,
			after: after.identity,
		},
	};
}
