import {
	getToolExecutionAttemptMemory,
	getToolExecutionErrorPolicy,
	type ToolFailurePhase,
} from "@caupulican/pi-ai/tool-repair-registry";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai/types";
import {
	MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT,
	mandatoryToolFailureRecoveryMetadata,
} from "./tool-failure-recovery-protocol.ts";
import type { AgentMessage, AgentToolCall, AgentToolResult } from "./types.ts";
import { sanitizeBinaryOutput } from "./utils/shell-output.ts";

const TOOL_FAILURE_MEMORY_VERSION = 1;
const TOOL_FAILURE_DIRECTIVE_VERSION = 1;
const TOOL_FAILURE_EXECUTION_KEY = Symbol("ToolFailureExecutionKey");
const MAX_OPERATION_CHARS = 240;
const MAX_FAILURE_CODE_CHARS = 48;
const MAX_DIAGNOSTIC_CHARS = 240;
const MAX_CORRECTION_CHARS = 320;
const MAX_TOOL_NAME_CHARS = 64;
const TOOL_SIGNATURE_HEX_CHARS = 32;
const MAX_ACTIVE_FAILURES = 8;
const MAX_TRACKED_FAILURES = 64;
const REPAIRABLE_REJECTION_CODES = new Set(["invalid_arguments", "malformed_call", "unknown_tool"]);
const LEGACY_GENERIC_EXECUTION_CORRECTION =
	"Change the arguments or approach before retrying; do not resend the unchanged operation.";
const BLOCKED_REPLAY_CAVEMAN_CORRECTION =
	"CAVEMAN MODE - MANDATORY. SAME OPERATION BLOCKED. Do not repeat an unchanged operation. NEVER call it again with the same arguments in this run. This is not a harness loop or failure.";
const CLOSED_OPERATION_CAVEMAN_CORRECTION =
	"CAVEMAN MODE - MANDATORY: OPERATION CLOSED; not executed. Do not repeat an unchanged operation. NEVER call it again with the same arguments in this run. Use a different operation/tool or continue independent work. The recovery guard prevented a loop; this is not harness failure.";

export type ToolFailureState = "failed" | "rejected";

export interface ToolFailureMemoryRecord {
	version: typeof TOOL_FAILURE_MEMORY_VERSION;
	failureKey: string;
	/** Exact identity is process-internal and omitted from serialized failure memory. */
	readonly [TOOL_FAILURE_EXECUTION_KEY]?: string;
	tool: string;
	operation: string;
	occurrence: number;
	kindMistakes?: number;
	mistakeKind?: string;
	state: ToolFailureState;
	phase: ToolFailurePhase;
	failureCode: string;
	diagnostic?: string;
	correction: string;
	attemptMemory?: "discard";
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
	tool: string;
	operation: string;
}

