import {
	getToolExecutionAttemptMemory,
	getToolExecutionErrorPolicy,
	type ToolFailurePhase,
} from "@caupulican/pi-ai/tool-repair-registry";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai/types";
import {
	MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT,
	mandatoryToolFailureRecoveryMetadata,
	TOOL_FAILURE_READMISSION_RULE,
} from "./tool-failure-recovery-protocol.ts";
import type { AgentMessage, AgentToolCall, AgentToolResult } from "./types.ts";
import { sanitizeBinaryOutput } from "./utils/shell-output.ts";

/** Stable kind identity for the durable, append-on-change ledger record (see transient-records.ts).
 * Never changes across the life of a conversation - it is the join key `reconcileTransientRecords`
 * uses to find the last recorded instance in durable history. */
export const TOOL_FAILURE_LEDGER_TRANSIENT_KIND = "pi_tool_failure_ledger";
/** The one-line header a pointer-mode ledger carries instead of the full protocol text. */
export const TOOL_FAILURE_PROTOCOL_POINTER =
	"TOOL FAILURE RECOVERY: the MANDATORY TOOL FAILURE RECOVERY protocol in the system prompt applies to every record below.";
/**
 * Text for the durable record appended the moment the ledger empties (no active records, no active
 * directives - see transient-records.ts's `TransientRecordSlot.clearedText`). Without this explicit
 * record, append-on-change would leave the most recent ACTIVE ledger sitting in history with nothing
 * after it saying otherwise - indistinguishable, to a reader of the raw transcript, from "still
 * active, unchanged since it was last sent".
 */
export const TOOL_FAILURE_LEDGER_CLEARED_TEXT =
	"MANDATORY TOOL FAILURE RECOVERY\nEvery tool failure that was active earlier in this conversation " +
	"has since cleared (superseded by a matching success or resolved). No ledger entry is currently " +
	"active; no recovery protocol constraint from this ledger currently applies.";
const TOOL_FAILURE_MEMORY_VERSION = 1;
const TOOL_FAILURE_DIRECTIVE_VERSION = 1;
const TOOL_FAILURE_EXECUTION_KEY = Symbol("ToolFailureExecutionKey");
/**
 * Identity over the arguments exactly as the model wrote them, resource-envelope fields included.
 *
 * Execution identity deliberately ignores those fields — a bound is not the work (see
 * `OPERATION_ENVELOPE_KEYS`). A schema rejection judges the literal argument object, so for a
 * validation failure the omitted field can be the whole of what the harness asked to change.
 * Process-internal and never serialized, like its execution-key sibling.
 */
const TOOL_FAILURE_RAW_KEY = Symbol("ToolFailureRawKey");
const MAX_OPERATION_CHARS = 240;
const MAX_FAILURE_CODE_CHARS = 48;
const MAX_DIAGNOSTIC_CHARS = 240;
const MAX_CORRECTION_CHARS = 480;
const MAX_TOOL_FAILURE_EVIDENCE_CHARS = 1_600;
const MAX_TOOL_NAME_CHARS = 64;
const TOOL_SIGNATURE_HEX_CHARS = 32;
const TOOL_FALLBACK_OUTPUT_SIGNATURE_BASE62_CHARS = 22;
const TOOL_OUTPUT_SIGNATURE_BASE64URL_CHARS = 43;
const LEGACY_TOOL_OUTPUT_SIGNATURE_HEX_CHARS = 64;
const MAX_ACTIVE_FAILURES = 8;
const MAX_TRACKED_FAILURES = 64;
const REPAIRABLE_REJECTION_CODES = new Set(["invalid_arguments", "malformed_call", "unknown_tool"]);
const LEGACY_GENERIC_EXECUTION_CORRECTION =
	"Change the arguments or approach before retrying; do not resend the unchanged operation.";
const BLOCKED_REPLAY_CORRECTION = `Not executed: its last result is already above. Do corrective work or use a different operation. ${TOOL_FAILURE_READMISSION_RULE}`;

export type ToolFailureState = "failed" | "rejected";

export interface ToolFailureMemoryRecord {
	version: typeof TOOL_FAILURE_MEMORY_VERSION;
	failureKey: string;
	/** Exact identity is process-internal and omitted from serialized failure memory. */
	readonly [TOOL_FAILURE_EXECUTION_KEY]?: string;
	/** Envelope-retaining identity; process-internal and omitted from serialized failure memory. */
	readonly [TOOL_FAILURE_RAW_KEY]?: string;
	tool: string;
	operation: string;
	occurrence: number;
	kindMistakes?: number;
	mistakeKind?: string;
	state: ToolFailureState;
	phase: ToolFailurePhase;
	failureCode: string;
	/** Tool-owned full-output digest, or a fallback result-text digest; used only to distinguish recovery episodes. */
	outputSignature?: string;
	diagnostic?: string;
	/** Bounded result-scoped harness notice (replay block, circuit state); never displaces the retained diagnostic. */
	note?: string;
	/** Bounded tool-owned source evidence needed to construct a changed operation. */
	evidence?: string;
	correction: string;
	attemptMemory?: "discard";
}

export interface ToolFailureOutputIdentity {
	/** Complete tool output when available, otherwise the complete bounded result returned to the agent. */
	output: string;
	/** Optional tool-owned digest of output that was not retained in the bounded result. */
	outputSignature?: string;
}

export interface ToolFailureMemoryDetails {
	piToolFailureMemory: ToolFailureMemoryRecord;
}

export interface ToolFailureDirectiveDetails {
	piToolFailureDirective: {
		version: typeof TOOL_FAILURE_DIRECTIVE_VERSION;
		state: ToolFailureState;
		phase: ToolFailurePhase;
		failureCode: string;
		diagnostic?: string;
		nextAction: string;
	};
}

export type ToolFailureResultDetails = ToolFailureMemoryDetails | ToolFailureDirectiveDetails;

export type ToolFailureMemoryTracker = Map<string, ToolFailureMemoryRecord>;

interface ToolOperationIdentity {
	failureKey: string;
	executionKey: string;
	rawKey: string;
	tool: string;
	operation: string;
}

interface ActiveFailure {
	record: ToolFailureMemoryRecord;
	sequence: number;
	/** Later calls of the same tool that executed without being this operation; see resolveToolFailures. */
	laterCalls: number;
}

interface FailureContextAnalysis {
	messages: AgentMessage[];
	activeRecords: ToolFailureMemoryRecord[];
	activeDirectives: ToolFailureDirectiveDetails["piToolFailureDirective"][];
	kindMistakesSummary: Record<string, number>;
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	let end = maxChars - 1;
	const code = value.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end--;
	return `${value.slice(0, end)}…`;
}

/** Normalize and bound tool-owned evidence at every live and persisted ingress. */
export function sanitizeToolFailureEvidence(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const sanitized = sanitizeBinaryOutput(value).trim();
	return sanitized ? truncate(sanitized, MAX_TOOL_FAILURE_EVIDENCE_CHARS) : undefined;
}

function truncateMiddle(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const available = maxChars - 1;
	let headEnd = Math.ceil(available / 2);
	let tailStart = value.length - Math.floor(available / 2);
	const headCode = value.charCodeAt(headEnd - 1);
	if (headCode >= 0xd800 && headCode <= 0xdbff) headEnd--;
	const tailCode = value.charCodeAt(tailStart);
	if (tailCode >= 0xdc00 && tailCode <= 0xdfff) tailStart++;
	return `${value.slice(0, headEnd)}…${value.slice(tailStart)}`;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return "[unserializable]";
	}
}

interface SignatureHash {
	first: number;
	second: number;
	third: number;
	fourth: number;
}

const VOLATILE_SIGNATURE_PATTERN =
	/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|(\d{4}-\d{2}-\d{2}[tT][0-9:.]+(?:z|[+-]\d{2}:?\d{2})?)|(\b[0-9a-f]{16,}\b)|(\d{10,})/gi;
const MAX_SIGNATURE_DEPTH = 128;
const MAX_PREVIEW_DEPTH = 6;
const MAX_PREVIEW_ITEMS = 8;
const MAX_PREVIEW_STRING_CHARS = 96;

function updateHashCode(hash: SignatureHash, code: number): void {
	hash.first = Math.imul(hash.first ^ code, 0x01000193);
	hash.second = Math.imul(hash.second ^ code, 0x85ebca6b);
	hash.third = Math.imul(hash.third ^ code, 0x27d4eb2d);
	hash.fourth = Math.imul(hash.fourth ^ code, 0x165667b1);
}

function updateHashRange(hash: SignatureHash, value: string, start = 0, end = value.length): void {
	for (let index = start; index < end; index++) updateHashCode(hash, value.charCodeAt(index));
}

