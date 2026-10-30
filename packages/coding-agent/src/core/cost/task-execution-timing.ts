import {
	isUnknownRecoveredToolResult,
	sessionLifecycleToolIdentityKey,
} from "../../kernel/session/lifecycle-ledger.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";

export interface TaskExecutionTiming {
	readonly activeMs: number;
	readonly requests: number;
	readonly toolCalls: number;
	readonly completedIntervals: number;
	readonly unresolvedIntervals: number;
	readonly lastEndMs?: number;
	readonly hasLifecycle: boolean;
}

interface TimingAccumulator {
	intervals: Array<{ start: number; end: number }>;
	requests: number;
	toolCalls: number;
	unresolvedIntervals: number;
}

/** Measure recorded operation intervals; overlapping tools consume wall time once. */
export function measureTaskExecutionTiming<Owner>(
	entries: readonly SessionEntry[],
	owners: ReadonlyMap<string, Owner>,
): ReadonlyMap<Owner, TaskExecutionTiming> {
	const clocks = new Map<Owner, TimingAccumulator>();
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const starts = new Map<string, { owner: Owner; start: number }>();
	const seenStarts = new Set<string>();
	const seenTerminals = new Set<string>();
	for (const entry of entries) {
		let key: string;
		let starting = false;
		let interrupted = false;
		let category: "provider" | "tool" | "compaction";
		switch (entry.type) {
			case "request_snapshot":
				category = "provider";
				key = `provider:${entry.requestId}`;
				starting = true;
				break;
			case "provider_request_terminal":
				category = "provider";
				key = `provider:${entry.requestId}`;
				interrupted = entry.outcome === "interrupted";
				break;
			case "foreground_tool_start":
			case "foreground_tool_terminal":
				category = "tool";
				key = `tool:${sessionLifecycleToolIdentityKey(entry.requestId, entry.assistantMessageEntryId, entry.callId)}`;
				starting = entry.type === "foreground_tool_start";
				break;
			case "compaction_start":
			case "compaction_end":
				category = "compaction";
				key = `compaction:${entry.compactionId}`;
				starting = entry.type === "compaction_start";
				interrupted = entry.type === "compaction_end" && entry.outcome === "interrupted";
				break;
			default:
				continue;
		}
		let at = Date.parse(entry.timestamp);
		if (entry.type === "foreground_tool_terminal") {
			const result = entriesById.get(entry.resultMessageEntryId);
			if (
				result?.type !== "message" ||
				result.message.role !== "toolResult" ||
				result.message.toolCallId !== entry.callId ||
				result.message.toolName !== entry.toolName ||
				isUnknownRecoveredToolResult(result.message)
			)
				interrupted = true;
			else at = Date.parse(result.timestamp);
		}
		if (starting) {
			const owner = owners.get(entry.id);
			if (owner === undefined) continue;
			let clock = clocks.get(owner);
			if (!clock) {
				clock = { intervals: [], requests: 0, toolCalls: 0, unresolvedIntervals: 0 };
				clocks.set(owner, clock);
			}
			if (seenStarts.has(key) || !Number.isFinite(at)) {
				clock.unresolvedIntervals++;
				continue;
			}
			seenStarts.add(key);
			if (category === "provider") clock.requests++;
			if (category === "tool") clock.toolCalls++;
			starts.set(key, { owner, start: at });
		} else {
			const started = starts.get(key);
			if (!started || seenTerminals.has(key)) continue;
			seenTerminals.add(key);
			starts.delete(key);
			const clock = clocks.get(started.owner)!;
			if (interrupted || !Number.isFinite(at) || at < started.start) clock.unresolvedIntervals++;
			else clock.intervals.push({ start: started.start, end: at });
		}
	}
	for (const { owner } of starts.values()) clocks.get(owner)!.unresolvedIntervals++;
	// Merge response identities with lifecycle identities so a partial ledger never
	// replaces known historical calls with zero or counts the same call twice.
	const counts = new Map<Owner, { requests: Set<string>; tools: Set<string> }>();
	const requestForEntry = new Map<string, string>();
	const assistantForEntry = new Map<string, Extract<SessionEntry, { type: "message" }>>();
	const responseRequests = new Map<string, string>();
	const resultTools = new Map<string, string>();
	const operationOwners = new Map<string, Owner>();
	for (const entry of entries) {
		const owner = owners.get(entry.id);
		const key =
			entry.type === "request_snapshot"
				? `request:${entry.requestId}`
				: entry.type === "foreground_tool_start"
					? sessionLifecycleToolIdentityKey(entry.requestId, entry.assistantMessageEntryId, entry.callId)
					: undefined;
		if (owner !== undefined && key && !operationOwners.has(key)) operationOwners.set(key, owner);
		if (entry.type === "provider_request_terminal" && entry.assistantMessageEntryId)
			responseRequests.set(entry.assistantMessageEntryId, entry.requestId);
		if (entry.type === "foreground_tool_terminal")
			resultTools.set(
				entry.resultMessageEntryId,
				sessionLifecycleToolIdentityKey(entry.requestId, entry.assistantMessageEntryId, entry.callId),
			);
	}
	for (const entry of entries) {
		const request =
			entry.type === "request_snapshot"
				? entry.requestId
				: entry.type === "provider_request_terminal"
					? undefined
					: entry.parentId
						? requestForEntry.get(entry.parentId)
						: undefined;
		if (request) requestForEntry.set(entry.id, request);
		const assistant =
			entry.type === "message" && entry.message.role === "assistant"
				? entry
				: entry.parentId
					? assistantForEntry.get(entry.parentId)
					: undefined;
		if (assistant) assistantForEntry.set(entry.id, assistant);
		let countKey: string | undefined;
		let tool = false;
		if (entry.type === "request_snapshot") countKey = `request:${entry.requestId}`;
		else if (entry.type === "foreground_tool_start") {
			tool = true;
			countKey = sessionLifecycleToolIdentityKey(entry.requestId, entry.assistantMessageEntryId, entry.callId);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const responseRequest = responseRequests.get(entry.id) ?? (entry.origin !== "local" ? request : undefined);
			countKey = responseRequest ? `request:${responseRequest}` : `response:${entry.id}`;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			tool = true;
			countKey = resultTools.get(entry.id);
			const callId = entry.message.toolCallId;
			if (
				!countKey &&
				assistant?.message.role === "assistant" &&
				assistant.message.content.some((block) => block.type === "toolCall" && block.id === callId)
			)
				countKey = sessionLifecycleToolIdentityKey(requestForEntry.get(assistant.id), assistant.id, callId);
			countKey ??= `result:${entry.id}`;
		}
		if (!countKey) continue;
		const owner = operationOwners.get(countKey) ?? owners.get(entry.id);
		if (owner === undefined) continue;
		operationOwners.set(countKey, owner);
		let count = counts.get(owner);
		if (!count) {
			count = { requests: new Set(), tools: new Set() };
			counts.set(owner, count);
		}
		if (tool) count.tools.add(countKey);
		else count.requests.add(countKey);
	}
	const measured = new Map<Owner, TaskExecutionTiming>();
	for (const owner of new Set([...clocks.keys(), ...counts.keys()])) {
		const clock = clocks.get(owner) ?? { intervals: [], requests: 0, toolCalls: 0, unresolvedIntervals: 0 };
		clock.intervals.sort((left, right) => left.start - right.start || left.end - right.end);
		let start: number | undefined;
		let end = 0;
		let activeMs = 0;
		for (const interval of clock.intervals) {
			if (start === undefined) {
				start = interval.start;
				end = interval.end;
			} else if (interval.start <= end) end = Math.max(end, interval.end);
			else {
				activeMs += end - start;
				start = interval.start;
				end = interval.end;
			}
		}
		if (start !== undefined) activeMs += end - start;
		measured.set(owner, {
			activeMs,
			requests: counts.get(owner)?.requests.size ?? clock.requests,
			toolCalls: counts.get(owner)?.tools.size ?? clock.toolCalls,
			hasLifecycle: clocks.has(owner),
			completedIntervals: clock.intervals.length,
			unresolvedIntervals: clock.unresolvedIntervals,
			...(clock.intervals.length > 0 ? { lastEndMs: end } : {}),
		});
	}
	return measured;
}
