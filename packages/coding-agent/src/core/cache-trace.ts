import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { Api, Context, Message, Model } from "@caupulican/pi-ai";
import {
	type ContinuousChatCacheComparison,
	type ContinuousChatCacheFingerprint,
	type ContinuousChatCacheRewrite,
	compareContinuousChatCache,
	fingerprintContinuousChatCache,
} from "./memory/continuous-chat-cache.ts";

/**
 * Prompt-prefix stability. A provider caches the longest byte-identical prefix of a request, so a
 * miss starts at the first segment (system prompt, tool, message) that differs from the previous
 * request. The system prompt and the tool list must not change between requests (OpenAI Codex tracks
 * the same invariant as `tools_changed` and tests that tools are identical across requests), and the
 * marked chat-view prefix remains stable across overlapping blocks. The monitor compares each request
 * with the session's previous one and names the first changed segment. This detects prefix churn;
 * provider usage is still needed to establish cache hits or their billed cost.
 *
 * It does not judge rewrites of already-sent messages. Those belong to the context shrinker, and the
 * cache custody guard classifies each one as a priced (sanctioned) rewrite or an unsanctioned break
 * and records it in the decision ledger; a second opinion here only flagged priced rewrites.
 *
 * `PI_CACHE_TRACE=<file>` additionally appends one JSON line per request with a hash and size per
 * segment, in wire order. No prompt text is written.
 */

/** Warnings reported per session before further changes are only counted. */
const MAX_REPORTS_PER_SESSION = 5;
const MAX_TRACKED_SESSIONS = 32;

function digest(value: unknown): string {
	return createHash("sha1")
		.update(JSON.stringify(value) ?? "")
		.digest("hex")
		.slice(0, 12);
}

type SegmentFingerprint = [label: string, hash: string, chars: number];

function segment(label: string, value: unknown): SegmentFingerprint {
	return [label, digest(value), (JSON.stringify(value) ?? "").length];
}

interface RequestFingerprint {
	model: string;
	system: SegmentFingerprint;
	/** The system prompt text, kept only to show where it changed; never written to the trace file. */
	systemText: string;
	/** The ICM chat view the request opens with, kept only to compare it across turns; never written to the trace file. */
	viewText: string | undefined;
	/** Text blocks through the last explicit cache marker; their boundaries are part of the prefix. */
	viewCacheBlocks: readonly string[] | undefined;
	viewCache: ContinuousChatCacheFingerprint | undefined;
	tools: SegmentFingerprint[];
	messages: SegmentFingerprint[];
}

const CHAT_VIEW_OPENING = "<chat>\n";
const CHAT_VIEW_CLOSING = "</chat>";
/** A change in the last tenth of the previous view (a pending line becoming its summary) loses little; earlier ones are reported. */
const CHAT_VIEW_TAIL_FRACTION = 0.1;

/** The text of the ICM chat view when the request's first message is that view; undefined otherwise. */
function chatView(
	messages: readonly Message[],
): { text: string; cacheBlocks?: readonly string[]; cache?: ContinuousChatCacheFingerprint } | undefined {
	const first = messages[0];
	if (first?.role !== "user" || typeof first.content === "string") return undefined;
	const text = first.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	if (!text.startsWith(CHAT_VIEW_OPENING)) return undefined;
	const marker = first.content.findLastIndex((block) => block.type === "text" && block.cacheBoundary === true);
	const blocks = first.content.slice(0, marker + 1);
	const cache = first.content.every((block) => block.type === "text")
		? fingerprintContinuousChatCache(first.content)
		: undefined;
	return {
		text,
		...(cache ? { cache } : {}),
		...((marker >= 0 || cache !== undefined) && blocks.every((block) => block.type === "text")
			? { cacheBlocks: blocks.map((block) => block.text) }
			: {}),
	};
}

/**
 * A new turn rebuilds its chat view. A provider caches the byte-identical prefix, so the cache survives the turn
 * only while the view grows at its end: the old text, up to its closing tag, must open the new text, apart from
 * the old tail where a pending line may turn into its summary.
 */