function updateNormalizedHashString(hash: SignatureHash, value: string): void {
	if (value.length < 10) {
		updateExactHashString(hash, value);
		return;
	}
	VOLATILE_SIGNATURE_PATTERN.lastIndex = 0;
	let offset = 0;
	let normalizedLength = value.length;
	for (const match of value.matchAll(VOLATILE_SIGNATURE_PATTERN)) {
		const index = match.index;
		updateHashRange(hash, value, offset, index);
		const replacement = match[1] ? "<uuid>" : match[2] ? "<ts>" : match[3] ? "<hex>" : "<num>";
		updateHashRange(hash, replacement);
		normalizedLength += replacement.length - match[0].length;
		offset = index + match[0].length;
	}
	updateHashRange(hash, value, offset);
	updateHashRange(hash, `:${normalizedLength};`);
}

function updateExactHashString(hash: SignatureHash, value: string): void {
	updateHashRange(hash, value);
	updateHashRange(hash, `:${value.length};`);
}

function updateStructuredHash(
	hash: SignatureHash,
	value: unknown,
	active: Set<object>,
	depth: number,
	updateHashString: (hash: SignatureHash, value: string) => void,
): void {
	if (depth > MAX_SIGNATURE_DEPTH) {
		updateHashRange(hash, "depth;");
		return;
	}
	if (value === null) {
		updateHashRange(hash, "null;");
		return;
	}
	switch (typeof value) {
		case "string":
			updateHashRange(hash, "string:");
			updateHashString(hash, value);
			return;
		case "number":
			updateHashRange(hash, "number:");
			updateHashString(hash, Object.is(value, -0) ? "-0" : String(value));
			return;
		case "boolean":
			updateHashRange(hash, value ? "true;" : "false;");
			return;
		case "undefined":
			updateHashRange(hash, "undefined;");
			return;
		case "bigint":
			updateHashRange(hash, `bigint:${value.toString()};`);
			return;
		case "symbol":
			updateHashRange(hash, `symbol:${String(value.description ?? "")};`);
			return;
		case "function":
			updateHashRange(hash, `function:${value.name};`);
			return;
		case "object":
			break;
	}

	if (active.has(value)) {
		updateHashRange(hash, "circular;");
		return;
	}
	active.add(value);
	if (Array.isArray(value)) {
		updateHashRange(hash, `array:${value.length}[`);
		for (const item of value) updateStructuredHash(hash, item, active, depth + 1, updateHashString);
		updateHashRange(hash, "];");
	} else {
		const keys = Object.keys(value).sort();
		updateHashRange(hash, `object:${keys.length}{`);
		for (const key of keys) {
			updateHashString(hash, key);
			updateStructuredHash(hash, (value as Record<string, unknown>)[key], active, depth + 1, updateHashString);
		}
		updateHashRange(hash, "};");
	}
	active.delete(value);
}

function createSignatureHash(): SignatureHash {
	return {
		first: 0x811c9dc5,
		second: 0x9e3779b9,
		third: 0x85ebca6b,
		fourth: 0xc2b2ae35,
	};
}

function renderSignatureHash(hash: SignatureHash): string {
	return [hash.first, hash.second, hash.third, hash.fourth]
		.map((part) => (part >>> 0).toString(16).padStart(8, "0"))
		.join("");
}

const COMPACT_SIGNATURE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function renderCompactSignatureHash(hash: SignatureHash): string {
	let remaining =
		(BigInt(hash.first >>> 0) << 96n) |
		(BigInt(hash.second >>> 0) << 64n) |
		(BigInt(hash.third >>> 0) << 32n) |
		BigInt(hash.fourth >>> 0);
	let output = "";
	for (let index = 0; index < TOOL_FALLBACK_OUTPUT_SIGNATURE_BASE62_CHARS; index++) {
		output = COMPACT_SIGNATURE_ALPHABET[Number(remaining % 62n)] + output;
		remaining /= 62n;
	}
	return output;
}

function calculateStructuredHash(value: unknown, normalizeVolatile: boolean): SignatureHash {
	const hash = createSignatureHash();
	updateStructuredHash(
		hash,
		value,
		new Set(),
		0,
		normalizeVolatile ? updateNormalizedHashString : updateExactHashString,
	);
	return hash;
}

function structuredHash(value: unknown, normalizeVolatile: boolean): string {
	return renderSignatureHash(calculateStructuredHash(value, normalizeVolatile));
}

function structuredOutputSignature(output: string): string {
	return renderCompactSignatureHash(calculateStructuredHash(output, false));
}

function boundedJsonPreview(value: unknown, maxChars: number): string {
	let output = "";
	let exhausted = false;
	const active = new Set<object>();
	const append = (text: string): void => {
		if (exhausted) return;
		const available = maxChars - output.length;
		if (text.length <= available) {
			output += text;
			return;
		}
		if (available > 1) output += `${text.slice(0, available - 1)}…`;
		exhausted = true;
	};
	const visit = (item: unknown, depth: number): void => {
		if (exhausted) return;
		if (depth > MAX_PREVIEW_DEPTH) {
			append('"[depth]"');
			return;
		}
		if (typeof item === "string") {
			append(safeJson(truncateMiddle(item, MAX_PREVIEW_STRING_CHARS)));
			return;
		}
		if (item === null || typeof item === "number" || typeof item === "boolean") {
			append(String(item));
			return;
		}
		if (typeof item !== "object") {
			append(safeJson(`[${typeof item}]`));
			return;
		}
		if (active.has(item)) {
			append('"[circular]"');
			return;
		}
		active.add(item);
		if (Array.isArray(item)) {
			append("[");
			const count = Math.min(item.length, MAX_PREVIEW_ITEMS);
			for (let index = 0; index < count && !exhausted; index++) {
				if (index > 0) append(",");
				visit(item[index], depth + 1);
			}
			if (item.length > count) append(`${count > 0 ? "," : ""}"[+${item.length - count} items]"`);
			append("]");
		} else {
			append("{");
			let count = 0;
			let omitted = 0;
			const keys = Object.keys(item).sort();
			for (const key of keys) {
				if (count >= MAX_PREVIEW_ITEMS) {
					omitted++;
					continue;
				}
				if (count > 0) append(",");
				append(safeJson(truncateMiddle(key, MAX_PREVIEW_STRING_CHARS)));
				append(":");
				visit((item as Record<string, unknown>)[key], depth + 1);
				count++;
			}
			if (omitted > 0) append(`${count > 0 ? "," : ""}"[omitted]":${omitted}`);
			append("}");
		}
		active.delete(item);
	};
	visit(value, 0);
	return truncateMiddle(output || "null", maxChars);
}

/**
 * Fingerprint a tool operation without materializing or retaining its serialized payload.
 * Volatile identifiers normalize before hashing; short numbers and ordinary paths remain significant.
 */
/**
 * Resource-envelope fields are not the operation. Changing `timeout` (or a sibling wait bound)
 * must not mint a new execution identity — that is how a failed command is replayed forever.
 */
const OPERATION_ENVELOPE_KEYS = new Set([
	"timeout",
	"timeoutms",
	"timeout_ms",
	"timeoutsec",
	"timeout_sec",
	"timeoutseconds",
	"timeout_seconds",
	"maxwait",
	"max_wait",
	"maxwaitms",
	"max_wait_ms",
	"waitms",
	"wait_ms",
	"waitsec",
	"wait_sec",
	"waitseconds",
	"wait_seconds",
]);

function omitOperationEnvelopeFields(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const record = value as Record<string, unknown>;
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (OPERATION_ENVELOPE_KEYS.has(key.toLowerCase())) {
			changed = true;
			continue;
		}
		next[key] = entry;
	}
	return changed ? next : value;
}

export function normalizeToolSignature(pairs: Array<[string, unknown]>): string {
	return structuredHash(
		pairs.map(([name, args]) => [name, omitOperationEnvelopeFields(args)]),
		true,
	);
}

function toolOperationKey(tool: string, args: unknown, normalizeVolatile: boolean, retainEnvelope = false): string {
	const identityArgs = retainEnvelope ? args : omitOperationEnvelopeFields(args);
	const boundedTool = truncate(tool, MAX_TOOL_NAME_CHARS);
	const hash = createSignatureHash();
	const updateHashString = normalizeVolatile ? updateNormalizedHashString : updateExactHashString;
	const active = new Set<object>();
	// Preserve the stable structured-hash wire identity without allocating the two synthetic arrays.
	updateHashRange(hash, "array:1[array:2[");
	updateStructuredHash(hash, tool, active, 2, updateHashString);
	updateStructuredHash(hash, identityArgs, active, 2, updateHashString);
	updateHashRange(hash, "];];");
	const signature = renderSignatureHash(hash);
	return `${boundedTool}:${signature}`;
}

function operationIdentity(tool: string, args: unknown): ToolOperationIdentity {
	return {
		failureKey: toolOperationKey(tool, args, true),
		executionKey: toolOperationKey(tool, args, false),
		rawKey: getToolRawOperationKey(tool, args),
		tool: truncate(tool, MAX_TOOL_NAME_CHARS),
		operation: boundedJsonPreview(args, MAX_OPERATION_CHARS),
	};
}

