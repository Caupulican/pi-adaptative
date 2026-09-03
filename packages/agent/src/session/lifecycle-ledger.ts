import type { SessionEntry, SessionEntryBase, SessionMessageEntry } from "./session-manager.ts";
import { collectSessionBranch } from "./session-tree.ts";

/** Maximum serialized size for one lifecycle payload. Lifecycle records are a ledger, not a payload store. */
export const MAX_LIFECYCLE_PAYLOAD_CHARS = 32 * 1024;
const MAX_LIFECYCLE_STRING_CHARS = 4 * 1024;
const MAX_LIFECYCLE_ARRAY_ITEMS = 256;
const MAX_EXTERNAL_ID_CHARS = 512;

export interface RequestSnapshotEntry extends SessionEntryBase {
	type: "request_snapshot";
	requestId: string;
	reason: "initial" | "resume" | "change";
	api: string;
	provider: string;
	modelId: string;
	effectiveConfigFingerprint: string;
	systemFingerprint: string;
	toolsFingerprint: string;
	historyFingerprint: string;
	messageEntryIds: string[];
}

export type SessionRequestSnapshotInput = Omit<RequestSnapshotEntry, "type" | "id" | "parentId" | "timestamp">;

export interface ForegroundToolStartEntry extends SessionEntryBase {
	type: "foreground_tool_start";
	requestId: string;
	assistantMessageEntryId: string;
	callId: string;
	toolName: string;
}

export type ForegroundToolStartInput = Omit<ForegroundToolStartEntry, "type" | "id" | "parentId" | "timestamp">;

export interface ForegroundToolTerminalEntry extends SessionEntryBase {
	type: "foreground_tool_terminal";
	requestId: string;
	assistantMessageEntryId: string;
	callId: string;
	toolName: string;
	outcome: "success" | "error" | "cancelled";
	resultMessageEntryId: string;
	errorKind?: "tool_failure" | "operation_outcome";
}

export interface CompactionStartEntry extends SessionEntryBase {
	type: "compaction_start";
	compactionId: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Estimated tokens handed to the summarizer, for the census gate against `tokensBefore`. */
	summarizerInputTokens?: number;
}

export interface CompactionEndEntry extends SessionEntryBase {
	type: "compaction_end";
	compactionId: string;
	/** `fallback`: a facts-only checkpoint was applied because no summarizer accepted a summary. */
	outcome: "success" | "failure" | "cancelled" | "interrupted" | "fallback";
	compactionEntryId?: string;
	error?: string;
}

export type SessionLifecycleEntry =
	| RequestSnapshotEntry
	| ForegroundToolStartEntry
	| ForegroundToolTerminalEntry
	| CompactionStartEntry
	| CompactionEndEntry;

export const TOOL_NOT_STARTED = "TOOL_NOT_STARTED";
export const TOOL_OUTCOME_UNKNOWN = "TOOL_OUTCOME_UNKNOWN";

function lifecycleValidationError(path: string, detail: string): TypeError {
	return new TypeError(`Invalid session lifecycle field ${path}: ${detail}`);
}

function assertBoundedString(value: unknown, path: string, max = MAX_LIFECYCLE_STRING_CHARS): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) {
		throw lifecycleValidationError(path, `expected a non-empty string of at most ${max} characters`);
	}
	if (/[\u0000-\u001f\u007f]/u.test(value) || value.trim() !== value) {
		throw lifecycleValidationError(path, "control characters and surrounding whitespace are not allowed");
	}
}

function assertSessionEntryId(value: unknown, path: string): asserts value is string {
	assertBoundedString(value, path);
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value)) {
		throw lifecycleValidationError(path, "expected a session-safe identifier");
	}
}

/** External provider/tool identifiers may contain ':' and '|'; only bounded text is assumed. */
function assertExternalId(value: unknown, path: string): asserts value is string {
	assertBoundedString(value, path, MAX_EXTERNAL_ID_CHARS);
}

function assertCanonicalIsoTimestamp(value: unknown, path: string): asserts value is string {
	assertBoundedString(value, path, 128);
	const timestamp = new Date(value);
	if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
		throw lifecycleValidationError(path, "expected a canonical ISO timestamp with milliseconds and Z");
	}
}

function assertNonNegativeSafeInteger(value: unknown, path: string): asserts value is number {
	if (typeof value !== "number" || Object.is(value, -0) || !Number.isSafeInteger(value) || value < 0) {
		throw lifecycleValidationError(path, "expected a non-negative safe integer other than -0");
	}
}

function assertRecordKeys(value: Record<string, unknown>, expected: readonly string[]): void {
	const allowed = new Set(expected);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw lifecycleValidationError(key, "unknown field");
	}
}