function chatViewChange(before: string, after: string): string | undefined {
	const body = before.endsWith(CHAT_VIEW_CLOSING) ? before.length - CHAT_VIEW_CLOSING.length : before.length;
	const stable = Math.floor(body * (1 - CHAT_VIEW_TAIL_FRACTION));
	let index = 0;
	const limit = Math.min(before.length, after.length);
	while (index < limit && before.charCodeAt(index) === after.charCodeAt(index)) index++;
	if (index >= stable) return undefined;
	const line = before.slice(0, index).split("\n").length - 1;
	return `chat view changed at char ${index} of ${before.length} (line ${line}): ${snippet(before, index)} became ${snippet(after, index)}`;
}

function fingerprintRequest(model: Model<Api>, context: Context): RequestFingerprint {
	const view = chatView(context.messages);
	return {
		model: `${model.provider}/${model.id}`,
		system: segment("system", context.systemPrompt ?? ""),
		systemText: context.systemPrompt ?? "",
		viewText: view?.text,
		viewCacheBlocks: view?.cacheBlocks,
		viewCache: view?.cache,
		tools: (context.tools ?? []).map((tool) => segment(tool.name, tool)),
		messages: context.messages.map((message, index) =>
			segment(`${index}:${message.role}`, { role: message.role, content: message.content }),
		),
	};
}

const CHANGE_SNIPPET_CHARS = 70;

function snippet(text: string, from: number): string {
	return JSON.stringify(text.slice(Math.max(0, from - 20), from + CHANGE_SNIPPET_CHARS));
}

/** Where two texts first differ, with a short bounded excerpt of each side. */
function describeTextChange(before: string, after: string): string {
	let index = 0;
	const limit = Math.min(before.length, after.length);
	while (index < limit && before.charCodeAt(index) === after.charCodeAt(index)) index++;
	return `from char ${index} of ${before.length}: ${snippet(before, index)} became ${snippet(after, index)}`;
}

/**
 * Why `current` does not extend `previous`'s cached prefix, or undefined when it does. The system prompt is compared
 * with `system`, the last request of the same prompt lineage (none: a lineage's first request starts its own prefix).
 */
function prefixChange(
	previous: RequestFingerprint,
	current: RequestFingerprint,
	viewChange: ContinuousChatCacheComparison | undefined,
	system: LineageSystem | undefined,
): string | undefined {
	if (previous.model !== current.model) return undefined;
	if (system && system.model === current.model && system.system[1] !== current.system[1]) {
		return `system prompt changed (${system.system[2]} to ${current.system[2]} chars) ${describeTextChange(system.systemText, current.systemText)}`;
	}
	const previousNames = previous.tools.map(([name]) => name);
	const currentNames = current.tools.map(([name]) => name);
	const added = currentNames.filter((name) => !previousNames.includes(name));
	const removed = previousNames.filter((name) => !currentNames.includes(name));
	if (added.length > 0 || removed.length > 0) {
		return `tool set changed (${[...added.map((name) => `+${name}`), ...removed.map((name) => `-${name}`)].join(", ")})`;
	}
	for (let index = 0; index < previous.tools.length; index++) {
		const before = previous.tools[index];
		const after = current.tools[index];
		if (before === undefined || after === undefined) break;
		if (before[0] !== after[0]) return `tool order changed (${before[0]} became ${after[0]} at position ${index})`;
		if (before[1] !== after[1]) return `tool ${before[0]} changed (${before[2]} to ${after[2]} chars)`;
	}
	if (viewChange?.warning) return viewChange.warning;
	if (viewChange?.rewrite) return undefined;
	// A shorter causal view can reuse the overlapping marked blocks. Pending lines after the marker
	// were never declared stable; replacing them does not rewrite that prefix.
	if (previous.viewCacheBlocks && current.viewCacheBlocks) {
		const count = Math.min(previous.viewCacheBlocks.length, current.viewCacheBlocks.length);
		for (let index = 0; index < count; index++) {
			const before = previous.viewCacheBlocks[index]!;
			const after = current.viewCacheBlocks[index]!;
			if (before !== after) return `chat view cache block ${index + 1} changed ${describeTextChange(before, after)}`;
		}
		return undefined;
	}
	// Requests without an explicit marker retain the heuristic for implicit prefix caching.
	return previous.viewText !== undefined && current.viewText !== undefined
		? chatViewChange(previous.viewText, current.viewText)
		: undefined;
}