/**
 * Memoizes `operationIdentity` by CALL OBJECT identity, not by a string built from its arguments -
 * building that string is exactly the structured-hash cost this exists to avoid. `analyzeToolFailureContext`
 * runs once per provider request and used to recompute this same identity for every already-scanned
 * call on every single request - O(transcript length) work per request, O(n^2) total hashing over a
 * session (measured: ~84% of sampled CPU time in a 2000-turn profile). A tool call's `name`/
 * `arguments` never change once the message containing it is durable and reachable from
 * `analyzeToolFailureContext` - the only two places in this package that mutate `.arguments`
 * (agent-loop.ts's `prepareToolCall` argument-validation coercion, and proxy.ts's streaming JSON
 * argument projector) both do so only while the assistant message is still being prepared/streamed,
 * strictly before it is appended as a finalized message; `analyzeToolFailureContext` only ever runs
 * while planning the NEXT request, before that turn's own response - and hence its own new tool
 * calls - exist, so it can never observe a call before those mutations have already settled. A
 * WeakMap so a call's memo entry is collected along with the call itself once nothing else
 * references it (a message dropped by compaction leaks nothing).
 */
const callIdentityMemo = new WeakMap<AgentToolCall, ToolOperationIdentity>();

function memoizedOperationIdentity(call: AgentToolCall): ToolOperationIdentity {
	const cached = callIdentityMemo.get(call);
	if (cached) return cached;
	const identity = operationIdentity(call.name, call.arguments);
	callIdentityMemo.set(call, identity);
	return identity;
}

function getToolFailureKey(tool: string, args: unknown): string {
	return toolOperationKey(tool, args, true);
}

export function getToolExecutionKey(tool: string, args: unknown): string {
	return toolOperationKey(tool, args, false);
}

/**
 * Identity that keeps resource-envelope fields. Volatile ids normalize exactly as they do for the
 * failure key, so this differs from it in one respect only: an envelope field is part of the
 * identity. Compared solely against another raw key to answer "did the model actually change the
 * arguments it sent" — never used as a map key, and never a substitute for execution identity.
 */
export function getToolRawOperationKey(tool: string, args: unknown): string {
	return toolOperationKey(tool, args, true, true);
}

/** Read the four hash words already encoded by this module's exact execution-key owner. */
export function getToolExecutionKeyHashParts(executionKey: string): readonly [number, number, number, number] {
	const separator = executionKey.lastIndexOf(":");
	const signature = executionKey.slice(separator + 1);
	if (separator < 0 || signature.length !== TOOL_SIGNATURE_HEX_CHARS || !/^[0-9a-f]+$/.test(signature)) {
		throw new TypeError("Tool execution key has an invalid hash signature.");
	}
	return [
		Number.parseInt(signature.slice(0, 8), 16),
		Number.parseInt(signature.slice(8, 16), 16),
		Number.parseInt(signature.slice(16, 24), 16),
		Number.parseInt(signature.slice(24, 32), 16),
	];
}

export function getToolFailureRecordExecutionKey(record: ToolFailureMemoryRecord): string | undefined {
	return record[TOOL_FAILURE_EXECUTION_KEY];
}

export function getToolFailureRecordRawKey(record: ToolFailureMemoryRecord): string | undefined {
	return record[TOOL_FAILURE_RAW_KEY];
}

export function getUnresolvedToolFailure(
	tracker: ToolFailureMemoryTracker,
	tool: string,
	args: unknown,
): ToolFailureMemoryRecord | undefined {
	return tracker.get(getToolFailureKey(tool, args));
}

export function readVisibleToolFailureCode(result: ToolResultMessage): string | undefined {
	for (const block of result.content) {
		if (block.type !== "text") continue;
		const match = /"failure_code"\s*:\s*"([^"]+)"/.exec(block.text);
		if (match) return match[1];
	}
	return undefined;
}

/** Failures that only a new owner prompt can clear. Do not restore their circuit across user turns. */
export function isPromptScopedFailureCode(code: string | undefined): boolean {
	return code === "owner_authorization_required";
}

export function restoreToolFailureRecord(
	result: ToolResultMessage,
	tool: string,
	args: unknown,
): ToolFailureMemoryRecord {
	const executionKey = getToolExecutionKey(tool, args);
	const rawKey = getToolRawOperationKey(tool, args);
	const persisted = readFailureRecord(result.details);
	if (persisted) {
		return {
			...persisted,
			[TOOL_FAILURE_EXECUTION_KEY]: getToolFailureRecordExecutionKey(persisted) ?? executionKey,
			[TOOL_FAILURE_RAW_KEY]: getToolFailureRecordRawKey(persisted) ?? rawKey,
		};
	}
	const identity = operationIdentity(tool, args);
	// A completed operation that reported a negative status keeps its own raw output, so there is no
	// harness record to read back. Recover its terminal status from that output rather than flattening
	// every such result to a generic `tool_error`.
	const visibleCode = readVisibleToolFailureCode(result);
	return {
		version: TOOL_FAILURE_MEMORY_VERSION,
		failureKey: identity.failureKey,
		[TOOL_FAILURE_EXECUTION_KEY]: executionKey,
		[TOOL_FAILURE_RAW_KEY]: rawKey,
		tool: identity.tool,
		operation: identity.operation,
		occurrence: 1,
		state: "failed",
		phase: "execution",
		failureCode: boundedFailureCode(visibleCode ?? classifyToolFailure(firstText(result))),
		correction: fallbackFailureGuidance("failed", false, "execution"),
	};
}

export interface PairedToolResult {
	tool: string;
	args: unknown;
	executionKey: string;
	result: ToolResultMessage;
}

export function forEachPairedToolResult(
	messages: readonly AgentMessage[],
	visit: (pair: PairedToolResult) => boolean | undefined,
): void {
	const callsById = new Map<string, { name: string; args: unknown }>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") {
					callsById.set(block.id, { name: block.name, args: block.arguments });
				}
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const call = callsById.get(message.toolCallId);
		if (!call) continue;
		if (
			visit({
				tool: call.name,
				args: call.args,
				executionKey: getToolExecutionKey(call.name, call.args),
				result: message,
			}) === false
		) {
			return;
		}
	}
}

function boundedFailureCode(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.:-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return truncate(normalized || "tool_error", MAX_FAILURE_CODE_CHARS);
}

/**
 * bash.ts's own trailer (`appendStatus`) always ends the message with a line like "Command
 * exited with code 1"; a structured result (e.g. run_process) instead puts "exitCode: 1" on its
 * own line near the top. Both are anchored to the START of their own line, with at most one
 * leading tool-name token ("Command"/"Python"/...) — ordinary stdout/stderr prose is never
 * anchored that way, so a captured line like "container will exit 0 on SIGTERM" can never be
 * read as the process exit status. Scan from the end of the message so the tool's own trailer —
 * always the last line it appends — outranks any earlier, non-authoritative line that matches.
 */
const EXIT_STATUS_LINE_PATTERN = /^(?:\S+\s+)?(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|exitcode)\s*[:=]?\s*(-?\d+)\b/i;

/**
 * bash.ts appends `cwd: <dir>` after its exit trailer on failures. The line is harness status, not
 * a cause: it must never displace a real diagnostic (a path may contain words like "error"), and it
 * reaches the model through the process-exit evidence tail instead.
 */
const CWD_STATUS_LINE_PATTERN = /^cwd:\s/i;

/**
 * Boundary tags of the untrusted-content envelope, which always sit on their own lines (mirrors
 * `UNTRUSTED_BOUNDARY_TAG` used by `wrapUntrustedText` in
 * `packages/coding-agent/src/core/security/untrusted-boundary.ts`; it cannot be imported because the
 * kernel must not depend on coding-agent — `untrusted-envelope-failure-memory.test.ts` pins the drift).
 * The tags are harness framing, exactly like the exit-status and `cwd:` lines: promoting one as a
 * diagnostic hands the model a closing tag to repair from instead of the real cause.
 */
const UNTRUSTED_ENVELOPE_LINE_PATTERN = /^<\/?untrusted_content\b[^>]*>$/i;

/** Tool-owned status/marker lines that carry no cause and never belong in diagnostic or evidence. */
function isFailureStatusLine(line: string): boolean {
	return (
		UNTRUSTED_ENVELOPE_LINE_PATTERN.test(line) ||
		/^command (?:exited with code|timed out after|aborted|killed after)\b/i.test(line) ||
		/^outcome:\s*(?:failed|aborted|timeout|output_limit)\b/i.test(line) ||
		/^exitcode:\s*-?\d+\b/i.test(line) ||
		/^(?:stdout|stderr):(?:\s*\(empty\))?$/i.test(line)
	);
}

function processExitFailureCode(message: string): string | undefined {
	const lines = message.split(/\r\n|\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const match = EXIT_STATUS_LINE_PATTERN.exec(lines[index].trim());
		if (match) return boundedFailureCode(`exit_${match[1]}`);
	}
	return undefined;
}

