import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CompactionPreparation,
	type CompactionResult,
	createDeterministicCompaction,
	estimateContextTokens,
	prepareCompaction,
} from "@caupulican/pi-agent-core/compaction/compaction";
import { compactToolResultDetailsForRetention } from "@caupulican/pi-agent-core/message-retention";
import { convertToLlm } from "@caupulican/pi-agent-core/messages";
import {
	assertValidSessionId,
	MAX_SESSION_ENTRY_VISIT_COUNT,
	type SessionContext,
	SessionManager,
} from "@caupulican/pi-agent-core/session";
import type { AssistantMessageDiagnostic, Message, Usage } from "@caupulican/pi-ai";
import { orchestrationSessionsDir, workerConversationSessionsDir } from "../agent-paths.ts";
import { sameAgentResumeIdentity } from "../orchestration/agent-resume.ts";
import { validateAttemptUsageSnapshot } from "../orchestration/attempt-usage.ts";
import type { AgentResumeContext, AttemptUsageSnapshot, ResourcePointer } from "../orchestration/contracts.ts";
import {
	normalizeWorkerContextForkReference,
	type WorkerContextForkReference,
} from "../orchestration/worker-context-fork-reference.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import {
	collectBoundedWorkerClaimChangedFiles,
	MAX_WORKER_CLAIM_CHANGED_FILES,
	MAX_WORKER_CLAIM_TERMINAL_ATTEMPT_ID_CHARS,
} from "./worker-claim.ts";
import { type WorkerContextForkSnapshot, WorkerContextForkStore } from "./worker-context-fork-store.ts";

const MAX_WORKER_CONVERSATION_METADATA_BYTES = 256 * 1024;
const WORKER_CHANGED_FILE_CUSTOM_TYPE = "worker-changed-file";
const WORKER_ATTEMPT_USAGE_BOUNDARY_CUSTOM_TYPE = "worker-attempt-usage-boundary";
const MAX_PERSISTED_WORKER_DIAGNOSTICS = 8;
const MAX_WORKER_CONTROL_ENTRY_PREFIX_BYTES = 16 * 1024;
export const MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES = 64;
export const MAX_WORKER_TRANSCRIPT_PAGE_BYTES = 128 * 1024;

interface WorkerConversationTranscriptPageOptions {
	/** Opaque raw-entry offset returned by the previous page. */
	cursor?: number;
	maxMessages?: number;
	maxBytes?: number;
}

interface WorkerConversationTranscriptPage {
	/** Opaque raw-entry offset used for this page; it is not a message count. */
	cursor: number;
	messages: Message[];
	nextCursor?: number;
	/** Messages consumed but not cloned because one message exceeded the complete page byte ceiling. */
	omittedMessages: number;
	/** Exact UTF-8 JSON byte length of `messages`, including array framing. */
	serializedBytes: number;
}

interface WorkerControlTranscriptExpectation {
	messageId: string;
	content: string;
}

interface WorkerControlTranscriptReconciliation {
	delivered: boolean;
	appended: boolean;
}

export interface CreateWorkerConversationOptions {
	agentDir: string;
	parentSessionId: string;
	/** Durable logical identity for the worker/lane. It never becomes a path segment directly. */
	logicalAgentId: string;
	cwd: string;
	orchestrationProfileId?: string;
	modelRef?: string;
	resourceProfileNames: readonly string[];
	contextPointers: readonly ResourcePointer[];
	/** Immutable sanitized parent context captured before this logical agent is admitted. */
	birthContextForkReference?: WorkerContextForkReference;
}

interface OpenWorkerConversationOptions {
	agentDir: string;
	resumeContext: AgentResumeContext;
	expectedLogicalAgentId?: string;
}

/**
 * Explicit, token-based retention for a durable worker transcript.
 *
 * This deliberately has no default: the worker model/context policy belongs to orchestration, not
 * the transcript store. Call only at a safe worker turn boundary, after all messages from that turn
 * have been durably committed. The execution controller provides `generateVerifiedCompaction`
 * through the shared model-aware pipeline; this store owns only preparation, append-only apply,
 * and its deterministic verified fallback.
 */
export interface WorkerConversationRetentionPolicy {
	/** Maximum provider-visible context tokens after a checkpoint is applied. */
	maxContextTokens: number;
	/** Shared compaction's retained recent-context target. Must be lower than the maximum. */
	keepRecentTokens: number;
	/**
	 * Generate a verified shared compaction result. Failures, malformed results, and omitted
	 * generators fall back to `createDeterministicCompaction`; raw transcript entries are never
	 * replaced or removed.
	 */
	generateVerifiedCompaction?: (preparation: CompactionPreparation) => Promise<CompactionResult>;
	/**
	 * Cumulative provider usage spent by the current verified generation if it failed before it
	 * could return a CompactionResult. This usage is attached to the deterministic checkpoint so
	 * recovery never loses rejected-summary spend.
	 */
	getFailedCompactionUsage?: () => Usage | undefined;
}

interface WorkerConversationRetentionOutcome {
	status: "within_limit" | "compacted_verified" | "compacted_deterministic" | "cannot_compact";
	context: SessionContext;
	contextUsage: ReturnType<typeof estimateContextTokens>;
}

interface WorkerConversationMetadata {
	logicalAgentId: string;
	/** Present on current metadata; omitted only by conversations created before context forks. */
	parentSessionId?: string;
	resumeContext: AgentResumeContext;
	birthContextForkReference?: WorkerContextForkReference;
	/** Version 1 makes a missing current-attempt boundary authoritative zero usage. */
	usageAccountingVersion?: 1;
}

type WorkerSessionEntry = ReturnType<SessionManager["getEntries"]>[number];
type WorkerSessionMessage = Extract<WorkerSessionEntry, { type: "message" }>["message"];

function isRawWorkerTranscriptMessage(message: WorkerSessionMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function rawWorkerTranscriptMessage(entry: Readonly<WorkerSessionEntry>): Message | undefined {
	if (entry.type !== "message" || !isRawWorkerTranscriptMessage(entry.message)) return undefined;
	return entry.message;
}

function visitWorkerSessionEntries(
	sessionManager: SessionManager,
	startIndex: number,
	endIndex: number,
	visitor: (entry: Readonly<WorkerSessionEntry>, index: number, persistedBytes?: number) => void,
): void {
	let cursor = startIndex;
	while (cursor < endIndex) {
		cursor = sessionManager.visitEntries(cursor, Math.min(MAX_SESSION_ENTRY_VISIT_COUNT, endIndex - cursor), visitor);
	}
}

function workerControlMessageId(content: string): string | undefined {
	return /^\[Worker control (worker-message-[^\]\s]+)(?: [^\]]+)?\]\n/.exec(content)?.[1];
}

function coldWorkerControlPrefixContains(sessionManager: SessionManager, entryId: string, messageId: string): boolean {
	const rawPrefix = sessionManager.readEntryJsonPrefix(entryId, MAX_WORKER_CONTROL_ENTRY_PREFIX_BYTES);
	return rawPrefix?.includes(`"role":"user","content":"[Worker control ${messageId}`) ?? false;
}