function fieldsForType(type: string): readonly string[] {
	switch (type) {
		case "request_snapshot":
			return [
				"requestId",
				"reason",
				"api",
				"provider",
				"modelId",
				"effectiveConfigFingerprint",
				"systemFingerprint",
				"toolsFingerprint",
				"historyFingerprint",
				"messageEntryIds",
			];
		case "foreground_tool_start":
			return ["requestId", "assistantMessageEntryId", "callId", "toolName"];
		case "foreground_tool_terminal":
			return [
				"requestId",
				"assistantMessageEntryId",
				"callId",
				"toolName",
				"outcome",
				"resultMessageEntryId",
				"errorKind",
			];
		case "compaction_start":
			return ["compactionId", "firstKeptEntryId", "tokensBefore", "summarizerInputTokens"];
		case "compaction_end":
			return ["compactionId", "outcome", "compactionEntryId", "error"];
		default:
			return [];
	}
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
	if (!Array.isArray(value) || value.length > MAX_LIFECYCLE_ARRAY_ITEMS) {
		throw lifecycleValidationError(path, `expected at most ${MAX_LIFECYCLE_ARRAY_ITEMS} identifiers`);
	}
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		assertSessionEntryId(value[index], `${path}[${index}]`);
		if (seen.has(value[index])) throw lifecycleValidationError(`${path}[${index}]`, "duplicate identifier");
		seen.add(value[index]);
	}
}

/** Runtime validation for all persisted lifecycle records. */
export function validateSessionLifecycleEntry(value: unknown): asserts value is SessionLifecycleEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw lifecycleValidationError("entry", "expected an object");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.type !== "string" || fieldsForType(record.type).length === 0) {
		throw lifecycleValidationError("type", "unknown lifecycle entry type");
	}
	assertRecordKeys(record, ["type", "id", "parentId", "timestamp", ...fieldsForType(record.type)]);
	assertSessionEntryId(record.id, "id");
	if (record.parentId !== null) assertSessionEntryId(record.parentId, "parentId");
	assertCanonicalIsoTimestamp(record.timestamp, "timestamp");

	switch (record.type) {
		case "request_snapshot":
			assertExternalId(record.requestId, "requestId");
			if (record.reason !== "initial" && record.reason !== "resume" && record.reason !== "change") {
				throw lifecycleValidationError("reason", "expected initial, resume, or change");
			}
			assertBoundedString(record.api, "api", 256);
			assertBoundedString(record.provider, "provider", 256);
			assertBoundedString(record.modelId, "modelId", 256);
			assertBoundedString(record.effectiveConfigFingerprint, "effectiveConfigFingerprint");
			assertBoundedString(record.systemFingerprint, "systemFingerprint");
			assertBoundedString(record.toolsFingerprint, "toolsFingerprint");
			assertBoundedString(record.historyFingerprint, "historyFingerprint");
			assertStringArray(record.messageEntryIds, "messageEntryIds");
			break;
		case "foreground_tool_start":
			assertExternalId(record.requestId, "requestId");
			assertSessionEntryId(record.assistantMessageEntryId, "assistantMessageEntryId");
			assertExternalId(record.callId, "callId");
			assertBoundedString(record.toolName, "toolName", 256);
			break;
		case "foreground_tool_terminal":
			assertExternalId(record.requestId, "requestId");
			assertSessionEntryId(record.assistantMessageEntryId, "assistantMessageEntryId");
			assertExternalId(record.callId, "callId");
			assertBoundedString(record.toolName, "toolName", 256);
			if (record.outcome !== "success" && record.outcome !== "error" && record.outcome !== "cancelled") {
				throw lifecycleValidationError("outcome", "expected success, error, or cancelled");
			}
			assertSessionEntryId(record.resultMessageEntryId, "resultMessageEntryId");
			if (
				record.errorKind !== undefined &&
				record.errorKind !== "tool_failure" &&
				record.errorKind !== "operation_outcome"
			) {
				throw lifecycleValidationError("errorKind", "expected tool_failure or operation_outcome");
			}
			if (record.outcome === "error" && record.errorKind === undefined) {
				throw lifecycleValidationError("errorKind", "error outcomes require an error kind");
			}
			if (record.outcome !== "error" && record.errorKind !== undefined) {
				throw lifecycleValidationError("errorKind", "only error outcomes may carry an error kind");
			}
			break;
		case "compaction_start":
			assertExternalId(record.compactionId, "compactionId");
			assertSessionEntryId(record.firstKeptEntryId, "firstKeptEntryId");
			assertNonNegativeSafeInteger(record.tokensBefore, "tokensBefore");
			if (record.summarizerInputTokens !== undefined) {
				assertNonNegativeSafeInteger(record.summarizerInputTokens, "summarizerInputTokens");
			}
			break;
		case "compaction_end":
			assertExternalId(record.compactionId, "compactionId");
			if (
				record.outcome !== "success" &&
				record.outcome !== "failure" &&
				record.outcome !== "cancelled" &&
				record.outcome !== "interrupted" &&
				record.outcome !== "fallback"
			) {
				throw lifecycleValidationError("outcome", "expected success, failure, cancelled, interrupted, or fallback");
			}
			if (record.outcome === "success") {
				assertSessionEntryId(record.compactionEntryId, "compactionEntryId");
				if ("error" in record)
					throw lifecycleValidationError("error", "successful compactions cannot carry an error");
			} else if (record.outcome === "fallback") {
				assertSessionEntryId(record.compactionEntryId, "compactionEntryId");
			} else {
				if ("compactionEntryId" in record) {
					throw lifecycleValidationError("compactionEntryId", "only successful compactions may carry an entry id");
				}
				if (record.outcome === "failure" && !record.error) {
					throw lifecycleValidationError("error", "failure outcomes require a bounded error");
				}
				if ("error" in record) assertBoundedString(record.error, "error", MAX_LIFECYCLE_PAYLOAD_CHARS);
			}
			break;
	}
}