export function classifyToolFailure(message: string, errorClass?: string): string {
	// A tool-owned terminal status is authoritative; stdout may contain arbitrary all-caps identifiers.
	const exitFailureCode = processExitFailureCode(message);
	if (exitFailureCode) return exitFailureCode;
	const errno = /\b(E[A-Z][A-Z0-9_]{2,})\b/.exec(message)?.[1];
	if (errno) return boundedFailureCode(errno);
	return boundedFailureCode(errorClass ?? "tool_error");
}

function isToolFailurePhase(value: unknown): value is ToolFailurePhase {
	return (
		value === "validation" ||
		value === "policy" ||
		value === "preflight" ||
		value === "execution" ||
		value === "timeout" ||
		value === "cancelled" ||
		value === "provisioning"
	);
}

function inferToolFailurePhase(state: ToolFailureState, failureCode: string): ToolFailurePhase {
	if (failureCode === "malformed_call" || failureCode === "unknown_tool" || failureCode === "invalid_arguments") {
		return "validation";
	}
	if (
		failureCode === "blocked" ||
		failureCode === "permission_denied" ||
		failureCode === "owner_authorization_required"
	) {
		return "policy";
	}
	if (failureCode === "preflight_error") return "preflight";
	if (failureCode === "aborted" || failureCode === "cancelled") return "cancelled";
	if (failureCode === "timeout" || failureCode === "etimedout") return "timeout";
	if (failureCode === "provisioning_failed" || failureCode === "command_not_found") return "provisioning";
	return state === "rejected" ? "validation" : "execution";
}

function fallbackFailureGuidance(state: ToolFailureState, hasDiagnostic: boolean, phase: ToolFailurePhase): string {
	if (phase === "preflight") {
		return hasDiagnostic
			? "Arguments valid; preflight failed before execution. Resolve diagnostic/host condition before retry."
			: "Arguments valid; preflight failed before execution. Inspect host policy/capability before retry.";
	}
	if (phase === "policy") return "Resolve authority/policy restriction or choose allowed approach before retry.";
	if (phase === "cancelled") return "Retry only when operation remains required, cancellation condition cleared.";
	if (phase === "timeout") return "Narrow/split work; retry once only when safe.";
	if (phase === "provisioning") {
		return hasDiagnostic
			? "Fix provisioning diagnostic; retry only after environment changes."
			: "Inspect tool availability; request bounded provisioning diagnostic before retry.";
	}
	return state === "rejected"
		? "Re-read current tool schema; change invalid operation before retry."
		: hasDiagnostic
			? "Read diagnostic; identify cause; repair parameters or corrective state before retry."
			: "No diagnostic output. Inspect tool contract or request bounded diagnostic before retry.";
}

export function toolFailureCorrection(
	message: string,
	state: ToolFailureState,
	phase: ToolFailurePhase = state === "rejected" ? "validation" : "execution",
): string {
	const policy = getToolExecutionErrorPolicy(message);
	return policy
		? truncate(policy.guidance, MAX_CORRECTION_CHARS)
		: fallbackFailureGuidance(state, message.trim().length > 0, phase);
}

function extractFailureDiagnostic(
	message: string,
	allowUnclassifiedFallback: boolean,
	requireStrongSignal = false,
): string | undefined {
	const rawLines = sanitizeBinaryOutput(message).replaceAll("\r\n", "\n").split("\n");
	const strongDiagnosticPattern =
		/^(?:(?:error(?:\[[^\]]+\])?|fatal(?: error)?|panic|fail(?:ed|ure)?|invalid|unknown|unsupported|not found|no such|cannot|can't|missing|denied|refused|usage)(?:\b|:)|[a-z][a-z0-9_.]*error(?::|$)|thread .+ panicked at\b|--- fail:|\[fail(?:ed)?\]|not ok\b|[×✗]\s|.{1,160}:\s+(?:error(?:\[[^\]]+\])?|fatal(?: error)?)(?:\b|:))/i;
	const stderrMarkerIndex = rawLines.findLastIndex((line) => /^stderr:\s*$/i.test(line.trim()));
	if (stderrMarkerIndex >= 0) {
		const stderrLines = rawLines
			.slice(stderrMarkerIndex + 1)
			.map((line) => line.trim())
			.filter(
				(line) =>
					line.length > 0 &&
					!/^command (?:exited with code|timed out after|aborted|killed after)\b/i.test(line) &&
					!CWD_STATUS_LINE_PATTERN.test(line) &&
					!UNTRUSTED_ENVELOPE_LINE_PATTERN.test(line),
			);
		if (stderrLines.length > 0) {
			const classified = stderrLines.find((line) => strongDiagnosticPattern.test(line));
			if (classified) return truncateMiddle(classified, MAX_DIAGNOSTIC_CHARS);
			// No stderr line carries a strong signal. Under requireStrongSignal, the caller has
			// already decided uncatalogued output must never be fabricated into a diagnostic (see
			// assessToolFailure) — falling back to the last raw stderr lines here would defeat that
			// guarantee for the common bash case, so fall through to the same allowUnclassifiedFallback
			// gate the no-stderr path below applies.
			if (!requireStrongSignal) {
				return truncateMiddle(stderrLines.slice(-4).join(" | "), MAX_DIAGNOSTIC_CHARS);
			}
		}
	}
	const lines = rawLines
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !isFailureStatusLine(line) && !CWD_STATUS_LINE_PATTERN.test(line));
	if (lines.length === 0) return undefined;
	const diagnosticPattern = requireStrongSignal
		? strongDiagnosticPattern
		: /(?:^|\b)(?:error|fatal|fail(?:ed|ure)?|invalid|unknown|unsupported|not found|no such|cannot|can't|missing|denied|refused|usage)(?:\b|:)/i;
	const classified = requireStrongSignal
		? lines.find((line) => diagnosticPattern.test(line))
		: [...lines].reverse().find((line) => diagnosticPattern.test(line));
	const diagnostic = classified ?? (allowUnclassifiedFallback ? lines.at(-1) : undefined);
	return diagnostic ? truncateMiddle(diagnostic, MAX_DIAGNOSTIC_CHARS) : undefined;
}

/**
 * Bounded raw-output tail of an executed process-exit failure. Evidence is the raw-data channel:
 * it keeps the trailing lines that strong-signal diagnostic classification refuses to promote, so
 * strictness never destroys the output needed to construct a changed operation.
 */
function extractProcessExitEvidence(message: string): string | undefined {
	const lines = sanitizeBinaryOutput(message)
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !isFailureStatusLine(line));
	if (lines.length === 0) return undefined;
	let start = lines.length - 1;
	let retainedChars = lines[start].length;
	while (start > 0 && retainedChars + 1 + lines[start - 1].length <= MAX_TOOL_FAILURE_EVIDENCE_CHARS) {
		start--;
		retainedChars += 1 + lines[start].length;
	}
	let tail = lines.slice(start).join("\n");
	if (tail.length > MAX_TOOL_FAILURE_EVIDENCE_CHARS) {
		let tailStart = tail.length - MAX_TOOL_FAILURE_EVIDENCE_CHARS;
		const firstCode = tail.charCodeAt(tailStart);
		if (firstCode >= 0xdc00 && firstCode <= 0xdfff) tailStart++;
		tail = tail.slice(tailStart);
	}
	return sanitizeToolFailureEvidence(tail);
}

export interface ToolFailureAssessment {
	failureCode: string;
	phase: ToolFailurePhase;
	diagnostic?: string;
	/** Bounded raw-output tail of an executed process-exit failure. */
	evidence?: string;
	guidance: string;
	/** Catalogued per-error guidance; set only when a registry policy matched the failure message. */
	policyGuidance?: string;
	attemptMemory?: "discard";
}