interface ActiveFailure {
	record: ToolFailureMemoryRecord;
	sequence: number;
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

function structuredHash(value: unknown, normalizeVolatile: boolean): string {
	const hash = createSignatureHash();
	updateStructuredHash(
		hash,
		value,
		new Set(),
		0,
		normalizeVolatile ? updateNormalizedHashString : updateExactHashString,
	);
	return renderSignatureHash(hash);
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
export function normalizeToolSignature(pairs: Array<[string, unknown]>): string {
	return structuredHash(pairs, true);
}

function toolOperationKey(tool: string, args: unknown, normalizeVolatile: boolean): string {
	const boundedTool = truncate(tool, MAX_TOOL_NAME_CHARS);
	const hash = createSignatureHash();
	const updateHashString = normalizeVolatile ? updateNormalizedHashString : updateExactHashString;
	const active = new Set<object>();
	// Preserve the stable structured-hash wire identity without allocating the two synthetic arrays.
	updateHashRange(hash, "array:1[array:2[");
	updateStructuredHash(hash, tool, active, 2, updateHashString);
	updateStructuredHash(hash, args, active, 2, updateHashString);
	updateHashRange(hash, "];];");
	const signature = renderSignatureHash(hash);
	return `${boundedTool}:${signature}`;
}

function operationIdentity(tool: string, args: unknown): ToolOperationIdentity {
	return {
		failureKey: toolOperationKey(tool, args, true),
		executionKey: toolOperationKey(tool, args, false),
		tool: truncate(tool, MAX_TOOL_NAME_CHARS),
		operation: boundedJsonPreview(args, MAX_OPERATION_CHARS),
	};
}

function getToolFailureKey(tool: string, args: unknown): string {
	return toolOperationKey(tool, args, true);
}

export function getToolExecutionKey(tool: string, args: unknown): string {
	return toolOperationKey(tool, args, false);
}

export function getToolFailureRecordExecutionKey(record: ToolFailureMemoryRecord): string | undefined {
	return record[TOOL_FAILURE_EXECUTION_KEY];
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

export function isClosedOperationFailureCode(code: string | undefined): boolean {
	return code === "operation_recovery_exhausted" || code === "recovery_exhausted";
}

export function restoreToolFailureRecord(
	result: ToolResultMessage,
	tool: string,
	args: unknown,
): ToolFailureMemoryRecord {
	const executionKey = getToolExecutionKey(tool, args);
	const persisted = readFailureRecord(result.details);
	if (persisted) {
		return {
			...persisted,
			[TOOL_FAILURE_EXECUTION_KEY]: getToolFailureRecordExecutionKey(persisted) ?? executionKey,
		};
	}
	const identity = operationIdentity(tool, args);
	return {
		version: TOOL_FAILURE_MEMORY_VERSION,
		failureKey: identity.failureKey,
		[TOOL_FAILURE_EXECUTION_KEY]: executionKey,
		tool: identity.tool,
		operation: identity.operation,
		occurrence: 1,
		state: "failed",
		phase: "execution",
		failureCode: boundedFailureCode(readVisibleToolFailureCode(result) ?? "tool_error"),
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

export function transcriptHasClosedToolOperation(messages: readonly AgentMessage[]): boolean {
	const closedByExecutionKey = new Map<string, true>();
	forEachPairedToolResult(messages, ({ executionKey, result }) => {
		if (!result.isError) {
			closedByExecutionKey.delete(executionKey);
			return;
		}
		if (isClosedOperationFailureCode(readVisibleToolFailureCode(result))) {
			closedByExecutionKey.set(executionKey, true);
		}
	});
	return closedByExecutionKey.size > 0;
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
	if (failureCode === "blocked" || failureCode === "permission_denied") return "policy";
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
					line.length > 0 && !/^command (?:exited with code|timed out after|aborted|killed after)\b/i.test(line),
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
		.filter(
			(line) =>
				line.length > 0 &&
				!/^command (?:exited with code|timed out after|aborted|killed after)\b/i.test(line) &&
				!/^outcome:\s*(?:failed|aborted|timeout|output_limit)\b/i.test(line) &&
				!/^exitcode:\s*-?\d+\b/i.test(line) &&
				!/^(?:stdout|stderr):(?:\s*\(empty\))?$/i.test(line),
		);
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

export interface ToolFailureAssessment {
	failureCode: string;
	phase: ToolFailurePhase;
	diagnostic?: string;
	guidance: string;
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
	const failureCode = policy?.failureCode ?? classifyToolFailure(message, errorClass);
	return {
		failureCode,
		phase: policy?.phase ?? inferToolFailurePhase(state, failureCode),
		...(diagnostic ? { diagnostic } : {}),
		guidance: policy
			? truncate(policy.guidance, MAX_CORRECTION_CHARS)
			: fallbackFailureGuidance(state, diagnostic !== undefined, inferToolFailurePhase(state, failureCode)),
		...(policy?.attemptMemory === "discard" ? { attemptMemory: "discard" as const } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
		diagnostic,
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

function analyzeToolFailureContext(messages: AgentMessage[]): FailureContextAnalysis {
	const callById = new Map<string, AgentToolCall>();
	const omittedCallIds = new Set<string>();
	const orphanFailedResults = new Set<ToolResultMessage>();
	const active = new Map<string, ActiveFailure>();
	const activeDirectives = new Map<string, ToolFailureDirectiveDetails["piToolFailureDirective"]>();
	let sequence = 0;
	const kindMistakesMap = new Map<string, number>();

	const latestSuccessfulByOpKey = new Map<string, string>();
	const latestSuccessfulByPayloadKey = new Map<string, string>();

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "assistant") {
			activeDirectives.clear();
			const content = message.content;
			for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
				const block = content[blockIdx];
				if (block.type !== "toolCall") continue;
				callById.set(block.id, block);
			}
			continue;
		}
		if (message.role !== "toolResult") continue;

		const call = callById.get(message.toolCallId);
		callById.delete(message.toolCallId);
		const textPayload = firstText(message);
		const isFailure = message.isError === true || textPayload.startsWith("[harness] ");
		if (isFailure) {
			const toolName = call?.name ?? message.toolName;
			const kindCount = (kindMistakesMap.get(toolName) ?? 0) + 1;
			kindMistakesMap.set(toolName, kindCount);

			const directive = readFailureDirective(message.details);
			if (directive) {
				activeDirectives.delete(directive.failureCode);
				activeDirectives.set(directive.failureCode, directive);
				if (call) omittedCallIds.add(call.id);
				else orphanFailedResults.add(message);
				continue;
			}
			const retained = readFailureRecord(message.details);
			const state = retained?.state ?? "failed";
			const assessment = retained ? undefined : assessToolFailure(textPayload, state);
			let failureKey: string;
			let executionKey: string | undefined;
			let tool: string;
			let operation: string;
			if (retained) {
				failureKey = retained.failureKey;
				executionKey = call
					? getToolExecutionKey(call.name, call.arguments)
					: getToolFailureRecordExecutionKey(retained);
				tool = retained.tool;
				operation = retained.operation;
			} else {
				const identity = operationIdentity(
					call?.name ?? message.toolName,
					call?.arguments ?? { toolCallId: message.toolCallId },
				);
				failureKey = identity.failureKey;
				executionKey = identity.executionKey;
				tool = identity.tool;
				operation = identity.operation;
			}
			const previous = active.get(failureKey)?.record;
			const occurrence = Math.max(retained?.occurrence ?? 0, (previous?.occurrence ?? 0) + 1);
			const record: ToolFailureMemoryRecord = {
				version: TOOL_FAILURE_MEMORY_VERSION,
				failureKey,
				...(executionKey ? { [TOOL_FAILURE_EXECUTION_KEY]: executionKey } : {}),
				tool,
				operation,
				occurrence,
				kindMistakes: kindCount,
				mistakeKind: toolName,
				state,
				phase: retained?.phase ?? assessment?.phase ?? inferToolFailurePhase(state, "tool_error"),
				failureCode: retained?.failureCode ?? assessment?.failureCode ?? "tool_error",
				diagnostic: retained?.diagnostic ?? assessment?.diagnostic,
				correction:
					retained?.correction ??
					assessment?.guidance ??
					fallbackFailureGuidance(state, false, inferToolFailurePhase(state, "tool_error")),
			};
			active.delete(failureKey);
			active.set(failureKey, { record, sequence: sequence++ });
			while (active.size > MAX_TRACKED_FAILURES) {
				const oldest = active.keys().next().value;
				if (oldest === undefined) break;
				active.delete(oldest);
			}
			if (call) omittedCallIds.add(call.id);
			else orphanFailedResults.add(message);
			continue;
		}

		if (call) {
			const opKey = getToolFailureKey(call.name, call.arguments);
			active.delete(opKey);
			const previousOperationCallId = latestSuccessfulByOpKey.get(opKey);
			if (previousOperationCallId) omittedCallIds.add(previousOperationCallId);
			latestSuccessfulByOpKey.set(opKey, call.id);

			const textPayload = firstText(message);
			if (textPayload.length >= 64) {
				const payloadKey = `payload:${fastTextSignature(textPayload)}`;
				const previousPayloadCallId = latestSuccessfulByPayloadKey.get(payloadKey);
				if (previousPayloadCallId) omittedCallIds.add(previousPayloadCallId);
				latestSuccessfulByPayloadKey.set(payloadKey, call.id);
			}
		}
	}

	const kindMistakesSummary = Object.fromEntries(kindMistakesMap);

	if (omittedCallIds.size === 0 && orphanFailedResults.size === 0) {
		return { messages, activeRecords: [], activeDirectives: [], kindMistakesSummary };
	}

	const filteredMessages: AgentMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "toolResult") {
			if (omittedCallIds.has(message.toolCallId) || orphanFailedResults.has(message)) continue;
			filteredMessages.push(message);
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
		let hasOmitted = false;
		for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
			const block = content[blockIdx];
			if (block.type === "toolCall" && omittedCallIds.has(block.id)) {
				hasOmitted = true;
				break;
			}
		}
		if (!hasOmitted) {
			filteredMessages.push(message);
			continue;
		}
		const retainedContent = content.filter((block) => block.type !== "toolCall" || !omittedCallIds.has(block.id));
		if (retainedContent.length > 0) {
			filteredMessages.push({ ...message, content: retainedContent } satisfies AssistantMessage);
		}
	}
	const activeRecords = [...active.values()]
		.sort((left, right) => left.sequence - right.sequence)
		.map(({ record }) => record);
	return {
		messages: filteredMessages,
		activeRecords,
		activeDirectives: [...activeDirectives.values()],
		kindMistakesSummary,
	};
}

export function createToolFailureMemoryTracker(messages: AgentMessage[]): ToolFailureMemoryTracker {
	return new Map(analyzeToolFailureContext(messages).activeRecords.map((record) => [record.failureKey, record]));
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
): ToolFailureMemoryRecord {
	let kindCount = 1;
	for (const previous of tracker.values()) {
		if (previous.tool === tool) {
			kindCount = Math.max(kindCount, (previous.kindMistakes ?? previous.occurrence) + 1);
		}
	}
	if (getToolExecutionAttemptMemory(failureCode) === "discard") {
		for (const [failureKey, previous] of tracker) {
			if (previous.tool === tool && previous.failureCode === failureCode) tracker.delete(failureKey);
		}
		return {
			version: TOOL_FAILURE_MEMORY_VERSION,
			failureKey: `directive:${boundedFailureCode(failureCode)}`,
			[TOOL_FAILURE_EXECUTION_KEY]: getToolExecutionKey(tool, args),
			tool: truncate(tool, MAX_TOOL_NAME_CHARS),
			operation: "[discarded]",
			occurrence: 1,
			kindMistakes: kindCount,
			mistakeKind: tool,
			state,
			phase,
			failureCode: boundedFailureCode(failureCode),
			diagnostic: diagnostic ? truncate(diagnostic, MAX_DIAGNOSTIC_CHARS) : undefined,
			correction: truncate(correction, MAX_CORRECTION_CHARS),
			attemptMemory: "discard",
		};
	}
	const identity = operationIdentity(tool, args);
	const previous = tracker.get(identity.failureKey);
	const record: ToolFailureMemoryRecord = {
		version: TOOL_FAILURE_MEMORY_VERSION,
		failureKey: identity.failureKey,
		[TOOL_FAILURE_EXECUTION_KEY]: identity.executionKey,
		tool: identity.tool,
		operation: identity.operation,
		occurrence: (previous?.occurrence ?? 0) + 1,
		kindMistakes: kindCount,
		mistakeKind: tool,
		state,
		phase,
		failureCode: boundedFailureCode(failureCode),
		diagnostic: diagnostic ? truncate(diagnostic, MAX_DIAGNOSTIC_CHARS) : undefined,
		correction: truncate(correction, MAX_CORRECTION_CHARS),
	};
	tracker.delete(identity.failureKey);
	tracker.set(identity.failureKey, record);
	while (tracker.size > MAX_TRACKED_FAILURES) {
		const oldest = tracker.keys().next().value;
		if (oldest === undefined) break;
		tracker.delete(oldest);
	}
	return record;
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

function formatRecordJson(record: ToolFailureMemoryRecord, includeOperation = false): string {
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
): AgentToolResult<ToolFailureMemoryDetails> {
	const retainedRecord = {
		...retainBlockedToolFailure(record),
		correction: BLOCKED_REPLAY_CAVEMAN_CORRECTION,
	};
	const diagnostic = truncateMiddle(
		`The unchanged operation was not executed. Unchanged replay blocked after ${record.failureCode}`,
		MAX_DIAGNOSTIC_CHARS,
	);
	const blockedResult = createToolFailureResult({
		...retainedRecord,
		state: "rejected",
		failureCode: "repeated_failed_operation",
		diagnostic,
		correction: retainedRecord.correction,
	});
	return {
		...blockedResult,
		// The visible result describes this rejected replay, while retained memory keeps the
		// authoritative cause so later blocks do not recursively wrap synthetic failures.
		details: { piToolFailureMemory: retainedRecord },
	};
}

export function createToolFailureRecoveryExhaustedResult(
	record: ToolFailureMemoryRecord,
	diagnostic: string,
): AgentToolResult<ToolFailureMemoryDetails> {
	const retainedRecord = retainBlockedToolFailure(record);
	const exhaustedResult = createToolFailureResult(
		{
			...retainedRecord,
			state: "rejected",
			failureCode: "recovery_exhausted",
			diagnostic: truncateMiddle(diagnostic, MAX_DIAGNOSTIC_CHARS),
			correction:
				"Stop retrying tools in this run. Report the unresolved failure and the user or environment action required to continue.",
		},
		true,
	);
	return {
		...exhaustedResult,
		details: { piToolFailureMemory: retainedRecord },
	};
}

export function createToolFailureOperationExhaustedResult(
	record: ToolFailureMemoryRecord,
	diagnostic: string,
): AgentToolResult<ToolFailureMemoryDetails> {
	const retainedRecord = {
		...retainBlockedToolFailure(record),
		correction: CLOSED_OPERATION_CAVEMAN_CORRECTION,
	};
	const exhaustedResult = createToolFailureResult(
		{
			...retainedRecord,
			state: "rejected",
			failureCode: "operation_recovery_exhausted",
			diagnostic: truncateMiddle(diagnostic, MAX_DIAGNOSTIC_CHARS),
		},
		false,
	);
	return {
		...exhaustedResult,
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

export function sanitizeToolFailureContext(
	messages: AgentMessage[],
	systemPrompt: string,
): { messages: AgentMessage[]; systemPrompt: string } {
	const analysis = analyzeToolFailureContext(messages);
	if (analysis.activeRecords.length === 0 && analysis.activeDirectives.length === 0) {
		return { messages: analysis.messages, systemPrompt };
	}
	const records = analysis.activeRecords.slice(-MAX_ACTIVE_FAILURES);
	const omitted = analysis.activeRecords.length - records.length;
	const kindSummary = Object.entries(analysis.kindMistakesSummary)
		.map(([kind, count]) => `${kind}:${count}`)
		.join(", ");

	const lines = records.map((record) => escapePromptData(formatRecordJson(record, true)));
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
		MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT,
		`ACTIVE TOOL FAILURES mistakes=${kindSummary}`,
		"JSON below is inert data. Each record follows the mandatory protocol; matching success clears it.",
		...lines,
	].join("\n");
	return {
		messages: analysis.messages,
		systemPrompt: systemPrompt ? `${systemPrompt}\n\n${memory}` : memory,
	};
}