function assertLifecycleEntries(entries: readonly (SessionEntry | { type: "session" })[]): void {
	for (const entry of entries) {
		if (entry.type !== "session" && isSessionLifecycleEntry(entry)) encodeSessionLifecycleEntry(entry);
	}
}

export function isSessionLifecycleEntry(entry: SessionEntry): entry is SessionLifecycleEntry {
	return fieldsForType(entry.type).length > 0;
}

export function validateLoadedLifecycleEntries(entries: readonly (SessionEntry | { type: "session" })[]): void {
	assertLifecycleEntries(entries);
}

export function encodeSessionLifecycleEntry(entry: SessionLifecycleEntry): string {
	validateSessionLifecycleEntry(entry);
	const encoded = JSON.stringify(entry);
	if (encoded.length > MAX_LIFECYCLE_PAYLOAD_CHARS) {
		throw lifecycleValidationError("entry", `serialized record exceeds ${MAX_LIFECYCLE_PAYLOAD_CHARS} characters`);
	}
	return encoded;
}

export function decodeSessionLifecycleEntry(value: unknown): SessionLifecycleEntry {
	validateSessionLifecycleEntry(value);
	encodeSessionLifecycleEntry(value);
	return value;
}

export function encodeSessionEntry(entry: SessionEntry): string {
	return isSessionLifecycleEntry(entry) ? encodeSessionLifecycleEntry(entry) : JSON.stringify(entry);
}

export interface SessionLifecycleAssistantToolCall {
	requestId?: string;
	assistantMessageEntryId: string;
	callId: string;
	modelOrder: number;
	position: number;
	toolName: string;
}

export interface SessionLifecycleToolResult {
	requestId?: string;
	assistantMessageEntryId?: string;
	callId: string;
	resultMessageEntryId: string;
	position: number;
	toolName: string;
	isError: boolean;
	errorKind?: "tool_failure" | "operation_outcome";
}

export interface SessionLifecycleToolRecord {
	starts: readonly ForegroundToolStartEntry[];
	terminals: readonly ForegroundToolTerminalEntry[];
	assistantCalls: readonly SessionLifecycleAssistantToolCall[];
	results: readonly SessionLifecycleToolResult[];
	start?: ForegroundToolStartEntry;
	terminal?: ForegroundToolTerminalEntry;
	result?: SessionLifecycleToolResult;
}

export interface SessionLifecycleCompactionRecord {
	starts: readonly CompactionStartEntry[];
	ends: readonly CompactionEndEntry[];
	start?: CompactionStartEntry;
	end?: CompactionEndEntry;
}

function createToolRecord(): SessionLifecycleToolRecord {
	return { starts: [], terminals: [], assistantCalls: [], results: [] };
}

function createCompactionRecord(): SessionLifecycleCompactionRecord {
	return { starts: [], ends: [] };
}