export function assessToolFailure(
	message: string,
	state: ToolFailureState,
	errorClass?: string,
): ToolFailureAssessment {
	const policy = getToolExecutionErrorPolicy(message);
	const exitFailureCode = processExitFailureCode(message);
	const retainPolicyDiagnostic = policy?.retainDiagnostic === true;
	const diagnostic =
		state === "failed" && (!policy || policy.retainDiagnostic)
			? extractFailureDiagnostic(
					message,
					exitFailureCode === undefined && (errorClass !== undefined || retainPolicyDiagnostic),
					exitFailureCode !== undefined && !retainPolicyDiagnostic,
				)
			: undefined;
	// A killed process has no exit code, so exit-shaped detection alone would discard everything it
	// printed before the bound cut it off. That output is exactly what a narrower retry must be built
	// from, and a timeout is the failure that destroys the most of it.
	const evidence =
		state === "failed" && (exitFailureCode !== undefined || policy?.phase === "timeout")
			? extractProcessExitEvidence(message)
			: undefined;
	const failureCode = policy?.failureCode ?? classifyToolFailure(message, errorClass);
	return {
		failureCode,
		phase: policy?.phase ?? inferToolFailurePhase(state, failureCode),
		...(diagnostic ? { diagnostic } : {}),
		...(evidence ? { evidence } : {}),
		guidance: policy
			? truncate(policy.guidance, MAX_CORRECTION_CHARS)
			: fallbackFailureGuidance(state, diagnostic !== undefined, inferToolFailurePhase(state, failureCode)),
		...(policy ? { policyGuidance: truncate(policy.guidance, MAX_CORRECTION_CHARS) } : {}),
		...(policy?.attemptMemory === "discard" ? { attemptMemory: "discard" as const } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOutputSignature(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length === TOOL_FALLBACK_OUTPUT_SIGNATURE_BASE62_CHARS) return /^[0-9A-Za-z]+$/.test(value);
	if (value.length === TOOL_OUTPUT_SIGNATURE_BASE64URL_CHARS) return /^[A-Za-z0-9_-]+$/.test(value);
	return (
		(value.length === TOOL_SIGNATURE_HEX_CHARS || value.length === LEGACY_TOOL_OUTPUT_SIGNATURE_HEX_CHARS) &&
		/^[0-9a-f]+$/.test(value)
	);
}

function readFailureRecord(details: unknown): ToolFailureMemoryRecord | undefined {
	if (!isRecord(details) || !isRecord(details.piToolFailureMemory)) return undefined;
	const candidate = details.piToolFailureMemory;
	if (
		candidate.version !== TOOL_FAILURE_MEMORY_VERSION ||
		typeof candidate.failureKey !== "string" ||
		typeof candidate.tool !== "string" ||
		typeof candidate.operation !== "string" ||
		typeof candidate.occurrence !== "number" ||
		!Number.isSafeInteger(candidate.occurrence) ||
		candidate.occurrence < 1 ||
		(candidate.state !== "failed" && candidate.state !== "rejected") ||
		typeof candidate.failureCode !== "string"
	) {
		return undefined;
	}
	const diagnostic =
		typeof candidate.diagnostic === "string" ? truncate(candidate.diagnostic, MAX_DIAGNOSTIC_CHARS) : undefined;
	const outputSignature = isOutputSignature(candidate.outputSignature) ? candidate.outputSignature : undefined;
	const note = typeof candidate.note === "string" ? truncate(candidate.note, MAX_DIAGNOSTIC_CHARS) : undefined;
	const evidence = sanitizeToolFailureEvidence(candidate.evidence);
	const retainedCorrection =
		typeof candidate.correction === "string" ? truncate(candidate.correction, MAX_CORRECTION_CHARS) : undefined;
	const correction =
		candidate.state === "failed" && retainedCorrection === LEGACY_GENERIC_EXECUTION_CORRECTION
			? fallbackFailureGuidance("failed", diagnostic !== undefined, "execution")
			: (retainedCorrection ?? toolFailureCorrection("", candidate.state));
	const phase = isToolFailurePhase(candidate.phase)
		? candidate.phase
		: inferToolFailurePhase(candidate.state, candidate.failureCode);
	const candidateExecutionKey: unknown = Reflect.get(candidate, TOOL_FAILURE_EXECUTION_KEY);
	return {
		version: TOOL_FAILURE_MEMORY_VERSION,
		failureKey: truncate(candidate.failureKey, MAX_TOOL_NAME_CHARS + 1 + TOOL_SIGNATURE_HEX_CHARS),
		...(typeof candidateExecutionKey === "string"
			? {
					[TOOL_FAILURE_EXECUTION_KEY]: truncate(
						candidateExecutionKey,
						MAX_TOOL_NAME_CHARS + 1 + TOOL_SIGNATURE_HEX_CHARS,
					),
				}
			: {}),
		tool: truncate(candidate.tool, MAX_TOOL_NAME_CHARS),
		operation: truncateMiddle(candidate.operation, MAX_OPERATION_CHARS),
		occurrence: candidate.occurrence,
		state: candidate.state,
		phase,
		failureCode: boundedFailureCode(candidate.failureCode),
		outputSignature,
		diagnostic,
		note,
		evidence,
		correction,
	};
}

function readFailureDirective(details: unknown): ToolFailureDirectiveDetails["piToolFailureDirective"] | undefined {
	if (!isRecord(details) || !isRecord(details.piToolFailureDirective)) return undefined;
	const candidate = details.piToolFailureDirective;
	if (
		candidate.version !== TOOL_FAILURE_DIRECTIVE_VERSION ||
		typeof candidate.failureCode !== "string" ||
		typeof candidate.nextAction !== "string"
	) {
		return undefined;
	}
	return {
		version: TOOL_FAILURE_DIRECTIVE_VERSION,
		state: candidate.state === "rejected" ? "rejected" : "failed",
		phase: isToolFailurePhase(candidate.phase)
			? candidate.phase
			: inferToolFailurePhase("failed", candidate.failureCode),
		failureCode: boundedFailureCode(candidate.failureCode),
		diagnostic:
			typeof candidate.diagnostic === "string" ? truncate(candidate.diagnostic, MAX_DIAGNOSTIC_CHARS) : undefined,
		nextAction: truncate(candidate.nextAction, MAX_CORRECTION_CHARS),
	};
}

export interface ToolFailureTelemetry {
	state: ToolFailureState;
	phase: ToolFailurePhase;
	failureCode: string;
	diagnostic?: string;
	nextAction: string;
}

/** Read only bounded failure identity and guidance; operation arguments never cross this telemetry boundary. */
export function readToolFailureTelemetry(details: unknown): ToolFailureTelemetry | undefined {
	const record = readFailureRecord(details);
	if (record) {
		return {
			state: record.state,
			phase: record.phase,
			failureCode: record.failureCode,
			...(record.diagnostic ? { diagnostic: record.diagnostic } : {}),
			nextAction: record.correction,
		};
	}
	const directive = readFailureDirective(details);
	if (!directive) return undefined;
	return {
		state: directive.state,
		phase: directive.phase,
		failureCode: directive.failureCode,
		...(directive.diagnostic ? { diagnostic: directive.diagnostic } : {}),
		nextAction: directive.nextAction,
	};
}

function firstText(message: ToolResultMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		for (let index = 0; index < content.length; index++) {
			const block = content[index];
			if (block.type === "text") return block.text;
		}
	}
	return "";
}

function fastTextSignature(text: string): string {
	if (text.length <= 128) return text;
	return `${text.length}:${text.slice(0, 48)}:${text.slice(-48)}`;
}

/**
 * Everything the failure-context fold knows after processing a prefix of the history. Kept as one
 * object so the fold can be RESUMED from where it stopped instead of re-walking the history on
 * every provider request (see {@link ToolFailureContextMemory}).
 */
interface FailureFoldState {
	callById: Map<string, AgentToolCall>;
	callMessageIndexById: Map<string, number>;
	/** Results whose call is unknown and that were omitted with their failure. */
	omittedResults: Set<ToolResultMessage>;
	/** Unbounded failure results to replace in place with their bounded record. */
	boundedReplacements: Map<ToolResultMessage, ToolFailureMemoryRecord>;
	/**
	 * The replacement built for each of those, reused on every later request: the bytes were always
	 * identical, but a fresh object per request defeated every consumer that keys the cached prefix
	 * on message identity (the provider delta path among them).
	 */
	boundedMessages: Map<ToolResultMessage, AgentMessage>;
	/**
	 * The assistant message rebuilt without its omitted calls, per source message, reused while
	 * the same calls are omitted: a fresh copy per request had the same bytes and a new identity.
	 */
	filteredAssistantMessages: WeakMap<AssistantMessage, { omittedIds: string; message: AgentMessage | undefined }>;
	active: Map<string, ActiveFailure>;
	/**
	 * Occurrence counts of failures that a later call of the same tool resolved, by failure key. A
	 * resolved record leaves the ledger, but an identical failure afterwards keeps escalating from
	 * where it left off instead of starting again at one. Bounded like `active`.
	 */
	resolvedOccurrences: Map<string, number>;
	activeDirectives: Map<string, ToolFailureDirectiveDetails["piToolFailureDirective"]>;
	sequence: number;
	kindMistakesMap: Map<string, number>;
	latestSuccessfulByOpKey: Map<string, { callId: string; index: number }>;
	latestSuccessfulByPayloadKey: Map<string, { callId: string; index: number }>;
	/** How many leading messages this state reflects. */
	processedCount: number;
}

function createFailureFoldState(): FailureFoldState {
	return {
		callById: new Map(),
		callMessageIndexById: new Map(),
		omittedResults: new Set(),
		boundedReplacements: new Map(),
		boundedMessages: new Map(),
		filteredAssistantMessages: new WeakMap(),
		active: new Map(),
		resolvedOccurrences: new Map(),
		activeDirectives: new Map(),
		sequence: 0,
		kindMistakesMap: new Map(),
		latestSuccessfulByOpKey: new Map(),
		latestSuccessfulByPayloadKey: new Map(),
		processedCount: 0,
	};
}

/**
 * Session memory for the failure-context fold. Two things live here, and both are why the fold is
 * no longer a pure function of (messages, sentPrefixCount):
 *
 * - `omittedCallIds` is the durable record of every call the sanitizer has ever erased. An erasure
 *   is decided while the call is still unsent (`sentPrefixCount` guards that), and it has to STAY
 *   decided: a pure fold re-run on the next request, with the sent mark now past the erased call,
 *   found the call un-erasable and put it back -- inserting a message inside the prefix the
 *   provider had already cached, one request after every deduplication. Recording the decision is
 *   what makes "never rewrite already-sent bytes" hold across requests, not just within one.
 * - `state` is the fold's bookkeeping after the last processed prefix. Messages are immutable and
 *   keep their identity, so when the next request's history starts with the same objects the fold
 *   resumes from `processedCount` and touches only what was appended; a history that changed
 *   underneath (compaction, a branch) is folded from the start again, with the erasure record kept.
 */
export class ToolFailureContextMemory {
	/** @internal */
	readonly omittedCallIds = new Set<string>();
	/** @internal */
	state = createFailureFoldState();
	/** @internal The exact message objects `state` reflects, for the resume check. */
	processed: AgentMessage[] = [];
}

export function createToolFailureContextMemory(): ToolFailureContextMemory {
	return new ToolFailureContextMemory();
}

/** Advance the fold over `messages[from..)`. Erasures land in `omittedCallIds`, which persists. */
function foldToolFailureContext(
	fold: FailureFoldState,
	omittedCallIds: Set<string>,
	messages: AgentMessage[],
	from: number,
	sentPrefixCount: number,
): void {
	/**
	 * Deduplicating a superseded success ERASES the earlier call, which shifts every byte after it.
	 * Providers prefill each request against the longest byte-identical prefix, so erasing a message
	 * the provider has already seen invalidates the whole conversation from that point — measured
	 * live, one repeated `ls` erased at message 5 of 15 cost a full re-prefill. `sentPrefixCount` is
	 * how many leading messages have already gone out on a previous request; everything from there on
	 * is still unsent and free to rewrite. Dedup therefore keeps working in full on fresh history (the
	 * common case: a model repeating itself within the turn) and never reaches back into cached bytes.
	 * The default of 0 means "nothing sent yet", i.e. dedup everything — the behavior every direct
	 * caller and test relied on before the mark existed.
	 */
	const erasable = (callIndex: number): boolean => callIndex >= sentPrefixCount;
	const {
		callById,
		callMessageIndexById,
		omittedResults,
		boundedReplacements,
		active,
		activeDirectives,
		kindMistakesMap,
		latestSuccessfulByOpKey,
		latestSuccessfulByPayloadKey,
	} = fold;

	for (let index = from; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "assistant") {
			activeDirectives.clear();
			const content = message.content;
			for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
				const block = content[blockIdx];
				if (block.type !== "toolCall") continue;
				callById.set(block.id, block);
				callMessageIndexById.set(block.id, index);
			}
			continue;
		}
		if (message.role !== "toolResult") continue;

		const call = callById.get(message.toolCallId);
		callById.delete(message.toolCallId);
		const textPayload = firstText(message);
		if (message.errorKind === "operation_outcome") {
			// The tool executed and reported an outcome: a successful call of the tool as far as the
			// ledger is concerned, whatever the outcome says about the operation itself.
			if (call) resolveToolFailures(fold, memoizedOperationIdentity(call));
			continue;
		}
		const isHarnessFailure = message.isError === true || textPayload.startsWith("[harness] ");
		if (isHarnessFailure) {
			const toolName = call?.name ?? message.toolName;
			const kindCount = (kindMistakesMap.get(toolName) ?? 0) + 1;
			kindMistakesMap.set(toolName, kindCount);

			const directive = readFailureDirective(message.details);
			if (directive) {
				activeDirectives.delete(directive.failureCode);
				activeDirectives.set(directive.failureCode, directive);
				// The harness has taken ownership of this attempt: the directive replaces it, and the
				// original arguments must not reappear — a retarget keeps the payload by reference, and a
				// corrupt payload must never be replayed at all. Either way the call comes out.
				if (call) omittedCallIds.add(call.id);
				else omittedResults.add(message);
				continue;
			}
			const retained = readFailureRecord(message.details);
			const state = retained?.state ?? "failed";
			const assessment = retained ? undefined : assessToolFailure(textPayload, state);
			let failureKey: string;
			let executionKey: string | undefined;
			let rawKey: string | undefined;
			let tool: string;
			let operation: string;
			if (retained) {
				failureKey = retained.failureKey;
				executionKey = call
					? memoizedOperationIdentity(call).executionKey
					: getToolFailureRecordExecutionKey(retained);
				rawKey = call ? memoizedOperationIdentity(call).rawKey : getToolFailureRecordRawKey(retained);
				tool = retained.tool;
				operation = retained.operation;
			} else {
				// Equivalent to `operationIdentity(call?.name ?? message.toolName, call?.arguments ?? {...})`:
				// when `call` exists this IS `operationIdentity(call.name, call.arguments)`, so it can go
				// through the memo; the synthetic fallback (a call the harness no longer has, keyed only by
				// the toolCallId it once had) has no call object to memoize against and stays uncached - it
				// is not the repeated-rescan path this memo exists for.
				const identity = call
					? memoizedOperationIdentity(call)
					: operationIdentity(message.toolName, { toolCallId: message.toolCallId });
				failureKey = identity.failureKey;
				executionKey = identity.executionKey;
				rawKey = identity.rawKey;
				tool = identity.tool;
				operation = identity.operation;
			}
			const previous = active.get(failureKey)?.record;
			const occurrence = Math.max(
				retained?.occurrence ?? 0,
				(previous?.occurrence ?? fold.resolvedOccurrences.get(failureKey) ?? 0) + 1,
			);
			const record: ToolFailureMemoryRecord = {
				version: TOOL_FAILURE_MEMORY_VERSION,
				failureKey,
				...(executionKey ? { [TOOL_FAILURE_EXECUTION_KEY]: executionKey } : {}),
				...(rawKey ? { [TOOL_FAILURE_RAW_KEY]: rawKey } : {}),
				tool,
				operation,
				occurrence,
				kindMistakes: kindCount,
				mistakeKind: toolName,
				state,
				phase: retained?.phase ?? assessment?.phase ?? inferToolFailurePhase(state, "tool_error"),
				failureCode: retained?.failureCode ?? assessment?.failureCode ?? "tool_error",
				outputSignature: retained ? retained.outputSignature : structuredOutputSignature(textPayload),
				diagnostic: retained?.diagnostic ?? assessment?.diagnostic,
				evidence: retained?.evidence,
				correction:
					retained?.correction ??
					assessment?.guidance ??
					fallbackFailureGuidance(state, false, inferToolFailurePhase(state, "tool_error")),
			};
			active.delete(failureKey);
			active.set(failureKey, { record, sequence: fold.sequence++, laterCalls: 0 });
			while (active.size > MAX_TRACKED_FAILURES) {
				const oldest = active.keys().next().value;
				if (oldest === undefined) break;
				active.delete(oldest);
			}
			// A failure result written before this harness bounded its own output — a legacy transcript,
			// or a host that set isError directly — can carry unbounded raw text. Bounding it in place
			// is the same treatment createToolFailureResult gives a fresh failure, applied late; the
			// call that produced it still stands.
			if (!retained) boundedReplacements.set(message, record);
			continue;
		}

		if (call) {
			const callIndex = callMessageIndexById.get(call.id) ?? index;
			// The hot path: every successful result re-derives this on every request. See
			// memoizedOperationIdentity's doc comment.
			const identity = memoizedOperationIdentity(call);
			const opKey = identity.failureKey;
			resolveToolFailures(fold, identity);
			const previousOperation = latestSuccessfulByOpKey.get(opKey);
			// A call erased on an earlier request stays erased whatever the mark says now; a new
			// erasure is only allowed while the superseded call is still unsent.
			if (previousOperation && (omittedCallIds.has(previousOperation.callId) || erasable(previousOperation.index))) {
				omittedCallIds.add(previousOperation.callId);
			}
			latestSuccessfulByOpKey.set(opKey, { callId: call.id, index: callIndex });

			const textPayload = firstText(message);
			if (textPayload.length >= 64) {
				const payloadKey = `payload:${fastTextSignature(textPayload)}`;
				const previousPayload = latestSuccessfulByPayloadKey.get(payloadKey);
				if (previousPayload && (omittedCallIds.has(previousPayload.callId) || erasable(previousPayload.index))) {
					omittedCallIds.add(previousPayload.callId);
				}
				latestSuccessfulByPayloadKey.set(payloadKey, { callId: call.id, index: callIndex });
			}
		}
	}
	fold.processedCount = messages.length;
}