type LineageSystem = Pick<RequestFingerprint, "model" | "system" | "systemText">;

export class PromptPrefixMonitor {
	private readonly previous = new Map<string, RequestFingerprint>();
	/** Per session, the system prompt each lineage last sent: each variant of a session's prompt is its own prefix. */
	private readonly lineageSystems = new Map<string, Map<string, LineageSystem>>();
	private readonly reports = new Map<string, number>();
	private readonly viewRewrites = new Map<string, ContinuousChatCacheRewrite>();

	/** Latest bounded, sanctioned ICM rewrite; ordinary append and node-publication changes do not replace it. */
	lastChatRewrite(sessionId: string | undefined): ContinuousChatCacheRewrite | undefined {
		return this.viewRewrites.get(sessionId ?? "");
	}

	/**
	 * Fingerprint a request, optionally trace it, and describe how it broke the previous request's prefix. `lineage`
	 * names the variant of the session's system prompt the request sends (the owner's, or one with the owner's memory
	 * withheld): its system prompt is compared with the same lineage's last request, its tools and chat view with the
	 * session's last request. Omitted, every request is one lineage.
	 */
	check(model: Model<Api>, context: Context, sessionId: string | undefined, lineage = ""): string | undefined {
		const key = sessionId ?? "";
		const current = fingerprintRequest(model, context);
		const previous = this.previous.get(key);
		const systems = this.lineageSystems.get(key) ?? new Map<string, LineageSystem>();
		const system = systems.get(lineage);
		systems.set(lineage, { model: current.model, system: current.system, systemText: current.systemText });
		this.lineageSystems.set(key, systems);
		const viewChange =
			previous?.viewCache && current.viewCache && previous.model === current.model
				? compareContinuousChatCache(previous.viewCache, current.viewCache)
				: undefined;
		if (viewChange?.rewrite) this.viewRewrites.set(key, viewChange.rewrite);
		this.writeTrace(sessionId, current, viewChange?.rewrite);
		this.previous.delete(key);
		this.previous.set(key, current);
		while (this.previous.size > MAX_TRACKED_SESSIONS) {
			const oldest = this.previous.keys().next().value;
			if (oldest === undefined) break;
			this.previous.delete(oldest);
			this.reports.delete(oldest);
			this.viewRewrites.delete(oldest);
			this.lineageSystems.delete(oldest);
		}
		if (previous === undefined) return undefined;
		const change = prefixChange(previous, current, viewChange, system);
		if (change === undefined) return undefined;
		const reported = (this.reports.get(key) ?? 0) + 1;
		this.reports.set(key, reported);
		if (reported > MAX_REPORTS_PER_SESSION) return undefined;
		const suffix = reported === MAX_REPORTS_PER_SESSION ? " Further changes in this session are not reported." : "";
		return `Prompt cache prefix changed between requests: ${change}. Cache reuse may be reduced from that point.${suffix}`;
	}

	private writeTrace(
		sessionId: string | undefined,
		fingerprint: RequestFingerprint,
		viewRewrite: ContinuousChatCacheRewrite | undefined,
	): void {
		const path = process.env.PI_CACHE_TRACE;
		if (!path) return;
		const {
			systemText: _systemText,
			viewText: _viewText,
			viewCacheBlocks: _viewCacheBlocks,
			viewCache: _viewCache,
			...traced
		} = fingerprint;
		appendFileSync(
			path,
			`${JSON.stringify({ at: new Date().toISOString(), session: sessionId, ...traced, ...(viewRewrite ? { viewRewrite } : {}) })}\n`,
		);
	}
}