export interface SessionLifecycleIndex {
	branchEntryIds: readonly string[];
	entryPositions: ReadonlyMap<string, number>;
	entryTypes: ReadonlyMap<string, string>;
	entriesById: ReadonlyMap<string, SessionEntry>;
	requestSnapshots: readonly RequestSnapshotEntry[];
	assistantToolCalls: readonly SessionLifecycleAssistantToolCall[];
	toolResults: readonly SessionLifecycleToolResult[];
	toolsByIdentity: ReadonlyMap<string, SessionLifecycleToolRecord>;
	compactionsById: ReadonlyMap<string, SessionLifecycleCompactionRecord>;
	ambiguousResultEntryIds: readonly string[];
	unmatchedResultEntryIds: readonly string[];
}

export interface SessionLifecycleUnstartedTool {
	requestId?: string;
	assistantMessageEntryId: string;
	toolName: string;
	callId: string;
}

export interface SessionLifecycleUnknownToolOutcome {
	requestId: string;
	assistantMessageEntryId: string;
	toolName: string;
	callId: string;
	startEntryId: string;
}

export interface SessionLifecycleTerminalPromotion {
	requestId?: string;
	assistantMessageEntryId: string;
	toolName: string;
	callId: string;
	resultMessageEntryId: string;
	outcome: "success" | "error";
	errorKind?: "tool_failure" | "operation_outcome";
}

export interface SessionLifecycleInspection extends SessionLifecycleIndex {
	refusalReasons: readonly string[];
	duplicateRequestSnapshots: readonly RequestSnapshotEntry[];
	unmatchedToolStarts: readonly ForegroundToolStartEntry[];
	unmatchedToolTerminals: readonly ForegroundToolTerminalEntry[];
	duplicateToolStarts: readonly ForegroundToolStartEntry[];
	duplicateToolTerminals: readonly ForegroundToolTerminalEntry[];
	duplicateAssistantToolCalls: readonly SessionLifecycleAssistantToolCall[];
	duplicateToolResults: readonly SessionLifecycleToolResult[];
	mismatchedToolEntries: readonly string[];
	outOfOrderToolEntries: readonly string[];
	unstartedTools: readonly SessionLifecycleUnstartedTool[];
	unknownToolOutcomes: readonly SessionLifecycleUnknownToolOutcome[];
	unmatchedCompactionEnds: readonly CompactionEndEntry[];
	duplicateCompactionStarts: readonly CompactionStartEntry[];
	duplicateCompactionEnds: readonly CompactionEndEntry[];
	outOfOrderCompactionEntries: readonly string[];
	invalidCompactionReferences: readonly string[];
	orphanedCompactions: readonly CompactionStartEntry[];
	terminalPromotions: readonly SessionLifecycleTerminalPromotion[];
	balanced: boolean;
}

export interface SessionLifecycleRepairPlan {
	refused: boolean;
	refusalReasons: readonly string[];
	toolClosers: readonly {
		requestId?: string;
		assistantMessageEntryId: string;
		toolName: string;
		callId: string;
		code: typeof TOOL_NOT_STARTED | typeof TOOL_OUTCOME_UNKNOWN;
		sourceEntryId?: string;
	}[];
	terminalPromotions: readonly SessionLifecycleTerminalPromotion[];
	compactionClosers: readonly {
		compactionId: string;
		sourceEntryId: string;
		outcome: "interrupted";
	}[];
}

export function sessionLifecycleToolIdentityKey(
	requestId: string | undefined,
	assistantMessageEntryId: string,
	callId: string,
): string {
	return JSON.stringify([requestId ?? null, assistantMessageEntryId, callId]);
}

function assistantToolKey(assistantMessageEntryId: string, callId: string): string {
	return JSON.stringify([assistantMessageEntryId, callId]);
}

function requestCallKey(requestId: string | undefined, callId: string): string {
	return JSON.stringify([requestId ?? null, callId]);
}