const MAX_RESOLVED_OCCURRENCES = 64;

/**
 * How many later calls of the failed tool, none of them the failed operation, show that the model
 * has moved on from it. One is not enough: a record can ask for exactly one corrective call of the
 * same tool before the retry (a declared recovery check, a repair call), and the ledger must still
 * name the retry after it.
 */
const LATER_CALLS_THAT_RESOLVE = 2;

/**
 * Called for every call that executed (a plain success or an operation outcome). The exact operation
 * succeeding clears its record, as always. Any other call of the same tool counts toward
 * `LATER_CALLS_THAT_RESOLVE`; at the threshold the record is resolved whatever arguments those calls
 * used. The protocol had already readmitted it - any success readmits - so nothing remains for the
 * record to guard, and the transcript keeps the failed call and its bounded diagnostic as evidence.
 * Keeping the record active instead left the ledger, a trailing record, re-appended at the tail of
 * every later request for the rest of the session (measured live: 29 identical ledger records
 * after one corrected delegate call, because the corrected call never repeats the failed
 * arguments). The occurrence count is remembered so an identical repeat keeps escalating.
 */
function resolveToolFailures(fold: FailureFoldState, identity: ToolOperationIdentity): void {
	for (const [failureKey, failure] of fold.active) {
		if (failureKey === identity.failureKey) {
			fold.active.delete(failureKey);
			continue;
		}
		if (failure.record.tool !== identity.tool) continue;
		failure.laterCalls += 1;
		if (failure.laterCalls < LATER_CALLS_THAT_RESOLVE) continue;
		fold.active.delete(failureKey);
		fold.resolvedOccurrences.delete(failureKey);
		fold.resolvedOccurrences.set(failureKey, failure.record.occurrence);
	}
	while (fold.resolvedOccurrences.size > MAX_RESOLVED_OCCURRENCES) {
		const oldest = fold.resolvedOccurrences.keys().next().value;
		if (oldest === undefined) break;
		fold.resolvedOccurrences.delete(oldest);
	}
}