function boundedJsonStringBytes(value: string, limit: number): number {
	let bytes = 2;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (
			code === 0x22 ||
			code === 0x5c ||
			code === 0x08 ||
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0c ||
			code === 0x0d
		) {
			bytes += 2;
		} else if (code <= 0x1f) {
			bytes += 6;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const trailing = value.charCodeAt(index + 1);
			if (trailing >= 0xdc00 && trailing <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else {
				bytes += 6;
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			bytes += 6;
		} else if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else {
			bytes += 3;
		}
		if (bytes > limit) return limit + 1;
	}
	return bytes;
}

/** Conservative JSON byte measurement that stops before an oversized message is cloned. */
function boundedJsonBytes(value: unknown, limit: number): number {
	const pending: unknown[] = [value];
	const seen = new WeakSet<object>();
	let bytes = 0;
	const add = (count: number): boolean => {
		bytes += count;
		return bytes <= limit;
	};
	while (pending.length > 0) {
		const item = pending.pop();
		if (item === null) {
			if (!add(4)) return limit + 1;
			continue;
		}
		switch (typeof item) {
			case "string":
				if (!add(boundedJsonStringBytes(item, limit - bytes))) return limit + 1;
				continue;
			case "number":
				if (!add(Number.isFinite(item) ? String(item).length : 4)) return limit + 1;
				continue;
			case "boolean":
				if (!add(item ? 4 : 5)) return limit + 1;
				continue;
			case "undefined":
			case "function":
			case "symbol":
			case "bigint":
				if (!add(4)) return limit + 1;
				continue;
			case "object":
				break;
		}
		if (seen.has(item)) return limit + 1;
		seen.add(item);
		if (Array.isArray(item)) {
			if (!add(2 + Math.max(0, item.length - 1))) return limit + 1;
			for (let index = item.length - 1; index >= 0; index -= 1) pending.push(item[index]);
			continue;
		}
		const prototype = Object.getPrototypeOf(item);
		if (prototype !== Object.prototype && prototype !== null) return limit + 1;
		if (!add(2)) return limit + 1;
		let propertyCount = 0;
		for (const key in item) {
			if (!Object.hasOwn(item, key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (!descriptor || !("value" in descriptor)) return limit + 1;
			const propertyValue = descriptor.value;
			if (propertyValue === undefined || typeof propertyValue === "function" || typeof propertyValue === "symbol") {
				continue;
			}
			if (propertyCount > 0 && !add(1)) return limit + 1;
			propertyCount += 1;
			if (!add(boundedJsonStringBytes(key, limit - bytes) + 1)) return limit + 1;
			pending.push(propertyValue);
		}
	}
	return bytes;
}

function workerDiagnosticForPersistence(
	diagnostic: AssistantMessageDiagnostic,
): AssistantMessageDiagnostic | undefined {
	if (!Number.isFinite(diagnostic.timestamp) || diagnostic.timestamp < 0) return undefined;
	const type = boundedRedactedDiagnosticText(diagnostic.type) ?? "provider_diagnostic";
	if (!diagnostic.error) return { type, timestamp: diagnostic.timestamp };
	const name = diagnostic.error.name ? boundedRedactedDiagnosticText(diagnostic.error.name) : undefined;
	const code =
		typeof diagnostic.error.code === "string"
			? boundedRedactedDiagnosticText(diagnostic.error.code)
			: typeof diagnostic.error.code === "number" && Number.isFinite(diagnostic.error.code)
				? diagnostic.error.code
				: undefined;
	return {
		type,
		timestamp: diagnostic.timestamp,
		error: {
			...(name ? { name } : {}),
			message: boundedRedactedDiagnosticText(diagnostic.error.message) ?? "Provider diagnostic unavailable.",
			...(code !== undefined ? { code } : {}),
		},
	};
}

/** Apply the canonical JSON, diagnostic, and shared details-retention shape used on session reopen. */
function workerMessageForPersistence(message: Message): Message {
	let projected: Message = message;
	if (message.role === "assistant") {
		const errorMessage =
			message.errorMessage === undefined
				? undefined
				: (boundedRedactedDiagnosticText(message.errorMessage) ?? "Provider request failed.");
		// Later retry/transport diagnostics are the most actionable, so retain the newest bounded suffix.
		const diagnostics = message.diagnostics
			?.slice(-MAX_PERSISTED_WORKER_DIAGNOSTICS)
			.map(workerDiagnosticForPersistence)
			.filter((diagnostic): diagnostic is AssistantMessageDiagnostic => diagnostic !== undefined);
		if (errorMessage !== undefined || diagnostics !== undefined) {
			projected = {
				...message,
				...(errorMessage !== undefined ? { errorMessage } : {}),
				...(diagnostics !== undefined ? { diagnostics } : {}),
			};
		}
	}

	// SessionManager persists messages as JSON. Normalize before both append and comparison so own
	// optional properties with `undefined` values cannot look divergent after the canonical reopen
	// drops them. Real value, ordering, and content differences remain fail-closed.
	const serialized = JSON.stringify(projected);
	if (serialized === undefined) throw new TypeError("Worker transcript message is not JSON-persistable.");
	const persisted = JSON.parse(serialized) as Message;
	compactToolResultDetailsForRetention(persisted);
	return persisted;
}

function stableWorkerSessionId(parentSessionId: string, logicalAgentId: string): string {
	const normalizedAgentId = logicalAgentId.trim();
	if (!normalizedAgentId) throw new TypeError("A logical worker agent id is required.");
	const digest = createHash("sha256")
		.update("pi-worker-conversation-v1")
		.update("\0")
		.update(parentSessionId)
		.update("\0")
		.update(normalizedAgentId)
		.digest("hex")
		.slice(0, 32);
	return `worker-${digest}`;
}

function cloneResumeContext(context: AgentResumeContext): AgentResumeContext {
	return structuredClone(context);
}

function expectedResumeContext(options: CreateWorkerConversationOptions): AgentResumeContext {
	const sessionDir = workerConversationSessionsDir(options.agentDir, options.parentSessionId);
	const sessionId = stableWorkerSessionId(options.parentSessionId, options.logicalAgentId);
	assertValidSessionId(sessionId);
	if (!options.cwd.trim()) throw new TypeError("A worker conversation working directory is required.");
	return {
		provider: "pi",
		sessionId,
		sessionDir,
		sessionFile: joinWorkerSessionFile(sessionDir, sessionId),
		cwd: resolve(options.cwd),
		...(options.orchestrationProfileId ? { orchestrationProfileId: options.orchestrationProfileId } : {}),
		...(options.modelRef ? { modelRef: options.modelRef } : {}),
		resourceProfileNames: [...options.resourceProfileNames],
		contextPointers: structuredClone(options.contextPointers),
	};
}

function metadataFromFile(metadataFile: string): WorkerConversationMetadata {
	let metadata: unknown;
	try {
		metadata = JSON.parse(
			readBoundedTextFileSync(
				metadataFile,
				MAX_WORKER_CONVERSATION_METADATA_BYTES,
				"Worker conversation metadata durable size bound",
			),
		);
	} catch {
		throw new Error(
			existsSync(metadataFile)
				? "Worker conversation metadata is invalid or exceeds its durable size bound."
				: "Worker conversation metadata is missing or invalid.",
		);
	}
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		throw new Error("Worker conversation metadata is invalid.");
	}
	const logicalAgentId = (metadata as { logicalAgentId?: unknown }).logicalAgentId;
	const parentSessionId = (metadata as { parentSessionId?: unknown }).parentSessionId;
	const resumeContext = (metadata as { resumeContext?: unknown }).resumeContext;
	const birthContextForkReference = (metadata as { birthContextForkReference?: unknown }).birthContextForkReference;
	const usageAccountingVersion = (metadata as { usageAccountingVersion?: unknown }).usageAccountingVersion;
	if (
		typeof logicalAgentId !== "string" ||
		!logicalAgentId.trim() ||
		(parentSessionId !== undefined &&
			(typeof parentSessionId !== "string" || !parentSessionId.trim() || parentSessionId.length > 512)) ||
		!resumeContext ||
		(birthContextForkReference !== undefined && parentSessionId === undefined) ||
		(usageAccountingVersion !== undefined && usageAccountingVersion !== 1)
	) {
		throw new Error("Worker conversation metadata is invalid.");
	}
	let normalizedBirthContextForkReference: WorkerContextForkReference | undefined;
	try {
		normalizedBirthContextForkReference =
			birthContextForkReference === undefined
				? undefined
				: normalizeWorkerContextForkReference(birthContextForkReference);
	} catch {
		throw new Error("Worker conversation metadata is invalid.");
	}
	return {
		logicalAgentId,
		...(typeof parentSessionId === "string" ? { parentSessionId } : {}),
		resumeContext: cloneResumeContext(resumeContext as AgentResumeContext),
		...(normalizedBirthContextForkReference
			? { birthContextForkReference: normalizedBirthContextForkReference }
			: {}),
		...(usageAccountingVersion === 1 ? { usageAccountingVersion } : {}),
	};
}

function assertExactConversationMetadata(
	metadataFile: string,
	expected: AgentResumeContext,
	logicalAgentId?: string,
	parentSessionId?: string,
	birthContextForkReference?: WorkerContextForkReference,
): WorkerConversationMetadata {
	const metadata = metadataFromFile(metadataFile);
	if (logicalAgentId && metadata.logicalAgentId !== logicalAgentId) {
		throw new Error("Worker conversation logical agent identity conflicts with the persisted transcript.");
	}
	if (!sameAgentResumeIdentity(metadata.resumeContext, expected)) {
		throw new Error("Worker conversation resume context conflicts with the persisted transcript.");
	}
	if (parentSessionId && metadata.parentSessionId && metadata.parentSessionId !== parentSessionId) {
		throw new Error("Worker conversation parent session identity conflicts with the persisted transcript.");
	}
	if (birthContextForkReference && !isDeepStrictEqual(metadata.birthContextForkReference, birthContextForkReference)) {
		throw new Error("Worker conversation birth context reference conflicts with the persisted transcript.");
	}
	return metadata;
}

function writeWorkerConversationMetadata(metadataFile: string, metadata: WorkerConversationMetadata): void {
	writeFileAtomicSync(metadataFile, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
}

function openWorkerBirthContext(
	agentDir: string,
	parentSessionId: string,
	logicalAgentId: string,
	reference: WorkerContextForkReference,
): WorkerContextForkSnapshot {
	return new WorkerContextForkStore({ agentDir, parentSessionId }).open({ logicalAgentId, reference });
}

/**
 * Verify the immutable message prefix and optionally close only the safe append-prefix crash window.
 * A partial prefix may contain no custom/compaction/attempt state: birth messages must land first.
 */
function verifyWorkerBirthContextPrefix(
	sessionManager: SessionManager,
	snapshot: WorkerContextForkSnapshot,
	recoverMissingSuffix: boolean,
): void {
	const entryCount = sessionManager.getEntryCount();
	const sharedLength = Math.min(entryCount, snapshot.messages.length);
	let divergenceIndex: number | undefined;
	visitWorkerSessionEntries(sessionManager, 0, sharedLength, (entry, index) => {
		if (divergenceIndex !== undefined) return;
		if (
			entry.type !== "message" ||
			(entry.message.role !== "user" && entry.message.role !== "assistant") ||
			!isDeepStrictEqual(
				workerMessageForPersistence(entry.message),
				workerMessageForPersistence(snapshot.messages[index]!),
			)
		) {
			divergenceIndex = index;
		}
	});
	if (divergenceIndex !== undefined) {
		throw new Error(`Worker conversation birth context diverges at message ${divergenceIndex}.`);
	}
	if (entryCount >= snapshot.messages.length) return;
	if (!recoverMissingSuffix) {
		throw new Error("Worker conversation birth context prefix is incomplete; reopen through ensure for recovery.");
	}
	for (const message of snapshot.messages.slice(entryCount)) {
		sessionManager.appendMessage(structuredClone(workerMessageForPersistence(message)));
	}
}

function assertAttemptUsageId(attemptId: string): string {
	const normalized = attemptId.trim();
	if (!normalized || normalized.length > MAX_WORKER_CLAIM_TERMINAL_ATTEMPT_ID_CHARS) {
		throw new TypeError("Worker usage-boundary attempt id is invalid or exceeds its durable bound.");
	}
	return normalized;
}

interface AttemptUsageBoundaryIndex {
	sessionId: string;
	sessionFile?: string;
	scannedEntryCount: number;
	orderedIndices: number[];
	indicesByAttemptId: Map<string, number[]>;
}

const attemptUsageBoundaryIndices = new WeakMap<SessionManager, AttemptUsageBoundaryIndex>();

function attemptUsageBoundaryId(entry: Readonly<WorkerSessionEntry>): string | undefined {
	if (entry.type !== "custom" || entry.customType !== WORKER_ATTEMPT_USAGE_BOUNDARY_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(data, "attemptId");
	if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return undefined;
	return descriptor.value;
}

function firstIndexAtOrAfter(indices: readonly number[], startIndex: number): number {
	let low = 0;
	let high = indices.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (indices[middle]! < startIndex) low = middle + 1;
		else high = middle;
	}
	return indices[low] ?? -1;
}

/** Sole parser/index owner for durable attempt-usage boundary entries. */
function attemptUsageBoundaryIndex(
	sessionManager: SessionManager,
	attemptId: string | undefined,
	startIndex = 0,
): number {
	const entryCount = sessionManager.getEntryCount();
	let index = attemptUsageBoundaryIndices.get(sessionManager);
	if (
		!index ||
		index.sessionId !== sessionManager.getSessionId() ||
		index.sessionFile !== sessionManager.getSessionFile() ||
		index.scannedEntryCount > entryCount
	) {
		index = {
			sessionId: sessionManager.getSessionId(),
			...(sessionManager.getSessionFile() ? { sessionFile: sessionManager.getSessionFile() } : {}),
			scannedEntryCount: 0,
			orderedIndices: [],
			indicesByAttemptId: new Map(),
		};
		attemptUsageBoundaryIndices.set(sessionManager, index);
	}
	if (index.scannedEntryCount < entryCount) {
		visitWorkerSessionEntries(sessionManager, index.scannedEntryCount, entryCount, (entry, entryIndex) => {
			const boundaryAttemptId = attemptUsageBoundaryId(entry);
			if (!boundaryAttemptId) return;
			index.orderedIndices.push(entryIndex);
			const attemptIndices = index.indicesByAttemptId.get(boundaryAttemptId);
			if (attemptIndices) attemptIndices.push(entryIndex);
			else index.indicesByAttemptId.set(boundaryAttemptId, [entryIndex]);
		});
		index.scannedEntryCount = entryCount;
	}
	return firstIndexAtOrAfter(
		attemptId === undefined ? index.orderedIndices : (index.indicesByAttemptId.get(attemptId) ?? []),
		startIndex,
	);
}

function exactUserText(message: WorkerSessionMessage): string | undefined {
	if (!isRawWorkerTranscriptMessage(message) || message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	let text = "";
	for (const block of message.content) {
		if (block.type !== "text") return undefined;
		text += block.text;
	}
	return text;
}

function scanWorkerControlTranscript(
	sessionManager: SessionManager,
	expectations: readonly WorkerControlTranscriptExpectation[],
): Set<string> {
	const expectedById = new Map<string, string>();
	for (const expectation of expectations) {
		const messageId = expectation.messageId.trim();
		if (!messageId || workerControlMessageId(expectation.content) !== messageId) {
			throw new TypeError("Worker control transcript expectation is invalid.");
		}
		const existing = expectedById.get(messageId);
		if (existing !== undefined && existing !== expectation.content) {
			throw new Error("Worker control transcript identity has conflicting expected content.");
		}
		expectedById.set(messageId, expectation.content);
	}
	const matchCounts = new Map<string, number>();
	visitWorkerSessionEntries(sessionManager, 0, sessionManager.getEntryCount(), (entry, _index, persistedBytes) => {
		if (entry.type !== "message" || entry.message.role !== "user") return;
		if (persistedBytes !== undefined) {
			for (const messageId of expectedById.keys()) {
				if (coldWorkerControlPrefixContains(sessionManager, entry.id, messageId)) {
					throw new Error("Worker control transcript identity conflicts with oversized persisted content.");
				}
			}
			return;
		}
		const content = exactUserText(entry.message);
		if (content === undefined) return;
		const messageId = workerControlMessageId(content);
		if (!messageId || !expectedById.has(messageId)) return;
		if (expectedById.get(messageId) !== content) {
			throw new Error("Worker control transcript identity conflicts with existing content.");
		}
		const count = (matchCounts.get(messageId) ?? 0) + 1;
		if (count > 1) throw new Error("Worker control transcript contains a duplicate message id.");
		matchCounts.set(messageId, count);
	});
	return new Set(matchCounts.keys());
}

function assertWorkerConversationFile(agentDir: string, sessionFile: string, sessionId: string): string {
	const workersRoot = resolve(orchestrationSessionsDir(agentDir));
	const resolvedFile = resolve(sessionFile);
	const fileRelativeToWorkersRoot = relative(workersRoot, resolvedFile);
	if (
		fileRelativeToWorkersRoot === "" ||
		fileRelativeToWorkersRoot.startsWith("..") ||
		isAbsolute(fileRelativeToWorkersRoot)
	) {
		throw new Error("Worker conversation session file must remain under the canonical worker sessions directory.");
	}
	const segments = fileRelativeToWorkersRoot.split(/[\\/]/);
	if (segments.length !== 3 || segments[1] !== "worker-conversations") {
		throw new Error("Worker conversation session file must remain under the canonical worker sessions directory.");
	}
	if (basename(resolvedFile) !== `${sessionId}.jsonl`) {
		throw new Error("Worker conversation session file does not match its durable session id.");
	}
	return resolvedFile;
}

/**
 * Durable SessionManager-backed transcript for exactly one logical worker lane.
 *
 * Single-writer invariant: orchestration must ensure that no two live processes append to the same
 * conversation. This store deliberately does not merge branches or lock competing writers; a
 * complete child transcript is committed only after it proves the current provider-visible context
 * is its exact prefix.
 */
export class WorkerConversation {
	private sessionManager: SessionManager;
	private readonly resumeContext: AgentResumeContext;
	private readonly agentDir?: string;
	private readonly metadataFile?: string;
	private readonly logicalAgentId?: string;
	private readonly parentSessionId?: string;
	private readonly birthContextForkReference?: WorkerContextForkReference;
	private usageAccountingVersion: 1 | undefined;

	constructor(
		sessionManager: SessionManager,
		resumeContext: AgentResumeContext,
		metadata?: {
			file: string;
			agentDir: string;
			logicalAgentId: string;
			parentSessionId?: string;
			birthContextForkReference?: WorkerContextForkReference;
			usageAccountingVersion?: 1;
		},
	) {
		this.sessionManager = sessionManager;
		this.resumeContext = cloneResumeContext(resumeContext);
		this.agentDir = metadata?.agentDir;
		this.metadataFile = metadata?.file;
		this.logicalAgentId = metadata?.logicalAgentId;
		this.parentSessionId = metadata?.parentSessionId;
		this.birthContextForkReference = metadata?.birthContextForkReference
			? structuredClone(metadata.birthContextForkReference)
			: undefined;
		// Direct in-memory construction has no legacy metadata to preserve.
		this.usageAccountingVersion = metadata ? metadata.usageAccountingVersion : 1;
	}

	/** Immutable parent-context identity installed before this logical worker's first attempt. */
	getBirthContextForkReference(): WorkerContextForkReference | undefined {
		return this.birthContextForkReference ? structuredClone(this.birthContextForkReference) : undefined;
	}

	/** Resolve current provider-visible messages lazily through SessionManager. */
	getProviderContext(): SessionContext {
		return this.sessionManager.buildSessionContext();
	}

	/** Convert the current compacted projection at its transcript owner, never at each consumer. */
	getProviderMessages(): Message[] {
		return convertToLlm(this.getProviderContext().messages);
	}

	/** True when provider context is a compacted projection rather than the raw transcript prefix. */
	hasProviderCompaction(): boolean {
		return this.sessionManager.getBranch().some((entry) => entry.type === "compaction");
	}

	/**
	 * The immutable, append-only raw worker messages, including messages compacted out of provider
	 * context. This is recovery/audit data; it is never loaded into a provider request implicitly.
	 */
	getRawTranscript(): Message[] {
		const messages: Message[] = [];
		visitWorkerSessionEntries(this.sessionManager, 0, this.sessionManager.getEntryCount(), (entry) => {
			const message = rawWorkerTranscriptMessage(entry);
			if (message) messages.push(structuredClone(message));
		});
		return messages;
	}

	/**
	 * Read one bounded raw-transcript page without materializing the complete session entry list.
	 * A message larger than the complete page ceiling is consumed as an omission so every valid
	 * non-terminal cursor advances. The opaque cursor is a raw-entry offset, so each entry is visited
	 * at most once across a complete pagination pass and a page may contain no transcript messages.
	 * `serializedBytes` measures the returned `messages` JSON array.
	 */
	getRawTranscriptPage(options: WorkerConversationTranscriptPageOptions = {}): WorkerConversationTranscriptPage {
		const cursor = options.cursor ?? 0;
		const maxMessages = options.maxMessages ?? MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES;
		const maxBytes = options.maxBytes ?? MAX_WORKER_TRANSCRIPT_PAGE_BYTES;
		if (!Number.isSafeInteger(cursor) || cursor < 0) {
			throw new TypeError("Worker transcript cursor must be a non-negative safe integer.");
		}
		if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES) {
			throw new TypeError(
				`Worker transcript page message count must be from 1 through ${MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES}.`,
			);
		}
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > MAX_WORKER_TRANSCRIPT_PAGE_BYTES) {
			throw new TypeError(
				`Worker transcript page byte ceiling must be from 2 through ${MAX_WORKER_TRANSCRIPT_PAGE_BYTES}.`,
			);
		}

		const messages: Message[] = [];
		let consumedMessages = 0;
		let omittedMessages = 0;
		let serializedBytes = 2;
		let pageClosed = false;
		const singleMessageByteLimit = maxBytes - 2;
		const entryCount = this.sessionManager.getEntryCount();
		if (cursor > entryCount) {
			throw new TypeError("Worker transcript cursor exceeds the durable transcript length.");
		}
		let nextEntryCursor = cursor;
		if (cursor < entryCount) {
			const visitedThrough = this.sessionManager.visitEntries(
				cursor,
				Math.min(MAX_SESSION_ENTRY_VISIT_COUNT, entryCount - cursor),
				(entry, entryIndex, persistedBytes) => {
					if (pageClosed) return;
					const message = rawWorkerTranscriptMessage(entry);
					if (!message) {
						nextEntryCursor = entryIndex + 1;
						return;
					}
					if (consumedMessages >= maxMessages) {
						pageClosed = true;
						return;
					}

					if (
						(persistedBytes !== undefined && persistedBytes > singleMessageByteLimit) ||
						boundedJsonBytes(message, singleMessageByteLimit) > singleMessageByteLimit
					) {
						consumedMessages += 1;
						omittedMessages += 1;
						nextEntryCursor = entryIndex + 1;
						return;
					}

					let clonedMessage: Message;
					let messageBytes: number;
					try {
						clonedMessage = structuredClone(message);
						const serializedMessage = JSON.stringify(clonedMessage);
						messageBytes = Buffer.byteLength(serializedMessage, "utf8");
					} catch {
						consumedMessages += 1;
						omittedMessages += 1;
						nextEntryCursor = entryIndex + 1;
						return;
					}
					if (messageBytes > singleMessageByteLimit) {
						consumedMessages += 1;
						omittedMessages += 1;
						nextEntryCursor = entryIndex + 1;
						return;
					}
					const separatorBytes = messages.length > 0 ? 1 : 0;
					if (serializedBytes + separatorBytes + messageBytes > maxBytes) {
						pageClosed = true;
						return;
					}
					messages.push(clonedMessage);
					serializedBytes += separatorBytes + messageBytes;
					consumedMessages += 1;
					nextEntryCursor = entryIndex + 1;
				},
			);
			if (!pageClosed) nextEntryCursor = visitedThrough;
		}
		return {
			cursor,
			messages,
			nextCursor: nextEntryCursor < entryCount ? nextEntryCursor : undefined,
			omittedMessages,
			serializedBytes,
		};
	}

	/** Last durable provider message owned by one attempt, never an earlier persistent-worker turn. */
	getLastAttemptMessage(attemptId: string): Message | undefined {
		const normalizedAttemptId = assertAttemptUsageId(attemptId);
		const boundaryIndex = attemptUsageBoundaryIndex(this.sessionManager, normalizedAttemptId);
		if (boundaryIndex < 0) {
			if (this.usageAccountingVersion === 1) return undefined;
			const legacyLast = this.getProviderMessages().at(-1);
			return legacyLast ? structuredClone(legacyLast) : undefined;
		}
		const nextBoundaryIndex = attemptUsageBoundaryIndex(this.sessionManager, undefined, boundaryIndex + 1);
		const lastAttemptEntry = nextBoundaryIndex >= 0 ? nextBoundaryIndex : this.sessionManager.getEntryCount();
		let lastMessage: Message | undefined;
		visitWorkerSessionEntries(this.sessionManager, boundaryIndex + 1, lastAttemptEntry, (entry) => {
			if (entry.type !== "message") return;
			if (
				entry.message.role !== "user" &&
				entry.message.role !== "assistant" &&
				entry.message.role !== "toolResult"
			) {
				return;
			}
			lastMessage = structuredClone(entry.message);
		});
		return lastMessage;
	}

	/** Durable host-observed mutation progress. Custom entries never enter provider context. */
	recordChangedFile(attemptId: string, filePath: string): void {
		if (!attemptId.trim() || attemptId.length > MAX_WORKER_CLAIM_TERMINAL_ATTEMPT_ID_CHARS) {
			throw new TypeError("Worker changed-file progress attempt id is invalid or exceeds its durable bound.");
		}
		const candidate = collectBoundedWorkerClaimChangedFiles([filePath]);
		if (candidate.overflowed || candidate.values.length !== 1) {
			throw new TypeError("Worker changed-file progress path is invalid or exceeds its durable bound.");
		}
		const path = candidate.values[0]!;
		const existing = this.getChangedFiles(attemptId);
		if (existing.includes(path)) return;
		if (existing.length >= MAX_WORKER_CLAIM_CHANGED_FILES) {
			throw new Error("Worker changed-file progress exceeds its durable entry bound.");
		}
		this.sessionManager.appendCustomEntry(WORKER_CHANGED_FILE_CUSTOM_TYPE, { attemptId, path });
	}

	/** Rehydrate the bounded mutation set across owner-session disposal and worker resume. */
	getChangedFiles(attemptId: string): string[] {
		const paths: string[] = [];
		visitWorkerSessionEntries(this.sessionManager, 0, this.sessionManager.getEntryCount(), (entry) => {
			if (entry.type !== "custom" || entry.customType !== WORKER_CHANGED_FILE_CUSTOM_TYPE) return;
			const data = entry.data;
			if (!data || typeof data !== "object" || Array.isArray(data)) return;
			const attemptDescriptor = Object.getOwnPropertyDescriptor(data, "attemptId");
			const pathDescriptor = Object.getOwnPropertyDescriptor(data, "path");
			if (
				attemptDescriptor &&
				"value" in attemptDescriptor &&
				attemptDescriptor.value === attemptId &&
				pathDescriptor &&
				"value" in pathDescriptor &&
				typeof pathDescriptor.value === "string"
			) {
				paths.push(pathDescriptor.value);
			}
		});
		return collectBoundedWorkerClaimChangedFiles(paths).values;
	}

	/**
	 * Mark the first transcript entry owned by one durable attempt. Persistent logical workers share
	 * a conversation across tasks, so recovery accounting must not replay an earlier task's spend as
	 * the new attempt's baseline. The marker is idempotent and never enters provider context.
	 */
	beginAttemptUsage(attemptId: string): void {
		const normalizedAttemptId = assertAttemptUsageId(attemptId);
		this.enableAttemptUsageBoundaries();
		if (attemptUsageBoundaryIndex(this.sessionManager, normalizedAttemptId) >= 0) return;
		this.sessionManager.appendCustomEntry(WORKER_ATTEMPT_USAGE_BOUNDARY_CUSTOM_TYPE, {
			attemptId: normalizedAttemptId,
		});
	}

	/**
	 * Persist the authoritative task prompt once inside its durable attempt boundary. The boundary,
	 * rather than provider-history length, is the idempotency owner: inherited birth messages and
	 * queued mailbox controls may already exist, while a crash after append must not duplicate the
	 * prompt on resume.
	 */
	ensureAttemptUserPrompt(attemptId: string, prompt: string): void {
		const normalizedAttemptId = assertAttemptUsageId(attemptId);
		if (!prompt.trim()) throw new TypeError("Worker attempt prompt is required.");
		this.beginAttemptUsage(normalizedAttemptId);
		const boundaryIndex = attemptUsageBoundaryIndex(this.sessionManager, normalizedAttemptId);
		if (boundaryIndex < 0) throw new Error("Worker attempt prompt boundary was not persisted.");
		const nextBoundaryIndex = attemptUsageBoundaryIndex(this.sessionManager, undefined, boundaryIndex + 1);
		const endIndex = nextBoundaryIndex < 0 ? this.sessionManager.getEntryCount() : nextBoundaryIndex;
		let matches = 0;
		visitWorkerSessionEntries(this.sessionManager, boundaryIndex + 1, endIndex, (entry) => {
			if (entry?.type === "message" && entry.message.role === "user" && exactUserText(entry.message) === prompt) {
				matches += 1;
			}
		});
		if (matches > 1) throw new Error("Worker attempt prompt appears more than once in its durable boundary.");
		if (matches === 1) return;
		this.sessionManager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
	}

	/** Whether missing attempt markers have versioned, fail-closed accounting semantics. */
	usesAttemptUsageBoundaries(): boolean {
		return this.usageAccountingVersion === 1;
	}

	/**
	 * Upgrade a legacy idle conversation before its next durable task is prepared. Persisting this
	 * evidence first closes the crash window where the task exists but its transcript marker does not.
	 */
	enableAttemptUsageBoundaries(): void {
		if (this.usageAccountingVersion === 1) return;
		const metadataFile = this.metadataFile;
		if (!metadataFile) {
			this.usageAccountingVersion = 1;
			return;
		}
		const sessionFile = this.resumeContext.sessionFile;
		if (!sessionFile) throw new Error("Worker conversation cannot version usage without a session file.");
		withFileLockSync(sessionFile, () => {
			const metadata = assertExactConversationMetadata(
				metadataFile,
				this.resumeContext,
				this.logicalAgentId,
				this.parentSessionId,
				this.birthContextForkReference,
			);
			if (metadata.usageAccountingVersion !== 1) {
				writeWorkerConversationMetadata(metadataFile, { ...metadata, usageAccountingVersion: 1 });
			}
			this.usageAccountingVersion = 1;
		});
	}

	/**
	 * Recover cumulative accounting from raw entry metadata without cloning or resolving message
	 * payloads that compaction deliberately moved out of the provider-visible working set. Attempts
	 * created before usage boundaries existed conservatively fall back to the complete transcript.
	 */
	getRawTranscriptUsage(attemptId?: string): AttemptUsageSnapshot {
		const usage: AttemptUsageSnapshot = {
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			costUsd: 0,
			activeWallClockMs: 0,
		};
		let firstUsageEntry = 0;
		let lastUsageEntry = this.sessionManager.getEntryCount();
		if (attemptId !== undefined) {
			const normalizedAttemptId = assertAttemptUsageId(attemptId);
			const boundaryIndex = attemptUsageBoundaryIndex(this.sessionManager, normalizedAttemptId);
			if (boundaryIndex >= 0) {
				firstUsageEntry = boundaryIndex + 1;
				const nextBoundaryIndex = attemptUsageBoundaryIndex(this.sessionManager, undefined, firstUsageEntry);
				if (nextBoundaryIndex >= 0) lastUsageEntry = nextBoundaryIndex;
			} else if (this.usageAccountingVersion === 1) firstUsageEntry = lastUsageEntry;
		}
		visitWorkerSessionEntries(this.sessionManager, firstUsageEntry, lastUsageEntry, (entry) => {
			if (entry.type === "compaction" && entry.usage) {
				usage.inputTokens += entry.usage.input;
				usage.outputTokens += entry.usage.output;
				usage.cacheReadTokens += entry.usage.cacheRead;
				usage.cacheWriteTokens += entry.usage.cacheWrite;
				usage.totalTokens += entry.usage.totalTokens;
				usage.costUsd += entry.usage.cost.total;
				return;
			}
			if (entry.type !== "message") return;
			if (entry.message.role === "toolResult") {
				usage.toolCalls += 1;
				return;
			}
			if (entry.message.role !== "assistant") return;
			usage.inputTokens += entry.message.usage.input;
			usage.outputTokens += entry.message.usage.output;
			usage.cacheReadTokens += entry.message.usage.cacheRead;
			usage.cacheWriteTokens += entry.message.usage.cacheWrite;
			usage.totalTokens += entry.message.usage.totalTokens;
			usage.costUsd += entry.message.usage.cost.total;
		});
		return validateAttemptUsageSnapshot(usage, "legacy worker transcript usage");
	}

	/**
	 * Locate a bounded set of durable mailbox delivery commits without materializing or cloning the
	 * complete raw transcript. Recovery uses this only to close the narrow crash window after a
	 * control message was appended but before its mailbox acknowledgement was persisted.
	 */
	findDeliveredWorkerControlMessageIds(expectations: readonly WorkerControlTranscriptExpectation[]): Set<string> {
		if (expectations.length === 0) return new Set();
		return this.withCanonicalSessionLock((sessionManager) =>
			scanWorkerControlTranscript(sessionManager, expectations),
		);
	}

	/**
	 * Atomically prove one exact worker-control identity and optionally append it. Reopening inside
	 * the canonical session-file lock makes two stale recovery owners serialize on the latest durable
	 * transcript instead of both observing absence and appending a duplicate.
	 */
	reconcileWorkerControlMessage(
		expectation: WorkerControlTranscriptExpectation,
		message: Message,
		appendIfMissing: boolean,
	): WorkerControlTranscriptReconciliation {
		if (message.role !== "user" || typeof message.content !== "string" || message.content !== expectation.content) {
			throw new TypeError("Worker control transcript message does not match its expectation.");
		}
		return this.withCanonicalSessionLock((sessionManager) => {
			const delivered = scanWorkerControlTranscript(sessionManager, [expectation]).has(expectation.messageId);
			if (delivered || !appendIfMissing) return { delivered, appended: false };
			sessionManager.appendMessage(structuredClone(workerMessageForPersistence(message)));
			return { delivered: true, appended: true };
		});
	}

	/**
	 * Append one shared-compaction checkpoint when the current provider-visible context exceeds the
	 * explicit worker policy. The source transcript remains append-only; only the projection sent to
	 * the next provider call changes. The method is idempotent while no new messages are appended.
	 */
	async compactProviderContext(
		policy: WorkerConversationRetentionPolicy,
		signal?: AbortSignal,
	): Promise<WorkerConversationRetentionOutcome> {
		assertRetentionPolicy(policy);
		signal?.throwIfAborted();
		const before = this.getProviderContext();
		const beforeUsage = estimateContextTokens(before.messages);
		if (beforeUsage.tokens <= policy.maxContextTokens) {
			return { status: "within_limit", context: before, contextUsage: beforeUsage };
		}

		const preparation = prepareCompaction(this.sessionManager.getBranch(), {
			enabled: true,
			// The store does not choose a model or invoke a provider. This is only the shared cut-point
			// input required by deterministic fallback; a controller-provided verified generator owns
			// the model-specific reserve and retry policy.
			reserveTokens: Math.max(1, Math.floor(policy.maxContextTokens / 4)),
			keepRecentTokens: policy.keepRecentTokens,
			triggerPercent: 0,
		});
		if (!preparation) {
			return { status: "cannot_compact", context: before, contextUsage: beforeUsage };
		}

		let result: CompactionResult;
		let status: WorkerConversationRetentionOutcome["status"] = "compacted_deterministic";
		if (policy.generateVerifiedCompaction) {
			try {
				const verified = await policy.generateVerifiedCompaction(preparation);
				signal?.throwIfAborted();
				assertApplicableCompactionResult(verified, preparation);
				result = verified;
				status = "compacted_verified";
			} catch {
				// Cancellation/suspension transfers transcript ownership. The retiring owner must
				// not append a fallback after its execution fence has been released.
				signal?.throwIfAborted();
				const failedUsage = policy.getFailedCompactionUsage?.();
				result = {
					...createDeterministicCompaction(preparation),
					...(failedUsage ? { usage: structuredClone(failedUsage) } : {}),
				};
			}
		} else {
			result = createDeterministicCompaction(preparation);
		}

		signal?.throwIfAborted();
		this.sessionManager.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			false,
			result.usage,
		);
		const context = this.getProviderContext();
		return { status, context, contextUsage: estimateContextTokens(context.messages) };
	}

	/** Append one already-authorized worker message to the canonical transcript. */
	appendMessage(message: Message): string {
		return this.sessionManager.appendMessage(structuredClone(workerMessageForPersistence(message)));
	}

	private withCanonicalSessionLock<Result>(operation: (sessionManager: SessionManager) => Result): Result {
		const sessionFile = this.resumeContext.sessionFile;
		if (!sessionFile) return operation(this.sessionManager);
		const agentDir = this.agentDir;
		if (!agentDir) {
			throw new Error("Worker conversation cannot lock a persisted transcript without its agent directory.");
		}
		return withFileLockSync(sessionFile, () => {
			const sessionDir = this.resumeContext.sessionDir ?? dirname(sessionFile);
			const sessionManager = SessionManager.open(sessionFile, agentDir, sessionDir);
			if (
				sessionManager.getSessionId() !== this.resumeContext.sessionId ||
				sessionManager.getCwd() !== resolve(this.resumeContext.cwd)
			) {
				throw new Error("Worker conversation changed identity while acquiring its transcript lock.");
			}
			this.sessionManager = sessionManager;
			return operation(sessionManager);
		});
	}

	/**
	 * Commit one complete child-owned transcript without replaying its persisted prefix.
	 *
	 * Any mismatch is a divergence: appending would duplicate or reorder provider context, so the
	 * caller must resolve it rather than silently branching this logical worker conversation.
	 */
	commitTranscript(transcript: readonly Message[]): number {
		return this.withCanonicalSessionLock((sessionManager) => {
			// Compare against the append-only source transcript, not the provider projection: once a
			// compaction checkpoint exists, buildSessionContext() begins with its synthetic summary and is
			// intentionally no longer an exact prefix of the child loop's raw message sequence.
			let persistedMessages = 0;
			let divergenceIndex: number | undefined;
			visitWorkerSessionEntries(sessionManager, 0, sessionManager.getEntryCount(), (entry) => {
				if (divergenceIndex !== undefined) return;
				const persisted = rawWorkerTranscriptMessage(entry);
				if (!persisted) return;
				const candidate = transcript[persistedMessages];
				if (!candidate) {
					divergenceIndex = persistedMessages;
					return;
				}
				if (!isDeepStrictEqual(workerMessageForPersistence(persisted), workerMessageForPersistence(candidate))) {
					divergenceIndex = persistedMessages;
				}
				persistedMessages += 1;
			});
			if (divergenceIndex !== undefined) {
				if (divergenceIndex >= transcript.length) {
					throw new Error("Worker conversation transcript is shorter than its persisted raw context.");
				}
				throw new Error(
					`Worker conversation transcript diverges from persisted context at message ${divergenceIndex}.`,
				);
			}
			for (let index = persistedMessages; index < transcript.length; index += 1) {
				sessionManager.appendMessage(structuredClone(workerMessageForPersistence(transcript[index]!)));
			}
			return transcript.length - persistedMessages;
		});
	}

	/** Return an isolated copy suitable for durable orchestration/process-resume state. */
	getResumeContext(): AgentResumeContext {
		return cloneResumeContext(this.resumeContext);
	}
}

function assertRetentionPolicy(policy: WorkerConversationRetentionPolicy): void {
	if (!Number.isSafeInteger(policy.maxContextTokens) || policy.maxContextTokens < 2) {
		throw new TypeError("Worker conversation maximum context tokens must be an integer of at least 2.");
	}
	if (
		!Number.isSafeInteger(policy.keepRecentTokens) ||
		policy.keepRecentTokens < 1 ||
		policy.keepRecentTokens >= policy.maxContextTokens
	) {
		throw new TypeError("Worker conversation retained context tokens must be an integer below the maximum.");
	}
}

function assertApplicableCompactionResult(result: CompactionResult, preparation: CompactionPreparation): void {
	if (
		!result ||
		typeof result.summary !== "string" ||
		result.firstKeptEntryId !== preparation.firstKeptEntryId ||
		result.tokensBefore !== preparation.tokensBefore
	) {
		throw new Error("Worker verified compaction result does not match the prepared durable transcript.");
	}
}

/** Creates and reopens canonical SessionManager transcripts for logical Pi worker lanes. */
export class WorkerConversationStore {
	create(options: CreateWorkerConversationOptions): WorkerConversation {
		const resumeContext = expectedResumeContext(options);
		const sessionFile = resumeContext.sessionFile!;
		return withFileLockSync(sessionFile, () => this.createLocked(options, resumeContext));
	}

	private createLocked(
		options: CreateWorkerConversationOptions,
		resumeContext: AgentResumeContext,
	): WorkerConversation {
		const sessionDir = resumeContext.sessionDir!;
		const sessionFile = resumeContext.sessionFile!;
		const metadataFile = workerConversationMetadataFile(sessionFile);
		if (existsSync(sessionFile)) {
			throw new Error(`Worker conversation already exists for logical agent '${options.logicalAgentId}'.`);
		}
		if (options.birthContextForkReference) {
			// Validate the content-addressed snapshot before publishing either conversation file.
			openWorkerBirthContext(
				options.agentDir,
				options.parentSessionId,
				options.logicalAgentId,
				options.birthContextForkReference,
			);
		}

		// SessionManager intentionally defers a brand-new header until its first assistant message.
		// A worker must be resumable after its first user/tool message, so atomically seed the exact
		// SessionManager header and immediately reopen it through SessionManager for all later writes.
		const seed = SessionManager.create(resumeContext.cwd, options.agentDir, sessionDir, {
			id: resumeContext.sessionId,
		});
		const header = seed.getHeader();
		if (!header) throw new Error("Unable to create a worker conversation session header.");
		if (existsSync(metadataFile)) {
			const metadata = assertExactConversationMetadata(
				metadataFile,
				resumeContext,
				options.logicalAgentId,
				options.parentSessionId,
			);
			if (
				options.birthContextForkReference &&
				metadata.birthContextForkReference &&
				!isDeepStrictEqual(options.birthContextForkReference, metadata.birthContextForkReference)
			) {
				throw new Error("Worker conversation birth context reference conflicts with the persisted transcript.");
			}
			const reference = options.birthContextForkReference ?? metadata.birthContextForkReference;
			if (reference) {
				openWorkerBirthContext(options.agentDir, options.parentSessionId, options.logicalAgentId, reference);
			}
			writeWorkerConversationMetadata(metadataFile, {
				...metadata,
				parentSessionId: options.parentSessionId,
				...(reference ? { birthContextForkReference: reference } : {}),
				usageAccountingVersion: 1,
			});
		} else {
			// Metadata lands first: a crash leaves no visible conversation until the ordinary session
			// header is atomically published, while a later ensure can validate the exact intended identity.
			writeWorkerConversationMetadata(metadataFile, {
				logicalAgentId: options.logicalAgentId,
				parentSessionId: options.parentSessionId,
				resumeContext,
				...(options.birthContextForkReference
					? { birthContextForkReference: options.birthContextForkReference }
					: {}),
				usageAccountingVersion: 1,
			});
		}
		writeFileAtomicSync(sessionFile, `${JSON.stringify(header)}\n`);

		return this.openExisting(
			{
				agentDir: options.agentDir,
				resumeContext,
				expectedLogicalAgentId: options.logicalAgentId,
			},
			{
				parentSessionId: options.parentSessionId,
				birthContextForkReference: options.birthContextForkReference,
				recoverBirthContextPrefix: true,
			},
		);
	}

	/** Open the one canonical transcript or atomically create it with the exact same durable identity. */
	ensure(options: CreateWorkerConversationOptions): WorkerConversation {
		const resumeContext = expectedResumeContext(options);
		const sessionFile = resumeContext.sessionFile!;
		return withFileLockSync(sessionFile, () => {
			if (!existsSync(sessionFile)) return this.createLocked(options, resumeContext);
			return this.openExisting(
				{
					agentDir: options.agentDir,
					resumeContext,
					expectedLogicalAgentId: options.logicalAgentId,
				},
				{
					parentSessionId: options.parentSessionId,
					birthContextForkReference: options.birthContextForkReference,
					recoverBirthContextPrefix: true,
				},
			);
		});
	}

	open(options: OpenWorkerConversationOptions): WorkerConversation {
		return this.openExisting(options, { recoverBirthContextPrefix: false });
	}

	private openExisting(
		options: OpenWorkerConversationOptions,
		birthContext: {
			parentSessionId?: string;
			birthContextForkReference?: WorkerContextForkReference;
			recoverBirthContextPrefix: boolean;
		},
	): WorkerConversation {
		const context = cloneResumeContext(options.resumeContext);
		if (context.provider !== "pi") throw new TypeError("Only Pi worker conversations can be reopened.");
		if (!context.sessionFile)
			throw new TypeError("A persisted worker session file is required to reopen a conversation.");
		if (!context.cwd.trim()) throw new TypeError("A worker conversation working directory is required.");
		assertValidSessionId(context.sessionId);

		const sessionFile = assertWorkerConversationFile(options.agentDir, context.sessionFile, context.sessionId);
		if (!existsSync(sessionFile)) throw new Error(`Worker conversation session file does not exist: ${sessionFile}`);
		const sessionDir = dirname(sessionFile);
		if (context.sessionDir && resolve(context.sessionDir) !== sessionDir) {
			throw new Error(
				"Worker conversation resume context has a session directory that disagrees with its session file.",
			);
		}

		const sessionManager = SessionManager.open(sessionFile, options.agentDir, sessionDir);
		if (sessionManager.getSessionId() !== context.sessionId) {
			throw new Error("Worker conversation session file does not contain the requested durable session id.");
		}
		if (sessionManager.getCwd() !== resolve(context.cwd)) {
			throw new Error("Worker conversation resume context working directory disagrees with the persisted session.");
		}
		const metadataFile = workerConversationMetadataFile(sessionFile);
		let metadata = assertExactConversationMetadata(
			metadataFile,
			context,
			options.expectedLogicalAgentId,
			birthContext.parentSessionId,
		);
		const expectedReference = birthContext.birthContextForkReference;
		const expectedParentSessionId = birthContext.parentSessionId ?? metadata.parentSessionId;
		if (expectedReference && !expectedParentSessionId) {
			throw new Error("Worker conversation birth context parent session is missing.");
		}
		const expectedSnapshot =
			expectedReference && expectedParentSessionId
				? openWorkerBirthContext(
						options.agentDir,
						expectedParentSessionId,
						metadata.logicalAgentId,
						expectedReference,
					)
				: undefined;
		if (expectedReference) {
			if (metadata.birthContextForkReference) {
				if (!isDeepStrictEqual(metadata.birthContextForkReference, expectedReference)) {
					throw new Error("Worker conversation birth context reference conflicts with the persisted transcript.");
				}
			} else {
				if (!birthContext.recoverBirthContextPrefix || sessionManager.getEntryCount() > 0) {
					throw new Error("Worker conversation cannot bind birth context after transcript use.");
				}
				const parentSessionId = birthContext.parentSessionId;
				if (!parentSessionId) throw new Error("Worker conversation birth context parent session is missing.");
				metadata = {
					...metadata,
					parentSessionId,
					birthContextForkReference: expectedReference,
				};
				// Bind identity before the first prefix entry. A crash can only leave an exact suffix to recover.
				writeWorkerConversationMetadata(metadataFile, metadata);
			}
		}
		const reference = metadata.birthContextForkReference;
		if (reference) {
			const parentSessionId = metadata.parentSessionId;
			if (!parentSessionId) throw new Error("Worker conversation birth context parent session is missing.");
			const snapshot =
				expectedSnapshot && isDeepStrictEqual(reference, expectedReference)
					? expectedSnapshot
					: openWorkerBirthContext(options.agentDir, parentSessionId, metadata.logicalAgentId, reference);
			verifyWorkerBirthContextPrefix(sessionManager, snapshot, birthContext.recoverBirthContextPrefix);
		}

		return new WorkerConversation(
			sessionManager,
			{
				...context,
				sessionDir,
				sessionFile,
				cwd: sessionManager.getCwd(),
			},
			{
				file: metadataFile,
				agentDir: options.agentDir,
				logicalAgentId: metadata.logicalAgentId,
				...(metadata.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
				...(metadata.birthContextForkReference
					? { birthContextForkReference: metadata.birthContextForkReference }
					: {}),
				...(metadata.usageAccountingVersion ? { usageAccountingVersion: metadata.usageAccountingVersion } : {}),
			},
		);
	}
}

function joinWorkerSessionFile(sessionDir: string, sessionId: string): string {
	return resolve(sessionDir, `${sessionId}.jsonl`);
}

function workerConversationMetadataFile(sessionFile: string): string {
	return `${sessionFile}.worker.json`;
}