export function indexSessionLifecycle(entries: readonly SessionEntry[], leafId?: string | null): SessionLifecycleIndex {
	const branch = collectSessionBranch(entries, leafId);
	const entryPositions = new Map<string, number>();
	const entryTypes = new Map<string, string>();
	const entriesById = new Map<string, SessionEntry>();
	for (let position = 0; position < branch.length; position += 1) {
		entryPositions.set(branch[position]!.id, position);
		entryTypes.set(branch[position]!.id, branch[position]!.type);
		entriesById.set(branch[position]!.id, branch[position]!);
	}
	const requestSnapshots = branch.filter((entry): entry is RequestSnapshotEntry => entry.type === "request_snapshot");
	const requestAtPosition: Array<RequestSnapshotEntry | undefined> = [];
	let currentRequest: RequestSnapshotEntry | undefined;
	for (let position = 0; position < branch.length; position += 1) {
		const entry = branch[position]!;
		if (entry.type === "request_snapshot") currentRequest = entry;
		requestAtPosition[position] = currentRequest;
	}
	const assistantToolCalls: SessionLifecycleAssistantToolCall[] = [];
	const assistantCallsByMessageCall = new Map<string, SessionLifecycleAssistantToolCall[]>();
	const pendingCallsByRequestAndCall = new Map<string, SessionLifecycleAssistantToolCall[]>();
	const completedCallsByRequestAndCall = new Map<string, SessionLifecycleAssistantToolCall>();
	const ambiguousResultEntryIds: string[] = [];
	const unmatchedResultEntryIds: string[] = [];
	const toolResults: SessionLifecycleToolResult[] = [];
	const createToolResult = (
		call: SessionLifecycleAssistantToolCall,
		entry: SessionMessageEntry,
		position: number,
	): SessionLifecycleToolResult => {
		if (entry.message.role !== "toolResult") throw new TypeError("Expected a tool result message entry.");
		return {
			requestId: call.requestId,
			assistantMessageEntryId: call.assistantMessageEntryId,
			callId: entry.message.toolCallId,
			resultMessageEntryId: entry.id,
			position,
			toolName: entry.message.toolName,
			isError: entry.message.isError,
			...(entry.message.isError
				? { errorKind: entry.message.errorKind ?? "tool_failure" }
				: entry.message.errorKind === undefined
					? {}
					: { errorKind: entry.message.errorKind }),
		};
	};
	for (let position = 0; position < branch.length; position += 1) {
		const entry = branch[position]!;
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			const request = requestAtPosition[position];
			for (const block of entry.message.content) {
				if (block.type !== "toolCall") continue;
				const call: SessionLifecycleAssistantToolCall = {
					requestId: request?.requestId,
					assistantMessageEntryId: entry.id,
					callId: block.id,
					modelOrder: assistantToolCalls.length,
					position,
					toolName: block.name,
				};
				assistantToolCalls.push(call);
				const messageCallKey = assistantToolKey(call.assistantMessageEntryId, call.callId);
				const messageCalls = assistantCallsByMessageCall.get(messageCallKey) ?? [];
				messageCalls.push(call);
				assistantCallsByMessageCall.set(messageCallKey, messageCalls);
				const requestKey = requestCallKey(call.requestId, call.callId);
				const pendingCalls = pendingCallsByRequestAndCall.get(requestKey) ?? [];
				pendingCalls.push(call);
				pendingCallsByRequestAndCall.set(requestKey, pendingCalls);
			}
		} else if (entry.message.role === "toolResult") {
			const request = requestAtPosition[position];
			const requestKey = requestCallKey(request?.requestId, entry.message.toolCallId);
			const pendingCalls = pendingCallsByRequestAndCall.get(requestKey);
			if (!pendingCalls || pendingCalls.length !== 1) {
				if (pendingCalls && pendingCalls.length > 1) ambiguousResultEntryIds.push(entry.id);
				else {
					const completedCall = completedCallsByRequestAndCall.get(requestKey);
					if (completedCall) toolResults.push(createToolResult(completedCall, entry, position));
					else unmatchedResultEntryIds.push(entry.id);
				}
				continue;
			}
			const call = pendingCalls.pop()!;
			completedCallsByRequestAndCall.set(requestKey, call);
			toolResults.push(createToolResult(call, entry, position));
		}
	}

	const toolsByIdentity = new Map<string, SessionLifecycleToolRecord>();
	const resultByIdentity = new Map<string, SessionLifecycleToolResult[]>();
	for (const result of toolResults) {
		const key = sessionLifecycleToolIdentityKey(result.requestId, result.assistantMessageEntryId!, result.callId);
		const results = resultByIdentity.get(key) ?? [];
		results.push(result);
		resultByIdentity.set(key, results);
	}
	for (const call of assistantToolCalls) {
		const key = sessionLifecycleToolIdentityKey(call.requestId, call.assistantMessageEntryId, call.callId);
		const record = toolsByIdentity.get(key) ?? createToolRecord();
		(record.assistantCalls as SessionLifecycleAssistantToolCall[]).push(call);
		const results = resultByIdentity.get(key);
		if (results) {
			(record.results as SessionLifecycleToolResult[]).push(...results);
			if (!record.result) record.result = results[0];
		}
		toolsByIdentity.set(key, record);
	}

	const legacyAliases = new Map<string, string>();
	const lifecycleRecord = (
		requestId: string,
		assistantMessageEntryId: string,
		callId: string,
	): SessionLifecycleToolRecord => {
		const key = sessionLifecycleToolIdentityKey(requestId, assistantMessageEntryId, callId);
		const direct = toolsByIdentity.get(key);
		if (direct) return direct;
		const messageCallKey = assistantToolKey(assistantMessageEntryId, callId);
		const candidates = assistantCallsByMessageCall.get(messageCallKey) ?? [];
		if (candidates.length === 1 && candidates[0]!.requestId === undefined) {
			const previousKey = legacyAliases.get(messageCallKey);
			if (previousKey !== undefined && previousKey !== key) {
				const unmatched = createToolRecord();
				toolsByIdentity.set(key, unmatched);
				return unmatched;
			}
			const legacyKey = sessionLifecycleToolIdentityKey(undefined, assistantMessageEntryId, callId);
			const legacyRecord = toolsByIdentity.get(legacyKey);
			if (legacyRecord) {
				toolsByIdentity.delete(legacyKey);
				toolsByIdentity.set(key, legacyRecord);
				legacyAliases.set(messageCallKey, key);
				return legacyRecord;
			}
		}
		const record = createToolRecord();
		toolsByIdentity.set(key, record);
		return record;
	};

	const compactionsById = new Map<string, SessionLifecycleCompactionRecord>();
	for (const entry of branch) {
		if (entry.type === "foreground_tool_start") {
			const record = lifecycleRecord(entry.requestId, entry.assistantMessageEntryId, entry.callId);
			(record.starts as ForegroundToolStartEntry[]).push(entry);
			if (!record.start) record.start = entry;
		} else if (entry.type === "foreground_tool_terminal") {
			const record = lifecycleRecord(entry.requestId, entry.assistantMessageEntryId, entry.callId);
			(record.terminals as ForegroundToolTerminalEntry[]).push(entry);
			if (!record.terminal) record.terminal = entry;
		} else if (entry.type === "compaction_start") {
			const record = compactionsById.get(entry.compactionId) ?? createCompactionRecord();
			(record.starts as CompactionStartEntry[]).push(entry);
			if (!record.start) record.start = entry;
			compactionsById.set(entry.compactionId, record);
		} else if (entry.type === "compaction_end") {
			const record = compactionsById.get(entry.compactionId) ?? createCompactionRecord();
			(record.ends as CompactionEndEntry[]).push(entry);
			if (!record.end) record.end = entry;
			compactionsById.set(entry.compactionId, record);
		}
	}
	return {
		branchEntryIds: branch.map((entry) => entry.id),
		entryPositions,
		entryTypes,
		entriesById,
		requestSnapshots,
		assistantToolCalls,
		toolResults,
		toolsByIdentity,
		compactionsById,
		ambiguousResultEntryIds,
		unmatchedResultEntryIds,
	};
}