function buildFailureContextAnalysis(
	messages: AgentMessage[],
	state: FailureFoldState,
	omittedCallIds: ReadonlySet<string>,
): FailureContextAnalysis {
	const {
		omittedResults,
		boundedReplacements,
		boundedMessages,
		filteredAssistantMessages,
		active,
		activeDirectives,
		kindMistakesMap,
	} = state;
	const kindMistakesSummary = Object.fromEntries(kindMistakesMap);
	const activeRecords = activeFailureRecords(active);

	if (omittedCallIds.size === 0 && omittedResults.size === 0 && boundedReplacements.size === 0) {
		return { messages, activeRecords, activeDirectives: [...activeDirectives.values()], kindMistakesSummary };
	}

	const filteredMessages: AgentMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "toolResult") {
			if (omittedCallIds.has(message.toolCallId) || omittedResults.has(message)) continue;
			const bounded = boundedReplacements.get(message);
			if (!bounded) {
				filteredMessages.push(message);
				continue;
			}
			let replacement = boundedMessages.get(message);
			if (!replacement) {
				replacement = {
					...message,
					content: [{ type: "text", text: `[harness] ${formatRecordJson(bounded, false)}` }],
					details: { piToolFailureMemory: bounded } satisfies ToolFailureMemoryDetails,
				};
				boundedMessages.set(message, replacement);
			}
			filteredMessages.push(replacement);
			continue;
		}
		if (message.role !== "assistant") {
			filteredMessages.push(message);
			continue;
		}
		const content = message.content;
		if (content.length === 1) {
			const block = content[0];
			if (block.type === "toolCall" && omittedCallIds.has(block.id)) continue;
			filteredMessages.push(message);
			continue;
		}
		const omittedHere: string[] = [];
		for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
			const block = content[blockIdx];
			if (block.type === "toolCall" && omittedCallIds.has(block.id)) omittedHere.push(block.id);
		}
		if (omittedHere.length === 0) {
			filteredMessages.push(message);
			continue;
		}
		const omittedIds = omittedHere.join("\0");
		let filtered = filteredAssistantMessages.get(message);
		if (!filtered || filtered.omittedIds !== omittedIds) {
			const retainedContent = content.filter((block) => block.type !== "toolCall" || !omittedCallIds.has(block.id));
			filtered = {
				omittedIds,
				message:
					retainedContent.length > 0
						? ({ ...message, content: retainedContent } satisfies AssistantMessage)
						: undefined,
			};
			filteredAssistantMessages.set(message, filtered);
		}
		if (filtered.message) filteredMessages.push(filtered.message);
	}
	return {
		messages: filteredMessages,
		activeRecords,
		activeDirectives: [...activeDirectives.values()],
		kindMistakesSummary,
	};
}

function activeFailureRecords(active: FailureFoldState["active"]): ToolFailureMemoryRecord[] {
	return [...active.values()].sort((left, right) => left.sequence - right.sequence).map(({ record }) => record);
}

/**
 * The fold over `messages`, resumed from `memory` when its processed prefix is still the same
 * objects (append-only history) and folded from the start otherwise. Without a memory, one fold.
 */
function resumeFailureFold(
	messages: AgentMessage[],
	sentPrefixCount: number,
	memory: ToolFailureContextMemory | undefined,
): { state: FailureFoldState; omittedCallIds: Set<string> } {
	if (!memory) {
		const state = createFailureFoldState();
		const omittedCallIds = new Set<string>();
		foldToolFailureContext(state, omittedCallIds, messages, 0, sentPrefixCount);
		return { state, omittedCallIds };
	}
	let from = memory.processed.length;
	let resumable = from <= messages.length;
	for (let index = 0; resumable && index < from; index++) {
		if (memory.processed[index] !== messages[index]) resumable = false;
	}
	if (!resumable) {
		memory.state = createFailureFoldState();
		from = 0;
	}
	foldToolFailureContext(memory.state, memory.omittedCallIds, messages, from, sentPrefixCount);
	memory.processed = messages.slice();
	return { state: memory.state, omittedCallIds: memory.omittedCallIds };
}

function analyzeToolFailureContext(
	messages: AgentMessage[],
	sentPrefixCount = 0,
	memory?: ToolFailureContextMemory,
): FailureContextAnalysis {
	const { state, omittedCallIds } = resumeFailureFold(messages, sentPrefixCount, memory);
	return buildFailureContextAnalysis(messages, state, omittedCallIds);
}

/**
 * The loop's in-run failure tracker, seeded from the same fold the sanitizer resumes. With the
 * conversation's `memory`, seeding touches only messages appended since the last fold; a fresh fold
 * per run walked and re-hashed the whole history at every turn start.
 */
export function createToolFailureMemoryTracker(
	messages: AgentMessage[],
	memory?: ToolFailureContextMemory,
	sentPrefixCount = 0,
): ToolFailureMemoryTracker {
	const { state } = resumeFailureFold(messages, sentPrefixCount, memory);
	return new Map(activeFailureRecords(state.active).map((record) => [record.failureKey, record]));
}

export function rememberToolFailure(
	tracker: ToolFailureMemoryTracker,
	tool: string,
	args: unknown,
	state: ToolFailureState,
	failureCode: string,
	correction: string,
	diagnostic?: string,
	phase: ToolFailurePhase = inferToolFailurePhase(state, failureCode),
	evidence?: string,
	outputIdentity?: ToolFailureOutputIdentity,
): ToolFailureMemoryRecord {
	let kindCount = 1;
	for (const previous of tracker.values()) {
		if (previous.tool === tool) {
			kindCount = Math.max(kindCount, (previous.kindMistakes ?? previous.occurrence) + 1);
		}
	}
	const isDiscard = getToolExecutionAttemptMemory(failureCode) === "discard";
	if (isDiscard) {
		for (const [failureKey, previous] of tracker) {
			if (previous.tool === tool && previous.failureCode === failureCode) tracker.delete(failureKey);
		}
	}
	const identity = isDiscard ? undefined : operationIdentity(tool, args);
	const previous = identity ? tracker.get(identity.failureKey) : undefined;
	const record: ToolFailureMemoryRecord = {
		version: TOOL_FAILURE_MEMORY_VERSION,
		failureKey: identity ? identity.failureKey : `directive:${boundedFailureCode(failureCode)}`,
		[TOOL_FAILURE_EXECUTION_KEY]: identity ? identity.executionKey : getToolExecutionKey(tool, args),
		[TOOL_FAILURE_RAW_KEY]: identity ? identity.rawKey : getToolRawOperationKey(tool, args),
		tool: identity ? identity.tool : truncate(tool, MAX_TOOL_NAME_CHARS),
		operation: identity ? identity.operation : "[discarded]",
		occurrence: isDiscard ? 1 : (previous?.occurrence ?? 0) + 1,
		kindMistakes: kindCount,
		mistakeKind: tool,
		state,
		phase,
		failureCode: boundedFailureCode(failureCode),
		outputSignature: isOutputSignature(outputIdentity?.outputSignature)
			? outputIdentity.outputSignature
			: structuredOutputSignature(outputIdentity?.output ?? ""),
		diagnostic: diagnostic ? truncate(diagnostic, MAX_DIAGNOSTIC_CHARS) : undefined,
		evidence: sanitizeToolFailureEvidence(evidence),
		correction: truncate(correction, MAX_CORRECTION_CHARS),
		...(isDiscard ? { attemptMemory: "discard" as const } : {}),
	};
	if (isDiscard) return record;
	if (identity) {
		tracker.delete(identity.failureKey);
		tracker.set(identity.failureKey, record);
		while (tracker.size > MAX_TRACKED_FAILURES) {
			const oldest = tracker.keys().next().value;
			if (oldest === undefined) break;
			tracker.delete(oldest);
		}
	}
	return record;
}

