import { createHash } from "node:crypto";
import {
	type Api,
	type Context,
	harnessDeferredToolNames,
	type Message,
	type Model,
	TOOL_SCHEMA_SEARCH_NAME,
} from "@caupulican/pi-ai";
import { historyWorkFallback, providerMessagePrefix } from "@caupulican/pi-ai/history-work";
import { isImmutableHistoryMessage } from "../kernel/message-revision.ts";
import {
	type ContinuousChatCacheComparison,
	type ContinuousChatCacheFingerprint,
	type ContinuousChatCacheRewrite,
	compareContinuousChatCache,
	fingerprintContinuousChatCache,
} from "./memory/continuous-chat-cache.ts";
import { appendBoundedJsonLine } from "./util/bounded-jsonl.ts";

/**
 * Prompt-prefix stability. A provider caches the longest byte-identical prefix of a request, so a
 * miss starts at the first segment (system prompt, tool, message) that differs from the previous
 * request. The system prompt and the tool list must not change between requests (OpenAI Codex tracks
 * the same invariant as `tools_changed` and tests that tools are identical across requests), and the
 * marked chat-view prefix remains stable across overlapping blocks. The monitor compares each request
 * with its conversation's previous one and names the first changed segment. This detects prefix churn;
 * provider usage is still needed to establish cache hits or their billed cost.
 *
 * A conversation is a session, or one conversation of an isolated lane: a lane's requests share one
 * cache-affinity key (lane kind, model, system prompt), so two workers on one model are two
 * conversations under one key, and the first request of each starts its own prefix. Each worker's
 * tool set is its own grant (a worker for a third party's words is offered none of the owner's memory).
 *
 * It does not judge rewrites of already-sent messages. Those belong to the context shrinker, and the
 * cache custody guard classifies each one as a priced (sanctioned) rewrite or an unsanctioned break
 * and records it in the decision ledger; a second opinion here only flagged priced rewrites.
 *
 * `PI_CACHE_TRACE=<file>` collects recent request fingerprints with a hash and size per segment, in
 * wire order. It skips requests while a previous write is pending. No prompt text is written.
 */

/** Warnings reported per conversation before further changes are only counted. */
const MAX_REPORTS_PER_CONVERSATION = 5;
const MAX_TRACKED_CONVERSATIONS = 32;
const CACHE_TRACE_LIMITS = {
	maxBytes: 8 * 1024 * 1024,
	targetBytes: 4 * 1024 * 1024,
	maxRecords: 2048,
	fileMode: 0o600,
	lockRetries: 0,
};

const toolFreeRequests = new WeakSet<Context>();

/** The host authorized this exact wire request to withhold its tools for one response. */
export function markToolFreeCacheRequest(context: Context): void {
	if (!context.tools?.length) toolFreeRequests.add(context);
}

type SegmentFingerprint = [label: string, hash: string, chars: number];

function segment(label: string, value: unknown): SegmentFingerprint {
	const json = JSON.stringify(value) ?? "";
	return [label, createHash("sha1").update(json).digest("hex").slice(0, 12), json.length];
}

interface RequestFingerprint {
	model: string;
	system: SegmentFingerprint;
	/** The system prompt text, kept only to show where it changed; never written to the trace file. */
	systemText: string;
	/** The ICM view and its immutable source, kept for comparison and never written to the trace. */
	view: ChatView | undefined;
	viewSource: WeakRef<Message> | undefined;
	tools: SegmentFingerprint[];
	/**
	 * The deferred tools a harness-disclosed request's search tool lists, kept only to recognize activation; never
	 * written to the trace file. Activation appends those tools after the resident ones, a priced, sanctioned change.
	 */
	harnessDeferred: ReadonlySet<string> | undefined;
	messages: SegmentFingerprint[];
}

const CHAT_VIEW_OPENING = "<chat>\n";
const CHAT_VIEW_CLOSING = "</chat>";
/** A change in the last tenth of the previous view (a pending line becoming its summary) loses little; earlier ones are reported. */
const CHAT_VIEW_TAIL_FRACTION = 0.1;

/**
 * The ICM chat view of a request: the first user message holding a text block with `icmCache`, the provenance only the view
 * carries. A carried head (skills, authority, task directory, path legend) precedes it, so the view is not always message 0.
 */
const viewPositions = new WeakMap<readonly Message[], number>();
function chatViewIndex(messages: readonly Message[]): number {
	const proof = providerMessagePrefix(messages);
	const known = proof && viewPositions.get(messages);
	if (known !== undefined) return known;
	const prior = proof?.previous ? viewPositions.get(proof.previous) : undefined;
	let index = prior !== undefined && prior >= 0 && prior < proof!.count ? prior : -1;
	if (index < 0) {
		for (let i = prior === undefined ? 0 : proof!.count; i < messages.length; i++) {
			const message = messages[i]!;
			if (
				message.role === "user" &&
				typeof message.content !== "string" &&
				message.content.some((block) => block.type === "text" && "icmCache" in block)
			) {
				index = i;
				break;
			}
		}
	}
	if (proof) viewPositions.set(messages, index);
	return index;
}