function resultForRecord(record: SessionLifecycleToolRecord): SessionLifecycleToolResult | undefined {
	return record.result ?? record.results[0];
}

export function inspectSessionLifecycle(
	entries: readonly SessionEntry[],
	leafId?: string | null,
): SessionLifecycleInspection {
	const index = indexSessionLifecycle(entries, leafId);
	const duplicateRequestSnapshots: RequestSnapshotEntry[] = [];
	const requestIds = new Set<string>();
	for (const request of index.requestSnapshots) {
		if (requestIds.has(request.requestId)) duplicateRequestSnapshots.push(request);
		requestIds.add(request.requestId);
	}
	const unmatchedToolStarts: ForegroundToolStartEntry[] = [];
	const unmatchedToolTerminals: ForegroundToolTerminalEntry[] = [];
	const duplicateToolStarts: ForegroundToolStartEntry[] = [];
	const duplicateToolTerminals: ForegroundToolTerminalEntry[] = [];
	const duplicateAssistantToolCalls: SessionLifecycleAssistantToolCall[] = [];
	const duplicateToolResults: SessionLifecycleToolResult[] = [];
	const mismatchedToolEntries: string[] = [];
	const outOfOrderToolEntries: string[] = [];
	const unstartedTools: SessionLifecycleUnstartedTool[] = [];
	const unknownToolOutcomes: SessionLifecycleUnknownToolOutcome[] = [];
	const terminalPromotions: SessionLifecycleTerminalPromotion[] = [];
	for (const record of index.toolsByIdentity.values()) {
		if (record.starts.length > 1) duplicateToolStarts.push(...record.starts.slice(1));
		if (record.terminals.length > 1) duplicateToolTerminals.push(...record.terminals.slice(1));
		if (record.assistantCalls.length > 1) duplicateAssistantToolCalls.push(...record.assistantCalls.slice(1));
		if (record.results.length > 1) duplicateToolResults.push(...record.results.slice(1));
		if (record.assistantCalls.length === 0) {
			unmatchedToolStarts.push(...record.starts);
			unmatchedToolTerminals.push(...record.terminals);
			continue;
		}
		const call = record.assistantCalls[0]!;
		const start = record.start;
		const terminal = record.terminal;
		const result = resultForRecord(record);
		if (start && start.toolName !== call.toolName) mismatchedToolEntries.push(start.id);
		if (terminal && terminal.toolName !== call.toolName) mismatchedToolEntries.push(terminal.id);
		if (result && result.toolName !== call.toolName) mismatchedToolEntries.push(result.resultMessageEntryId);
		if (start && index.entryPositions.get(start.id)! < call.position) outOfOrderToolEntries.push(start.id);
		if (terminal && start && index.entryPositions.get(terminal.id)! < index.entryPositions.get(start.id)!)
			outOfOrderToolEntries.push(terminal.id);
		if (result && result.position < call.position) outOfOrderToolEntries.push(result.resultMessageEntryId);
		if (terminal && result && (index.entryPositions.get(terminal.id) ?? -1) < result.position) {
			outOfOrderToolEntries.push(terminal.id);
		}
		if (terminal?.resultMessageEntryId !== undefined && !result)
			outOfOrderToolEntries.push(terminal.resultMessageEntryId);
		if (terminal && !start) mismatchedToolEntries.push(terminal.id);
		if (result) {
			if (!result.isError && result.errorKind !== undefined) {
				mismatchedToolEntries.push(result.resultMessageEntryId);
			}
			const terminalMatches =
				terminal?.resultMessageEntryId === result.resultMessageEntryId &&
				terminal.outcome === (result.isError ? "error" : "success") &&
				terminal.errorKind === result.errorKind;
			if (terminal && !terminalMatches) {
				mismatchedToolEntries.push(terminal.id);
			}
			if (start && !terminal) {
				terminalPromotions.push({
					...(start?.requestId === undefined && call.requestId === undefined
						? {}
						: { requestId: start?.requestId ?? call.requestId }),
					assistantMessageEntryId: call.assistantMessageEntryId,
					toolName: call.toolName,
					callId: call.callId,
					resultMessageEntryId: result.resultMessageEntryId,
					outcome: result.isError ? "error" : "success",
					...(result.errorKind === undefined ? {} : { errorKind: result.errorKind }),
				});
			}
		} else if (!start) {
			unstartedTools.push({
				requestId: call.requestId,
				assistantMessageEntryId: call.assistantMessageEntryId,
				toolName: call.toolName,
				callId: call.callId,
			});
		} else {
			if (terminal) mismatchedToolEntries.push(terminal.id);
			unknownToolOutcomes.push({
				requestId: call.requestId ?? start.requestId,
				assistantMessageEntryId: call.assistantMessageEntryId,
				toolName: call.toolName,
				callId: call.callId,
				startEntryId: start.id,
			});
		}
	}

	const unmatchedCompactionEnds: CompactionEndEntry[] = [];
	const duplicateCompactionStarts: CompactionStartEntry[] = [];
	const duplicateCompactionEnds: CompactionEndEntry[] = [];
	const outOfOrderCompactionEntries: string[] = [];
	const invalidCompactionReferences: string[] = [];
	const orphanedCompactions: CompactionStartEntry[] = [];
	for (const [compactionId, record] of index.compactionsById) {
		if (record.starts.length > 1) duplicateCompactionStarts.push(...record.starts.slice(1));
		if (record.ends.length > 1) duplicateCompactionEnds.push(...record.ends.slice(1));
		if (!record.start && record.end) unmatchedCompactionEnds.push(record.end);
		if (record.start) {
			const startPosition = index.entryPositions.get(record.start.id);
			const firstKeptPosition = index.entryPositions.get(record.start.firstKeptEntryId);
			if (firstKeptPosition === undefined || startPosition === undefined || firstKeptPosition >= startPosition) {
				invalidCompactionReferences.push(compactionId);
			}
			if (!record.end) orphanedCompactions.push(record.start);
			if (record.end?.outcome === "success") {
				const compactionPosition = record.end.compactionEntryId
					? index.entryPositions.get(record.end.compactionEntryId)
					: undefined;
				const compactionEntry = record.end.compactionEntryId
					? index.entriesById.get(record.end.compactionEntryId)
					: undefined;
				const finalFirstKeptPosition =
					compactionEntry?.type === "compaction"
						? index.entryPositions.get(compactionEntry.firstKeptEntryId)
						: undefined;
				if (
					!record.end.compactionEntryId ||
					index.entryTypes.get(record.end.compactionEntryId) !== "compaction" ||
					compactionPosition === undefined ||
					startPosition === undefined ||
					compactionPosition <= startPosition ||
					(index.entryPositions.get(record.end.id) ?? -1) <= compactionPosition ||
					compactionEntry?.type !== "compaction" ||
					finalFirstKeptPosition === undefined ||
					finalFirstKeptPosition >= compactionPosition
				) {
					invalidCompactionReferences.push(compactionId);
				}
			}
			if (
				record.end &&
				startPosition !== undefined &&
				(index.entryPositions.get(record.end.id) ?? -1) < startPosition
			) {
				outOfOrderCompactionEntries.push(record.end.id);
			}
		}
	}
	const refusalReasons = [
		...(index.ambiguousResultEntryIds.length > 0 ? ["ambiguous tool-result association"] : []),
		...(index.unmatchedResultEntryIds.length > 0 ? ["unmatched tool-result association"] : []),
		...(duplicateRequestSnapshots.length > 0 ? ["duplicate request snapshots"] : []),
		...(unmatchedToolStarts.length > 0 ? ["unmatched lifecycle tool starts"] : []),
		...(unmatchedToolTerminals.length > 0 ? ["unmatched lifecycle tool terminals"] : []),
		...(duplicateToolStarts.length > 0 ? ["duplicate lifecycle tool starts"] : []),
		...(duplicateToolTerminals.length > 0 ? ["duplicate lifecycle tool terminals"] : []),
		...(duplicateAssistantToolCalls.length > 0 ? ["duplicate assistant tool calls"] : []),
		...(duplicateToolResults.length > 0 ? ["duplicate tool results"] : []),
		...(mismatchedToolEntries.length > 0 ? ["mismatched tool metadata"] : []),
		...(outOfOrderToolEntries.length > 0 ? ["out-of-order tool lifecycle"] : []),
		...(duplicateCompactionStarts.length > 0 ? ["duplicate compaction starts"] : []),
		...(duplicateCompactionEnds.length > 0 ? ["duplicate compaction ends"] : []),
		...(unmatchedCompactionEnds.length > 0 ? ["unmatched compaction ends"] : []),
		...(outOfOrderCompactionEntries.length > 0 ? ["out-of-order compaction lifecycle"] : []),
		...(invalidCompactionReferences.length > 0 ? ["invalid compaction references"] : []),
	];
	return {
		...index,
		refusalReasons,
		duplicateRequestSnapshots,
		unmatchedToolStarts,
		unmatchedToolTerminals,
		duplicateToolStarts,
		duplicateToolTerminals,
		duplicateAssistantToolCalls,
		duplicateToolResults,
		mismatchedToolEntries,
		outOfOrderToolEntries,
		unstartedTools,
		unknownToolOutcomes,
		unmatchedCompactionEnds,
		duplicateCompactionStarts,
		duplicateCompactionEnds,
		outOfOrderCompactionEntries,
		invalidCompactionReferences,
		orphanedCompactions,
		terminalPromotions,
		balanced:
			refusalReasons.length === 0 &&
			unstartedTools.length === 0 &&
			unknownToolOutcomes.length === 0 &&
			terminalPromotions.length === 0 &&
			orphanedCompactions.length === 0,
	};
}

