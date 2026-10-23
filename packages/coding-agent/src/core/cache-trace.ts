import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { Api, Context, Message, Model } from "@caupulican/pi-ai";

/**
 * Prompt-prefix stability. A provider caches the longest byte-identical prefix of a request, so a
 * miss starts at the first segment (system prompt, tool, message) that differs from the previous
 * request. Within one turn the system prompt, the tool list and every earlier message must be
 * unchanged (OpenAI Codex tracks the same invariant as `tools_changed` and tests that tools are
 * identical across requests). The monitor compares each request with the session's previous one and
 * names the first segment that changed, so a cache miss is reported when it happens.
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
	tools: SegmentFingerprint[];
	messages: SegmentFingerprint[];
	/** True when the request continues a turn: its last message is a tool result. */
	continuation: boolean;
}

const CHAT_VIEW_OPENING = "<chat>\n";
const CHAT_VIEW_CLOSING = "</chat>";
/** A change in the last tenth of the previous view (a pending line becoming its summary) loses little; earlier ones are reported. */
const CHAT_VIEW_TAIL_FRACTION = 0.1;

/** The text of the ICM chat view when the request's first message is that view; undefined otherwise. */
function chatViewText(messages: readonly Message[]): string | undefined {
	const first = messages[0];
	if (first?.role !== "user" || typeof first.content === "string") return undefined;
	const text = first.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	return text.startsWith(CHAT_VIEW_OPENING) ? text : undefined;
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
	return {
		model: `${model.provider}/${model.id}`,
		system: segment("system", context.systemPrompt ?? ""),
		systemText: context.systemPrompt ?? "",
		viewText: chatViewText(context.messages),
		tools: (context.tools ?? []).map((tool) => segment(tool.name, tool)),
		messages: context.messages.map((message, index) =>
			segment(`${index}:${message.role}`, { role: message.role, content: message.content }),
		),
		continuation: context.messages.at(-1)?.role === "toolResult",
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

/** Why `current` does not extend `previous`'s cached prefix, or undefined when it does. */
function prefixChange(previous: RequestFingerprint, current: RequestFingerprint): string | undefined {
	if (previous.model !== current.model) return undefined;
	if (previous.system[1] !== current.system[1]) {
		return `system prompt changed (${previous.system[2]} to ${current.system[2]} chars) ${describeTextChange(previous.systemText, current.systemText)}`;
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
	// Earlier messages are only fixed within a turn. A new turn rebuilds its frame, but the chat view in it must keep
	// the previous view as its prefix.
	if (!current.continuation) {
		return previous.viewText !== undefined && current.viewText !== undefined
			? chatViewChange(previous.viewText, current.viewText)
			: undefined;
	}
	for (let index = 0; index < previous.messages.length; index++) {
		const before = previous.messages[index];
		const after = current.messages[index];
		if (before === undefined) break;
		if (after === undefined) return `message ${before[0]} is missing from the continuation`;
		if (before[1] !== after[1]) return `message ${before[0]} changed (${before[2]} to ${after[2]} chars)`;
	}
	return undefined;
}

export class PromptPrefixMonitor {
	private readonly previous = new Map<string, RequestFingerprint>();
	private readonly reports = new Map<string, number>();

	/** Fingerprint a request, optionally trace it, and describe how it broke the previous request's prefix. */
	check(model: Model<Api>, context: Context, sessionId: string | undefined): string | undefined {
		const key = sessionId ?? "";
		const current = fingerprintRequest(model, context);
		this.writeTrace(sessionId, current);
		const previous = this.previous.get(key);
		this.previous.delete(key);
		this.previous.set(key, current);
		while (this.previous.size > MAX_TRACKED_SESSIONS) {
			const oldest = this.previous.keys().next().value;
			if (oldest === undefined) break;
			this.previous.delete(oldest);
			this.reports.delete(oldest);
		}
		if (previous === undefined) return undefined;
		const change = prefixChange(previous, current);
		if (change === undefined) return undefined;
		const reported = (this.reports.get(key) ?? 0) + 1;
		this.reports.set(key, reported);
		if (reported > MAX_REPORTS_PER_SESSION) return undefined;
		const suffix = reported === MAX_REPORTS_PER_SESSION ? " Further changes in this session are not reported." : "";
		return `Prompt cache prefix changed between requests: ${change}. The provider re-bills the prompt from that point at full price.${suffix}`;
	}

	private writeTrace(sessionId: string | undefined, fingerprint: RequestFingerprint): void {
		const path = process.env.PI_CACHE_TRACE;
		if (!path) return;
		const { systemText: _systemText, viewText: _viewText, ...traced } = fingerprint;
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), session: sessionId, ...traced })}\n`);
	}
}