interface ChatView {
	text: string;
	/** Text blocks through the last explicit cache marker. */
	cacheBlocks?: readonly string[];
	cache?: ContinuousChatCacheFingerprint;
}

/** The text of the ICM chat view when the request's view is that user message; undefined otherwise. */
function chatView(first: Message | undefined): ChatView | undefined {
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

function harnessDeferredCatalog(context: Context): ReadonlySet<string> | undefined {
	const search = context.tools?.find((tool) => tool.name === TOOL_SCHEMA_SEARCH_NAME);
	return search ? harnessDeferredToolNames(search) : undefined;
}

/**
 * The segment label of one request message. Under an ICM frame the head precedes the view, which is followed by the turn's state
 * and the turn's own messages, so the trace names each part of the frame; any other request keeps its position and role.
 */
function segmentLabel(messages: readonly Message[], viewIndex: number, index: number): string {
	const role = messages[index]?.role;
	if (viewIndex < 0) return `${index}:${role}`;
	if (index < viewIndex) return `frame:head:${index}`;
	if (index === viewIndex) return "frame:view";
	if (index === viewIndex + 1) return "frame:state";
	return `turn:${index - viewIndex - 2}:${role}`;
}

function fingerprintRequest(
	model: Model<Api>,
	context: Context,
	previous: RequestFingerprint | undefined,
	system: LineageSystem | undefined,
): RequestFingerprint {
	if (process.env.PI_CACHE_TRACE) historyWorkFallback(context.messages, "full-cache-trace-requested");
	const viewIndex = chatViewIndex(context.messages);
	const source = context.messages[viewIndex];
	const immutable = source && isImmutableHistoryMessage(source);
	const reused = immutable && previous?.viewSource?.deref() === source ? previous : undefined;
	const systemText = context.systemPrompt ?? "";
	return {
		model: `${model.provider}/${model.id}`,
		system: system?.systemText === systemText ? system.system : segment("system", systemText),
		systemText,
		view: reused ? reused.view : chatView(source),
		viewSource: reused?.viewSource ?? (immutable ? new WeakRef(source) : undefined),
		tools: (context.tools ?? []).map((tool) => segment(tool.name, tool)),
		harnessDeferred: harnessDeferredCatalog(context),
		messages: !process.env.PI_CACHE_TRACE
			? []
			: context.messages.map((message, index) =>
					segment(segmentLabel(context.messages, viewIndex, index), {
						role: message.role,
						content: message.content,
					}),
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
	// A deferred tool the harness activated (or dropped with the search that loaded it) is not prefix churn.
	const deferred = current.harnessDeferred ?? previous.harnessDeferred;
	const previousTools = deferred ? previous.tools.filter(([name]) => !deferred.has(name)) : previous.tools;
	const currentTools = deferred ? current.tools.filter(([name]) => !deferred.has(name)) : current.tools;
	if (
		previousTools.length !== currentTools.length ||
		previousTools.some(([name], i) => name !== currentTools[i]?.[0])
	) {
		const previousNames = new Set(previousTools.map(([name]) => name));
		const currentNames = new Set(currentTools.map(([name]) => name));
		const added = currentTools.filter(([name]) => !previousNames.has(name)).map(([name]) => `+${name}`);
		const removed = previousTools.filter(([name]) => !currentNames.has(name)).map(([name]) => `-${name}`);
		if (added.length > 0 || removed.length > 0) return `tool set changed (${[...added, ...removed].join(", ")})`;
	}
	for (let index = 0; index < previousTools.length; index++) {
		const before = previousTools[index];
		const after = currentTools[index];
		if (before === undefined || after === undefined) break;
		if (before[0] !== after[0]) return `tool order changed (${before[0]} became ${after[0]} at position ${index})`;
		if (before[1] !== after[1]) return `tool ${before[0]} changed (${before[2]} to ${after[2]} chars)`;
	}
	if (viewChange?.warning) return viewChange.warning;
	if (viewChange?.rewrite) return undefined;
	const beforeView = previous.view;
	const afterView = current.view;
	if (beforeView === afterView || !beforeView || !afterView) return undefined;
	// A shorter causal view can reuse the overlapping marked blocks. Pending lines after the marker
	// were never declared stable; replacing them does not rewrite that prefix.
	if (beforeView.cacheBlocks && afterView.cacheBlocks) {
		const count = Math.min(beforeView.cacheBlocks.length, afterView.cacheBlocks.length);
		for (let index = 0; index < count; index++) {
			const before = beforeView.cacheBlocks[index]!;
			const after = afterView.cacheBlocks[index]!;
			if (before !== after) return `chat view cache block ${index + 1} changed ${describeTextChange(before, after)}`;
		}
		return undefined;
	}
	// Requests without an explicit marker retain the heuristic for implicit prefix caching.
	return beforeView.text === afterView.text ? undefined : chatViewChange(beforeView.text, afterView.text);
}

type LineageSystem = Pick<RequestFingerprint, "model" | "system" | "systemText">;

/** Who sent a request, as the monitor keys it. */
export interface PromptPrefixRequest {
	/** The provider session id the request carries: the session's own, or an isolated lane's cache-affinity key. */
	readonly sessionId: string | undefined;
	/** The lane conversation the request belongs to when `sessionId` is a key several conversations share. */
	readonly conversationId: string | undefined;
	/**
	 * The variant of the session's system prompt the request sends (the owner's, or one with the owner's memory
	 * withheld). Omitted, every request is one lineage.
	 */
	readonly lineage: string | undefined;
}

export class PromptPrefixMonitor {
	private readonly previous = new Map<string, RequestFingerprint>();
	/** Per conversation, the system prompt each lineage last sent: each variant of a session's prompt is its own prefix. */
	private readonly lineageSystems = new Map<string, Map<string, LineageSystem>>();
	private readonly reports = new Map<string, number>();
	private traceWriting = false;

	/**
	 * Fingerprint a request, optionally trace it, and describe how it broke its conversation's previous request's
	 * prefix: the system prompt is compared with the same lineage's last request, tools and chat view with the
	 * conversation's last request. A conversation is the session id, or the lane conversation under its affinity key.
	 */
	check(model: Model<Api>, context: Context, request: PromptPrefixRequest): string | undefined {
		const { sessionId, conversationId } = request;
		const lineage = request.lineage ?? "";
		const key = conversationId === undefined ? (sessionId ?? "") : `${sessionId ?? ""}\u0000${conversationId}`;
		const previous = this.previous.get(key);
		const systems = this.lineageSystems.get(key) ?? new Map<string, LineageSystem>();
		const system = systems.get(lineage);
		const wire = fingerprintRequest(model, context, previous, system);
		// Keep the ordinary tool baseline across a host-authorized empty surface. The trace records the wire.
		const current =
			previous?.model === wire.model && wire.tools.length === 0 && toolFreeRequests.has(context)
				? { ...wire, tools: previous.tools, harnessDeferred: previous.harnessDeferred }
				: wire;
		systems.set(lineage, { model: current.model, system: current.system, systemText: current.systemText });
		this.lineageSystems.set(key, systems);
		const viewChange =
			previous?.view?.cache &&
			current.view?.cache &&
			previous.view !== current.view &&
			previous.model === current.model
				? compareContinuousChatCache(previous.view.cache, current.view.cache)
				: undefined;
		this.writeTrace(sessionId, conversationId, wire, viewChange?.rewrite);
		this.previous.delete(key);
		this.previous.set(key, current);
		while (this.previous.size > MAX_TRACKED_CONVERSATIONS) {
			const oldest = this.previous.keys().next().value;
			if (oldest === undefined) break;
			this.previous.delete(oldest);
			this.reports.delete(oldest);
			this.lineageSystems.delete(oldest);
		}
		if (previous === undefined) return undefined;
		const change = prefixChange(previous, current, viewChange, system);
		if (change === undefined) return undefined;
		const reported = (this.reports.get(key) ?? 0) + 1;
		this.reports.set(key, reported);
		if (reported > MAX_REPORTS_PER_CONVERSATION) return undefined;
		const suffix =
			reported === MAX_REPORTS_PER_CONVERSATION ? " Further changes in this conversation are not reported." : "";
		return `Prompt cache prefix changed between requests: ${change}. Cache reuse may be reduced from that point.${suffix}`;
	}

	private writeTrace(
		sessionId: string | undefined,
		conversationId: string | undefined,
		fingerprint: RequestFingerprint,
		viewRewrite: ContinuousChatCacheRewrite | undefined,
	): void {
		const path = process.env.PI_CACHE_TRACE;
		if (!path || this.traceWriting) return;
		const {
			systemText: _systemText,
			view: _view,
			viewSource: _viewSource,
			harnessDeferred: _harnessDeferred,
			...traced
		} = fingerprint;
		this.traceWriting = true;
		void appendBoundedJsonLine(
			path,
			{
				at: new Date().toISOString(),
				session: sessionId,
				...(conversationId ? { conversation: conversationId } : {}),
				...traced,
				...(viewRewrite ? { viewRewrite } : {}),
			},
			CACHE_TRACE_LIMITS,
		)
			.catch(() => undefined)
			.finally(() => {
				this.traceWriting = false;
			});
	}
}