export function planSessionLifecycleRepair(
	entries: readonly SessionEntry[],
	leafId?: string | null,
): SessionLifecycleRepairPlan {
	const inspection = inspectSessionLifecycle(entries, leafId);
	const refused = inspection.refusalReasons.length > 0;
	if (refused) {
		return {
			refused: true,
			refusalReasons: inspection.refusalReasons,
			toolClosers: [],
			terminalPromotions: [],
			compactionClosers: [],
		};
	}
	const toolClosers: SessionLifecycleRepairPlan["toolClosers"][number][] = [
		...inspection.unstartedTools.map((tool) => ({
			...tool,
			code: (tool.requestId === undefined ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED) as
				| typeof TOOL_NOT_STARTED
				| typeof TOOL_OUTCOME_UNKNOWN,
		})),
		...inspection.unknownToolOutcomes.map((tool) => ({
			requestId: tool.requestId,
			assistantMessageEntryId: tool.assistantMessageEntryId,
			toolName: tool.toolName,
			callId: tool.callId,
			code: TOOL_OUTCOME_UNKNOWN as typeof TOOL_OUTCOME_UNKNOWN,
			sourceEntryId: tool.startEntryId,
		})),
	];
	return {
		refused: false,
		refusalReasons: [],
		toolClosers,
		terminalPromotions: inspection.terminalPromotions,
		compactionClosers: inspection.orphanedCompactions.map((start) => ({
			compactionId: start.compactionId,
			sourceEntryId: start.id,
			outcome: "interrupted" as const,
		})),
	};
}