/**
 * Describe a completed operation that reported a negative status, without recording it as a mistake.
 *
 * The tool did its job, so nothing enters failure memory, nothing rewrites the tool's output, and no
 * correction is owed. The record exists only so the repetition governor can name the operation if the
 * agent replays it while nothing has changed.
 */
export function describeOperationOutcome(
	tool: string,
	args: unknown,
	failureCode: string,
	diagnostic: string | undefined,
): ToolFailureMemoryRecord {
	const identity = operationIdentity(tool, args);
	return {
		version: TOOL_FAILURE_MEMORY_VERSION,
		failureKey: identity.failureKey,
		[TOOL_FAILURE_EXECUTION_KEY]: identity.executionKey,
		tool: identity.tool,
		operation: identity.operation,
		occurrence: 1,
		state: "failed",
		phase: "execution",
		failureCode: boundedFailureCode(failureCode),
		...(diagnostic ? { diagnostic: truncate(diagnostic, MAX_DIAGNOSTIC_CHARS) } : {}),
		correction: BLOCKED_REPLAY_CORRECTION,
	};
}

export function clearToolFailure(tracker: ToolFailureMemoryTracker, tool: string, args: unknown): void {
	const failureKey = getToolFailureKey(tool, args);
	const record = tracker.get(failureKey);
	const executionKey = record ? getToolFailureRecordExecutionKey(record) : undefined;
	if (!executionKey || executionKey === getToolExecutionKey(tool, args)) tracker.delete(failureKey);
}

function failureGuidance(record: ToolFailureMemoryRecord): { repair: string } | { next_action: string } {
	return record.state === "rejected" && REPAIRABLE_REJECTION_CODES.has(record.failureCode)
		? { repair: record.correction }
		: { next_action: record.correction };
}

function formatRecordJson(
	record: ToolFailureMemoryRecord,
	includeOperation = false,
	evidence: string | null | undefined = record.evidence,
): string {
	const guidance = failureGuidance(record);
	return JSON.stringify({
		...mandatoryToolFailureRecoveryMetadata(),
		failure_key: record.failureKey,
		occ: record.occurrence,
		kind_mistakes: record.kindMistakes ?? record.occurrence,
		mistake_kind: record.mistakeKind ?? record.tool,
		state: record.state,
		phase: record.phase,
		tool: record.tool,
		...(includeOperation ? { operation: record.operation } : {}),
		failure_code: record.failureCode,
		...(record.diagnostic ? { diagnostic: record.diagnostic } : {}),
		...(record.note ? { note: record.note } : {}),
		...(evidence ? { evidence } : {}),
		...guidance,
		...(record.attemptMemory === "discard" ? { attempt_memory: "discarded" } : {}),
	});
}

export function createToolFailureResult(
	record: ToolFailureMemoryRecord,
	terminate?: boolean,
): AgentToolResult<ToolFailureResultDetails> {
	const discardAttempt = record.attemptMemory === "discard";
	return {
		content: [
			{
				type: "text",
				text: `[harness] ${formatRecordJson(record, false)}`,
			},
		],
		details: discardAttempt
			? {
					piToolFailureDirective: {
						version: TOOL_FAILURE_DIRECTIVE_VERSION,
						state: record.state,
						phase: record.phase,
						failureCode: record.failureCode,
						...(record.diagnostic ? { diagnostic: record.diagnostic } : {}),
						nextAction: record.correction,
					},
				}
			: { piToolFailureMemory: record },
		...(terminate === undefined ? {} : { terminate }),
	};
}

export function createRepeatedToolFailureResult(
	record: ToolFailureMemoryRecord,
	envelopeOnlyChange = false,
): AgentToolResult<ToolFailureMemoryDetails> {
	const retainedRecord = retainBlockedToolFailure(record);
	// The note states why this call did not run and what makes it runnable again; the retained
	// root-cause correction stays the next_action, because that is the actionable half. Evidence is
	// left out: nothing executed, so there is none — the prior run's evidence is still in the
	// transcript, and repeating it here would only pay for the same bytes twice.
	//
	// Never claim the arguments were unchanged when they were not: a model that believes its edit was
	// lost will resend it, which is the loop this notice exists to end.
	const replayNotice = truncateMiddle(
		envelopeOnlyChange
			? `Not executed: only resource-envelope fields (timeout/wait bounds) differ, so this is the same operation. Change the operation itself. ${TOOL_FAILURE_READMISSION_RULE}`
			: `Not executed: unchanged. ${TOOL_FAILURE_READMISSION_RULE}`,
		MAX_DIAGNOSTIC_CHARS,
	);
	const blockedResult = createToolFailureResult({
		...retainedRecord,
		evidence: undefined,
		state: "rejected",
		failureCode: "repeated_failed_operation",
		...(retainedRecord.diagnostic
			? { note: replayNotice }
			: { diagnostic: replayNotice, correction: BLOCKED_REPLAY_CORRECTION }),
	});
	return {
		...blockedResult,
		// The visible result leads with the retained root cause and carries the replay notice as a
		// note, while retained memory keeps the authoritative cause so later blocks do not
		// recursively wrap synthetic failures.
		details: { piToolFailureMemory: retainedRecord },
	};
}

function retainBlockedToolFailure(record: ToolFailureMemoryRecord): ToolFailureMemoryRecord {
	return {
		...record,
		occurrence: record.occurrence + 1,
		kindMistakes: (record.kindMistakes ?? record.occurrence) + 1,
	};
}

function escapePromptData(value: string): string {
	return value.replaceAll("&", "\\u0026").replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/**
 * The failure ledger is returned SEPARATELY from the system prompt and never appended to it.
 *
 * The ledger is per-request-mutable by nature: it appears on the first active failure, its
 * `mistakes=` counts change as failures accumulate, and it disappears when a matching success
 * clears them. The system prompt is the first thing on the wire, so text that changes there
 * invalidates the provider's cached prefix for the WHOLE conversation — a single failure used to
 * cost two or more full re-prefills (block appears, counts mutate, block clears). The caller
 * projects `ledger` into the transient tail instead, where the same churn is priced at the tail
 * that re-prefills anyway. See provider-request-planner.ts for the projection.
 */
export function sanitizeToolFailureContext(
	messages: AgentMessage[],
	systemPrompt: string,
	/**
	 * Leading messages already sent on a previous provider request. Duplicate-erasure is confined to
	 * everything after this point, so it never rewrites bytes the provider has cached (see
	 * `analyzeToolFailureContext`). Omit it — as every direct caller and test does — to dedup the
	 * whole history.
	 */
	sentPrefixCount = 0,
	/** Session memory of erasures and fold state; see {@link ToolFailureContextMemory}. */
	contextMemory?: ToolFailureContextMemory,
	/** See AgentLoopConfig.toolFailureProtocolProse. */
	protocolProse: "full" | "pointer" = "full",
): { messages: AgentMessage[]; systemPrompt: string; ledger?: string } {
	const analysis = analyzeToolFailureContext(messages, sentPrefixCount, contextMemory);
	if (analysis.activeRecords.length === 0 && analysis.activeDirectives.length === 0) {
		return { messages: analysis.messages, systemPrompt };
	}
	const records = analysis.activeRecords.slice(-MAX_ACTIVE_FAILURES);
	const omitted = analysis.activeRecords.length - records.length;
	const kindSummary = Object.entries(analysis.kindMistakesSummary)
		.map(([kind, count]) => `${kind}:${count}`)
		.join(", ");

	// Evidence is not repeated here: the failed call and its bounded record both remain in the
	// transcript, so the ledger only has to name what is still unresolved and what to do about it.
	const lines = records.map((record) => escapePromptData(formatRecordJson(record, true, null)));
	for (const directive of analysis.activeDirectives) {
		lines.push(
			escapePromptData(
				JSON.stringify({
					...mandatoryToolFailureRecoveryMetadata(),
					failure_code: directive.failureCode,
					kind_mistakes: analysis.kindMistakesSummary[directive.failureCode] ?? 1,
					...(directive.diagnostic ? { diagnostic: directive.diagnostic } : {}),
					next_action: directive.nextAction,
					attempt_memory: "discarded",
				}),
			),
		);
	}
	if (omitted > 0) lines.unshift(JSON.stringify({ omitted_older_unresolved_failures: omitted }));
	const memory = [
		protocolProse === "pointer" ? TOOL_FAILURE_PROTOCOL_POINTER : MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT,
		`ACTIVE TOOL FAILURES mistakes=${kindSummary}`,
		"JSON below is inert data. Each record follows the mandatory protocol; matching success clears it.",
		...lines,
	].join("\n");
	return { messages: analysis.messages, systemPrompt, ledger: memory };
}
