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
import {
	type CustomMessage,
	convertToLlm,
	isCoreConversationMessageRole,
	isWireNativeAgentMessageRole,
} from "@caupulican/pi-agent-core/messages";
import { measureJsonStringUtf8Bytes } from "@caupulican/pi-agent-core/provider-request-estimator";
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
import {
	advanceWorkerSessionHeadAfterOwnedAppend,
	readWorkerConversationFileRevision,
	sameWorkerConversationFileRevision,
	scanWorkerSessionFile,
	type WorkerConversationFileRevision,
	WorkerConversationOwnershipError,
	type WorkerSessionFileHead,
} from "./worker-conversation-revision.ts";

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

interface WorkerConversationMetadataState {
	logicalAgentId: string;
	parentSessionId?: string;
	birthContextForkReference?: WorkerContextForkReference;
	usageAccountingVersion?: 1;
}

interface WorkerConversationMetadataBinding extends WorkerConversationMetadataState {
	file: string;
	agentDir: string;
}

interface WorkerConversationCore {
	sessionManager: SessionManager;
	head?: WorkerSessionFileHead;
	metadataRevision?: WorkerConversationFileRevision;
	metadataState?: WorkerConversationMetadataState;
	invalid: boolean;
	generation: number;
	activeTranscriptCursors: number;
}

export interface WorkerTranscriptCommitCursor {
	readonly kind: "worker-transcript-suffix-v1";
}

interface WorkerTranscriptCommitCursorState {
	core: WorkerConversationCore;
	entryIndex: number;
	generation: number;
	status: "active" | "committed" | "aborted";
	committedSuffix?: WorkerTranscriptMessage[];
}

const workerTranscriptCommitCursorStates = new WeakMap<
	WorkerTranscriptCommitCursor,
	WorkerTranscriptCommitCursorState
>();

interface CachedWorkerConversationCore {
	core: WorkerConversationCore;
	resumeContext: AgentResumeContext;
	metadataFile: string;
	agentDir: string;
}

type WorkerSessionEntry = ReturnType<SessionManager["getEntries"]>[number];
type WorkerSessionMessage = Extract<WorkerSessionEntry, { type: "message" }>["message"];

/**
 * A worker transcript entry that is genuine conversation content: either an already wire-native
 * `Message`, or a durable custom transient record (packages/agent's transient-records.ts - the
 * tool-failure ledger, a verification obligation) that still needs `convertToLlm`'s conversion
 * before it can reach a provider but is nonetheless real, persisted conversation history. See
 * `isCoreConversationMessageRole`'s doc comment (packages/agent/src/messages.ts) for the full
 * reasoning on why these, and only these, are the roles a worker transcript can legitimately hold.
 */
export type WorkerTranscriptMessage = Message | CustomMessage;

function isRawWorkerTranscriptMessage(message: WorkerSessionMessage): message is WorkerTranscriptMessage {
	return isCoreConversationMessageRole(message.role);
}

function rawWorkerTranscriptMessage(entry: Readonly<WorkerSessionEntry>): WorkerTranscriptMessage | undefined {
	if (entry.type !== "message" || !isRawWorkerTranscriptMessage(entry.message)) return undefined;
	return entry.message;
}

/** Object-level wrapper around `isWireNativeAgentMessageRole` (packages/agent) so a role check on
 * `message.role` narrows `message` itself - a role-only predicate applied to a property access does
 * not automatically narrow its parent object. Delegates to the same canonical, exhaustively-checked
 * logic; adds no role list of its own. */
function isWireNativeWorkerTranscriptMessage(message: WorkerTranscriptMessage): message is Message {
	return isWireNativeAgentMessageRole(message.role);
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

function assertLinearWorkerSession(sessionManager: SessionManager): void {
	const ids = new Set<string>();
	let previousId: string | null = null;
	visitWorkerSessionEntries(sessionManager, 0, sessionManager.getEntryCount(), (entry) => {
		if (
			typeof entry.id !== "string" ||
			!entry.id ||
			entry.id.length > 128 ||
			ids.has(entry.id) ||
			entry.parentId !== previousId
		) {
			throw new WorkerConversationOwnershipError("Worker conversation entries are not one linear chain.");
		}
		ids.add(entry.id);
		previousId = entry.id;
	});
}

function assertWorkerConversationOpenRevision(
	file: string,
	expectedRevision: WorkerConversationFileRevision,
	errorMessage: string,
): void {
	if (!sameWorkerConversationFileRevision(expectedRevision, readWorkerConversationFileRevision(file))) {
		throw new WorkerConversationOwnershipError(errorMessage);
	}
}

function assertWorkerSessionHeadContent(
	expected: WorkerSessionFileHead,
	actual: WorkerSessionFileHead,
	errorMessage: string,
): void {
	if (
		expected.revision.dev !== actual.revision.dev ||
		expected.revision.ino !== actual.revision.ino ||
		expected.headerDigest !== actual.headerDigest ||
		expected.entryDigest !== actual.entryDigest ||
		expected.entryCount !== actual.entryCount
	) {
		throw new WorkerConversationOwnershipError(errorMessage);
	}
}

function workerControlMessageId(content: string): string | undefined {
	return /^\[Worker control (worker-message-[^\]\s]+)(?: [^\]]+)?\]\n/.exec(content)?.[1];
}

function coldWorkerControlPrefixContains(sessionManager: SessionManager, entryId: string, messageId: string): boolean {
	const rawPrefix = sessionManager.readEntryJsonPrefix(entryId, MAX_WORKER_CONTROL_ENTRY_PREFIX_BYTES);
	return rawPrefix?.includes(`"role":"user","content":"[Worker control ${messageId}`) ?? false;
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
				if (!add(measureJsonStringUtf8Bytes(item, limit - bytes))) return limit + 1;
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
			if (!add(measureJsonStringUtf8Bytes(key, limit - bytes) + 1)) return limit + 1;
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
function workerMessageForPersistence(message: WorkerTranscriptMessage): WorkerTranscriptMessage {
	let projected: WorkerTranscriptMessage = message;
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
	const persisted = JSON.parse(serialized) as WorkerTranscriptMessage;
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

interface WorkerConversationMetadataRead {
	metadata: WorkerConversationMetadata;
	content: string;
}

function readWorkerConversationMetadata(metadataFile: string): WorkerConversationMetadataRead {
	let content: string;
	let metadata: unknown;
	try {
		content = readBoundedTextFileSync(
			metadataFile,
			MAX_WORKER_CONVERSATION_METADATA_BYTES,
			"Worker conversation metadata durable size bound",
		);
		metadata = JSON.parse(content);
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
		content,
		metadata: {
			logicalAgentId,
			...(typeof parentSessionId === "string" ? { parentSessionId } : {}),
			resumeContext: cloneResumeContext(resumeContext as AgentResumeContext),
			...(normalizedBirthContextForkReference
				? { birthContextForkReference: normalizedBirthContextForkReference }
				: {}),
			...(usageAccountingVersion === 1 ? { usageAccountingVersion } : {}),
		},
	};
}

function cloneWorkerConversationMetadataState(
	metadata: WorkerConversationMetadataState,
): WorkerConversationMetadataState {
	return {
		logicalAgentId: metadata.logicalAgentId,
		...(metadata.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
		...(metadata.birthContextForkReference
			? { birthContextForkReference: structuredClone(metadata.birthContextForkReference) }
			: {}),
		...(metadata.usageAccountingVersion ? { usageAccountingVersion: metadata.usageAccountingVersion } : {}),
	};
}

function bindWorkerConversationMetadata(
	file: string,
	agentDir: string,
	state: WorkerConversationMetadataState,
): WorkerConversationMetadataBinding {
	return { file, agentDir, ...cloneWorkerConversationMetadataState(state) };
}

function assertCachedWorkerConversationMetadata(
	previous: WorkerConversationMetadataState,
	next: WorkerConversationMetadataState,
): void {
	if (next.logicalAgentId !== previous.logicalAgentId) {
		throw new Error("Worker conversation logical agent identity conflicts with the persisted transcript.");
	}
	if (next.parentSessionId !== previous.parentSessionId) {
		throw new Error("Worker conversation parent session identity conflicts with the persisted transcript.");
	}
	if (!isDeepStrictEqual(next.birthContextForkReference, previous.birthContextForkReference)) {
		throw new Error("Worker conversation birth context reference conflicts with the persisted transcript.");
	}
	assertWorkerConversationUsageAccountingVersion(previous.usageAccountingVersion, next.usageAccountingVersion);
}

function assertWorkerConversationUsageAccountingVersion(previous: 1 | undefined, next: 1 | undefined): void {
	if (previous === 1 && next !== 1) {
		throw new Error("Worker conversation usage accounting version cannot be downgraded.");
	}
}

function assertExactConversationMetadataValue(
	metadata: WorkerConversationMetadata,
	expected: AgentResumeContext,
	logicalAgentId?: string,
	parentSessionId?: string,
	birthContextForkReference?: WorkerContextForkReference,
): WorkerConversationMetadata {
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

function assertExactConversationMetadata(
	metadataFile: string,
	expected: AgentResumeContext,
	logicalAgentId?: string,
	parentSessionId?: string,
	birthContextForkReference?: WorkerContextForkReference,
): WorkerConversationMetadata {
	return assertExactConversationMetadataValue(
		readWorkerConversationMetadata(metadataFile).metadata,
		expected,
		logicalAgentId,
		parentSessionId,
		birthContextForkReference,
	);
}

function assertStableExactConversationMetadata(
	metadataFile: string,
	expected: AgentResumeContext,
	logicalAgentId?: string,
	parentSessionId?: string,
	birthContextForkReference?: WorkerContextForkReference,
): {
	metadata: WorkerConversationMetadata;
	revision: WorkerConversationFileRevision;
	content: string;
} {
	const before = existsSync(metadataFile) ? readWorkerConversationFileRevision(metadataFile) : undefined;
	const first = readWorkerConversationMetadata(metadataFile);
	const between = readWorkerConversationFileRevision(metadataFile);
	const second = readWorkerConversationMetadata(metadataFile);
	const revision = readWorkerConversationFileRevision(metadataFile);
	if (
		!before ||
		!sameWorkerConversationFileRevision(before, between) ||
		!sameWorkerConversationFileRevision(between, revision) ||
		first.content !== second.content
	) {
		throw new WorkerConversationOwnershipError("Worker conversation metadata changed while it was verified.");
	}
	const metadata = assertExactConversationMetadataValue(
		first.metadata,
		expected,
		logicalAgentId,
		parentSessionId,
		birthContextForkReference,
	);
	return { metadata, revision, content: first.content };
}

function assertWorkerConversationMetadataContent(
	metadataFile: string,
	expectedRevision: WorkerConversationFileRevision,
	expectedContent: string,
	errorMessage: string,
): void {
	try {
		const before = readWorkerConversationFileRevision(metadataFile);
		const content = readBoundedTextFileSync(
			metadataFile,
			MAX_WORKER_CONVERSATION_METADATA_BYTES,
			"Worker conversation metadata durable size bound",
		);
		const after = readWorkerConversationFileRevision(metadataFile);
		if (
			!sameWorkerConversationFileRevision(expectedRevision, before) ||
			!sameWorkerConversationFileRevision(before, after) ||
			content !== expectedContent
		) {
			throw new WorkerConversationOwnershipError(errorMessage);
		}
	} catch (error) {
		if (error instanceof WorkerConversationOwnershipError) throw error;
		throw new WorkerConversationOwnershipError(errorMessage);
	}
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
): boolean {
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
	if (entryCount >= snapshot.messages.length) return false;
	if (!recoverMissingSuffix) {
		throw new Error("Worker conversation birth context prefix is incomplete; reopen through ensure for recovery.");
	}
	for (const message of snapshot.messages.slice(entryCount)) {
		sessionManager.appendMessage(structuredClone(workerMessageForPersistence(message)));
	}
	return true;
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
 * The canonical session-file lock plus a raw-byte revision head fences competing processes. One
 * store shares the parsed core across lightweight resume-context views; unexpected durable changes
 * fail closed for active owners and only strict append-only recovery may replace the core.
 */
export class WorkerConversation {
	private readonly core: WorkerConversationCore;
	private readonly resumeContext: AgentResumeContext;
	private readonly agentDir?: string;
	private readonly metadataFile?: string;

	constructor(
		sessionManager: SessionManager,
		resumeContext: AgentResumeContext,
		metadata?: WorkerConversationMetadataBinding,
		sharedCore?: WorkerConversationCore,
	) {
		this.core = sharedCore ?? {
			sessionManager,
			...(metadata ? { metadataState: cloneWorkerConversationMetadataState(metadata) } : {}),
			invalid: false,
			generation: 0,
			activeTranscriptCursors: 0,
		};
		this.resumeContext = cloneResumeContext(resumeContext);
		this.agentDir = metadata?.agentDir;
		this.metadataFile = metadata?.file;
	}

	private get sessionManager(): SessionManager {
		return this.core.sessionManager;
	}

	private set sessionManager(sessionManager: SessionManager) {
		this.core.sessionManager = sessionManager;
	}

	/** Persisted conversations share one adopted metadata state; direct in-memory instances are current. */
	private get usageAccountingVersion(): 1 | undefined {
		return this.metadataFile ? this.core.metadataState?.usageAccountingVersion : 1;
	}

	/** Immutable parent-context identity installed before this logical worker's first attempt. */
	getBirthContextForkReference(): WorkerContextForkReference | undefined {
		const reference = this.core.metadataState?.birthContextForkReference;
		return reference ? structuredClone(reference) : undefined;
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
	 *
	 * Deliberately scoped to wire-native `Message` content only, unlike `commitTranscript`'s
	 * reconciliation (which must recognize a durable custom transient record - see
	 * `WorkerTranscriptMessage` - to avoid the off-by-one this type-narrowing caused there). A
	 * committed transient record is still real conversation history, but this method's own public
	 * `Message[]` contract has external callers outside this module (`getRawTranscriptPage` below,
	 * via `WorkerAgentControlPort`) that were never built to receive anything else; changing that
	 * contract is a separate, wider decision this fix does not make. `isWireNativeAgentMessageRole`
	 * filters explicitly here rather than relying on `rawWorkerTranscriptMessage`'s return type to
	 * narrow it away, so the exclusion is a visible, deliberate choice, not an accident of typing.
	 */
	getRawTranscript(): Message[] {
		const messages: Message[] = [];
		visitWorkerSessionEntries(this.sessionManager, 0, this.sessionManager.getEntryCount(), (entry) => {
			const message = rawWorkerTranscriptMessage(entry);
			if (message && isWireNativeWorkerTranscriptMessage(message)) messages.push(structuredClone(message));
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
					// Same deliberate wire-native-only scope as getRawTranscript above - see its doc comment.
					if (!message || !isWireNativeWorkerTranscriptMessage(message)) {
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
		if (this.usageAccountingVersion === 1) this.beginAttemptUsage(attemptId);
		const existing = this.getChangedFiles(attemptId);
		if (existing.includes(path)) return;
		if (existing.length >= MAX_WORKER_CLAIM_CHANGED_FILES) {
			throw new Error("Worker changed-file progress exceeds its durable entry bound.");
		}
		this.appendSessionEntry((sessionManager) =>
			sessionManager.appendCustomEntry(WORKER_CHANGED_FILE_CUSTOM_TYPE, { attemptId, path }),
		);
	}

	/** Rehydrate the bounded mutation set across owner-session disposal and worker resume. */
	getChangedFiles(attemptId: string): string[] {
		let firstEntry = 0;
		let lastEntry = this.sessionManager.getEntryCount();
		if (this.usageAccountingVersion === 1) {
			const boundaryIndex = attemptUsageBoundaryIndex(this.sessionManager, assertAttemptUsageId(attemptId));
			if (boundaryIndex < 0) return [];
			firstEntry = boundaryIndex + 1;
			const nextBoundaryIndex = attemptUsageBoundaryIndex(this.sessionManager, undefined, firstEntry);
			if (nextBoundaryIndex >= 0) lastEntry = nextBoundaryIndex;
		}
		const paths: string[] = [];
		visitWorkerSessionEntries(this.sessionManager, firstEntry, lastEntry, (entry) => {
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
		this.appendSessionEntry((sessionManager) =>
			sessionManager.appendCustomEntry(WORKER_ATTEMPT_USAGE_BOUNDARY_CUSTOM_TYPE, {
				attemptId: normalizedAttemptId,
			}),
		);
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
		this.appendSessionEntry((sessionManager) =>
			sessionManager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() }),
		);
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
		if (!metadataFile) return;
		const sessionFile = this.resumeContext.sessionFile;
		if (!sessionFile) throw new Error("Worker conversation cannot version usage without a session file.");
		withFileLockSync(sessionFile, () => {
			this.synchronizeCoreLocked(false);
			const currentMetadataState = this.core.metadataState;
			let metadata = assertExactConversationMetadata(
				metadataFile,
				this.resumeContext,
				currentMetadataState?.logicalAgentId,
				currentMetadataState?.parentSessionId,
				currentMetadataState?.birthContextForkReference,
			);
			if (metadata.usageAccountingVersion !== 1) {
				metadata = { ...metadata, usageAccountingVersion: 1 };
				writeWorkerConversationMetadata(metadataFile, metadata);
			}
			const metadataState = cloneWorkerConversationMetadataState(metadata);
			const metadataRevision = readWorkerConversationFileRevision(metadataFile);
			this.core.metadataState = metadataState;
			this.core.metadataRevision = metadataRevision;
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
		return this.withCanonicalSessionLock(
			(sessionManager) => scanWorkerControlTranscript(sessionManager, expectations),
			true,
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
			this.appendSessionEntryLocked(sessionManager, (owner) =>
				owner.appendMessage(structuredClone(workerMessageForPersistence(message))),
			);
			return { delivered: true, appended: true };
		}, true);
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
		const preparationEntryCount = this.withCanonicalSessionLock((sessionManager) => sessionManager.getEntryCount());
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
		this.appendSessionEntry((sessionManager) => {
			if (sessionManager.getEntryCount() !== preparationEntryCount) {
				throw new WorkerConversationOwnershipError(
					"Worker conversation changed while its compaction checkpoint was generated.",
				);
			}
			return sessionManager.appendCompaction(
				result.summary,
				result.firstKeptEntryId,
				result.tokensBefore,
				result.details,
				false,
				result.usage,
			);
		});
		const context = this.getProviderContext();
		return { status, context, contextUsage: estimateContextTokens(context.messages) };
	}

	/** Append one already-authorized worker message to the canonical transcript. */
	appendMessage(message: WorkerTranscriptMessage): string {
		return this.appendSessionEntry((sessionManager) =>
			sessionManager.appendMessage(structuredClone(workerMessageForPersistence(message))),
		);
	}

	private appendSessionEntry(operation: (sessionManager: SessionManager) => string): string {
		return this.withCanonicalSessionLock((sessionManager) =>
			this.appendSessionEntryLocked(sessionManager, operation),
		);
	}

	private appendSessionEntryLocked(
		sessionManager: SessionManager,
		operation: (sessionManager: SessionManager) => string,
	): string {
		const beforeCount = sessionManager.getEntryCount();
		let entryId: string;
		try {
			entryId = operation(sessionManager);
		} catch (error) {
			this.core.invalid = true;
			throw error;
		}
		if (sessionManager.getEntryCount() !== beforeCount + 1) {
			this.core.invalid = true;
			throw new WorkerConversationOwnershipError("Worker conversation append did not advance exactly one entry.");
		}
		const head = this.core.head;
		if (!head) return entryId;
		const entry = sessionManager.getEntry(entryId);
		if (!entry) {
			this.core.invalid = true;
			throw new WorkerConversationOwnershipError("Worker conversation appended entry is unavailable.");
		}
		const serialized = JSON.stringify(entry);
		try {
			this.core.head = advanceWorkerSessionHeadAfterOwnedAppend(this.resumeContext.sessionFile!, head, serialized);
		} catch (error) {
			this.core.invalid = true;
			throw error;
		}
		if (entry.type === "message") {
			try {
				sessionManager.releasePersistedMessagePayload(entryId);
			} catch (error) {
				this.core.invalid = true;
				throw error;
			}
		}
		this.core.invalid = false;
		return entryId;
	}

	private reopenVerifiedSessionManagerLocked(
		expectedEntryCount: number,
		failure: "recovery state" | "appended suffix",
	): SessionManager {
		const sessionFile = this.resumeContext.sessionFile!;
		const sessionDir = this.resumeContext.sessionDir ?? dirname(sessionFile);
		const sessionManager = SessionManager.open(sessionFile, this.agentDir!, sessionDir);
		if (
			sessionManager.getSessionId() !== this.resumeContext.sessionId ||
			sessionManager.getCwd() !== resolve(this.resumeContext.cwd) ||
			sessionManager.getEntryCount() !== expectedEntryCount
		) {
			throw new WorkerConversationOwnershipError(`Worker conversation ${failure} is invalid.`);
		}
		assertLinearWorkerSession(sessionManager);
		return sessionManager;
	}

	private synchronizeCoreLocked(allowExternalAppend: boolean): void {
		const sessionFile = this.resumeContext.sessionFile;
		if (!sessionFile) return;
		if (this.metadataFile && this.core.metadataRevision) {
			const metadataRevision = readWorkerConversationFileRevision(this.metadataFile);
			if (!sameWorkerConversationFileRevision(this.core.metadataRevision, metadataRevision)) {
				throw new WorkerConversationOwnershipError("Worker conversation metadata changed under a different owner.");
			}
		}
		const currentRevision = readWorkerConversationFileRevision(sessionFile);
		const head = this.core.head;
		if (!this.core.invalid && head && sameWorkerConversationFileRevision(head.revision, currentRevision)) return;
		const scanned = scanWorkerSessionFile(
			sessionFile,
			this.resumeContext.sessionId,
			this.resumeContext.cwd,
			head?.entryCount,
		);
		if (!head) {
			if (scanned.entryCount !== this.sessionManager.getEntryCount()) {
				throw new WorkerConversationOwnershipError("Worker conversation session entries are invalid.");
			}
			this.core.head = scanned;
			this.core.invalid = false;
			return;
		}
		if (scanned.revision.dev !== head.revision.dev || scanned.revision.ino !== head.revision.ino) {
			throw new WorkerConversationOwnershipError("Worker conversation file identity changed.");
		}
		if (
			scanned.headerDigest !== head.headerDigest ||
			scanned.entryCount < head.entryCount ||
			scanned.prefixDigest !== head.entryDigest
		) {
			throw new WorkerConversationOwnershipError("Worker conversation durable prefix changed.");
		}
		if (scanned.entryCount === head.entryCount) {
			if (scanned.entryDigest !== head.entryDigest) {
				throw new WorkerConversationOwnershipError("Worker conversation durable content changed.");
			}
			if (this.core.invalid || this.sessionManager.getEntryCount() !== scanned.entryCount) {
				this.sessionManager = this.reopenVerifiedSessionManagerLocked(scanned.entryCount, "recovery state");
				this.core.generation += 1;
			}
			this.core.head = scanned;
			this.core.invalid = false;
			return;
		}
		if (!allowExternalAppend) {
			throw new WorkerConversationOwnershipError("Worker conversation advanced under a different owner.");
		}
		if (this.core.activeTranscriptCursors > 0) {
			throw new WorkerConversationOwnershipError(
				"Worker conversation advanced while a transcript commit was active.",
			);
		}
		this.sessionManager = this.reopenVerifiedSessionManagerLocked(scanned.entryCount, "appended suffix");
		this.core.head = scanned;
		this.core.invalid = false;
		this.core.generation += 1;
	}

	/** Store-only refresh while the canonical session-file lock is already held. */
	refreshCachedCoreLocked(): void {
		this.synchronizeCoreLocked(true);
	}

	private captureTranscriptCommitCursorLocked(sessionManager: SessionManager): WorkerTranscriptCommitCursor {
		const cursor: WorkerTranscriptCommitCursor = Object.freeze({ kind: "worker-transcript-suffix-v1" });
		workerTranscriptCommitCursorStates.set(cursor, {
			core: this.core,
			entryIndex: sessionManager.getEntryCount(),
			generation: this.core.generation,
			status: "active",
		});
		this.core.activeTranscriptCursors += 1;
		return cursor;
	}

	/** Atomically capture the provider projection and the raw-entry cursor that immediately follows it. */
	beginTranscriptCommit(): { history: Message[]; cursor: WorkerTranscriptCommitCursor } {
		return this.withCanonicalSessionLock((sessionManager) => ({
			history: convertToLlm(sessionManager.buildSessionContext().messages),
			cursor: this.captureTranscriptCommitCursorLocked(sessionManager),
		}));
	}

	private withCanonicalSessionLock<Result>(
		operation: (sessionManager: SessionManager) => Result,
		allowExternalAppend = false,
	): Result {
		const sessionFile = this.resumeContext.sessionFile;
		if (!sessionFile) return operation(this.sessionManager);
		const agentDir = this.agentDir;
		if (!agentDir) {
			throw new Error("Worker conversation cannot lock a persisted transcript without its agent directory.");
		}
		return withFileLockSync(sessionFile, () => {
			this.synchronizeCoreLocked(allowExternalAppend);
			const sessionManager = this.sessionManager;
			if (
				sessionManager.getSessionId() !== this.resumeContext.sessionId ||
				sessionManager.getCwd() !== resolve(this.resumeContext.cwd)
			) {
				throw new Error("Worker conversation changed identity while acquiring its transcript lock.");
			}
			return operation(sessionManager);
		});
	}

	/** Commit only the bounded child-loop suffix captured by an opaque raw-entry cursor. */
	captureTranscriptCommitCursor(): WorkerTranscriptCommitCursor {
		return this.withCanonicalSessionLock((sessionManager) =>
			this.captureTranscriptCommitCursorLocked(sessionManager),
		);
	}

	abortTranscriptCommit(cursor: WorkerTranscriptCommitCursor): void {
		const state = workerTranscriptCommitCursorStates.get(cursor);
		if (!state || state.core !== this.core) {
			throw new WorkerConversationOwnershipError("Worker transcript cursor belongs to a different conversation.");
		}
		if (state.status === "active") {
			state.status = "aborted";
			this.core.activeTranscriptCursors -= 1;
		}
	}

	commitTranscript(
		cursor: WorkerTranscriptCommitCursor,
		suffix: readonly WorkerTranscriptMessage[],
		options?: { appendMissing?: boolean },
	): number {
		const state = workerTranscriptCommitCursorStates.get(cursor);
		if (!state || state.core !== this.core) {
			throw new WorkerConversationOwnershipError("Worker transcript cursor belongs to a different conversation.");
		}
		const normalizedSuffix = suffix.map((message) => workerMessageForPersistence(message));
		if (state.status === "aborted") {
			throw new WorkerConversationOwnershipError("Worker transcript cursor is no longer active.");
		}
		if (state.status === "committed") {
			if (!isDeepStrictEqual(state.committedSuffix, normalizedSuffix)) {
				throw new WorkerConversationOwnershipError(
					"Worker transcript cursor replay conflicts with its committed suffix.",
				);
			}
			return 0;
		}
		return this.withCanonicalSessionLock((sessionManager) => {
			if (state.generation !== this.core.generation) {
				throw new WorkerConversationOwnershipError(
					"Worker transcript cursor was invalidated by owner replacement.",
				);
			}
			let persistedMessages = 0;
			let divergenceIndex: number | undefined;
			visitWorkerSessionEntries(sessionManager, state.entryIndex, sessionManager.getEntryCount(), (entry) => {
				if (divergenceIndex !== undefined) return;
				const persisted = rawWorkerTranscriptMessage(entry);
				if (!persisted) return;
				const candidate = normalizedSuffix[persistedMessages];
				if (!candidate) {
					divergenceIndex = persistedMessages;
					return;
				}
				if (!isDeepStrictEqual(workerMessageForPersistence(persisted), candidate)) {
					divergenceIndex = persistedMessages;
				}
				persistedMessages += 1;
			});
			if (divergenceIndex !== undefined) {
				if (divergenceIndex >= normalizedSuffix.length) {
					throw new Error("Worker conversation suffix is shorter than its persisted raw context.");
				}
				throw new Error(
					`Worker conversation suffix diverges from persisted context at message ${divergenceIndex}.`,
				);
			}
			if (options?.appendMissing === false && persistedMessages < normalizedSuffix.length) {
				throw new WorkerConversationOwnershipError(
					"Worker conversation is missing callback-persisted transcript suffix entries.",
				);
			}
			for (let index = persistedMessages; index < normalizedSuffix.length; index += 1) {
				this.appendSessionEntryLocked(sessionManager, (owner) =>
					owner.appendMessage(structuredClone(normalizedSuffix[index]!)),
				);
			}
			state.status = "committed";
			state.committedSuffix = structuredClone(normalizedSuffix);
			this.core.activeTranscriptCursors -= 1;
			return normalizedSuffix.length - persistedMessages;
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
	private readonly cachedCores = new Map<string, CachedWorkerConversationCore>();

	clearCache(): void {
		for (const cached of this.cachedCores.values()) {
			if (cached.core.activeTranscriptCursors > 0) {
				throw new WorkerConversationOwnershipError(
					"Worker conversation cache cannot be cleared during an active transcript commit.",
				);
			}
		}
		this.cachedCores.clear();
	}

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
		const context = options.resumeContext;
		if (context.provider !== "pi" || !context.sessionFile) {
			return this.openExisting(options, { recoverBirthContextPrefix: false });
		}
		assertValidSessionId(context.sessionId);
		const sessionFile = assertWorkerConversationFile(options.agentDir, context.sessionFile, context.sessionId);
		return withFileLockSync(sessionFile, () => this.openExisting(options, { recoverBirthContextPrefix: false }));
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

		const metadataFile = workerConversationMetadataFile(sessionFile);
		const cached = this.cachedCores.get(sessionFile);
		if (cached) {
			if (!sameAgentResumeIdentity(cached.resumeContext, context)) {
				throw new Error("Worker conversation resume context conflicts with the persisted transcript.");
			}
			let {
				metadata,
				revision: metadataRevision,
				content: metadataContent,
			} = assertStableExactConversationMetadata(
				metadataFile,
				context,
				options.expectedLogicalAgentId,
				birthContext.parentSessionId,
			);
			const previousMetadataState = cached.core.metadataState;
			if (!previousMetadataState) {
				throw new WorkerConversationOwnershipError("Worker conversation cached metadata state is missing.");
			}
			let metadataState = cloneWorkerConversationMetadataState(metadata);
			assertCachedWorkerConversationMetadata(previousMetadataState, metadataState);
			const requestedReference = birthContext.birthContextForkReference;
			let boundFirstReference = false;
			if (requestedReference && !previousMetadataState.birthContextForkReference) {
				if (cached.core.activeTranscriptCursors > 0) {
					throw new WorkerConversationOwnershipError(
						"Worker conversation birth context changed while a transcript commit was active.",
					);
				}
				const parentSessionId = birthContext.parentSessionId;
				if (!parentSessionId) throw new Error("Worker conversation birth context parent session is missing.");
				const snapshot = openWorkerBirthContext(
					options.agentDir,
					parentSessionId,
					metadataState.logicalAgentId,
					requestedReference,
				);
				if (cached.core.sessionManager.getEntryCount() > 0) {
					throw new Error("Worker conversation cannot bind birth context after transcript use.");
				}
				metadata = {
					...metadata,
					parentSessionId,
					birthContextForkReference: requestedReference,
				};
				try {
					// Bind identity before the first prefix entry. A crash leaves an exact suffix for cold recovery.
					writeWorkerConversationMetadata(metadataFile, metadata);
					const boundMetadata = assertStableExactConversationMetadata(
						metadataFile,
						context,
						metadataState.logicalAgentId,
						parentSessionId,
						requestedReference,
					);
					assertWorkerConversationUsageAccountingVersion(
						previousMetadataState.usageAccountingVersion,
						boundMetadata.metadata.usageAccountingVersion,
					);
					metadata = boundMetadata.metadata;
					metadataRevision = boundMetadata.revision;
					metadataContent = boundMetadata.content;
					verifyWorkerBirthContextPrefix(cached.core.sessionManager, snapshot, true);
					const boundHead = scanWorkerSessionFile(sessionFile, context.sessionId, context.cwd);
					if (cached.core.sessionManager.getEntryCount() !== boundHead.entryCount) {
						throw new WorkerConversationOwnershipError(
							"Worker conversation bound birth context entries are invalid.",
						);
					}
					assertLinearWorkerSession(cached.core.sessionManager);
					metadataState = cloneWorkerConversationMetadataState(metadata);
					assertWorkerConversationMetadataContent(
						metadataFile,
						metadataRevision,
						metadataContent,
						"Worker conversation metadata changed while its birth context was bound.",
					);
					cached.core.head = boundHead;
					cached.core.metadataState = metadataState;
					cached.core.metadataRevision = metadataRevision;
					cached.core.invalid = false;
					cached.core.generation += 1;
					boundFirstReference = true;
				} catch (error) {
					cached.core.invalid = true;
					this.cachedCores.delete(sessionFile);
					throw error;
				}
			}
			if (requestedReference && !isDeepStrictEqual(metadataState.birthContextForkReference, requestedReference)) {
				throw new Error("Worker conversation birth context reference conflicts with the persisted transcript.");
			}
			const revisionChanged =
				!cached.core.metadataRevision ||
				!sameWorkerConversationFileRevision(cached.core.metadataRevision, metadataRevision);
			const currentSessionRevision = readWorkerConversationFileRevision(sessionFile);
			const sessionRevisionChanged =
				!cached.core.head || !sameWorkerConversationFileRevision(cached.core.head.revision, currentSessionRevision);
			if (!revisionChanged && !boundFirstReference && !isDeepStrictEqual(previousMetadataState, metadataState)) {
				throw new WorkerConversationOwnershipError(
					"Worker conversation metadata content changed without a new durable revision.",
				);
			}
			const previousMetadataRevision = cached.core.metadataRevision;
			if (revisionChanged) {
				if (cached.core.activeTranscriptCursors > 0) {
					throw new WorkerConversationOwnershipError(
						"Worker conversation metadata changed while a transcript commit was active.",
					);
				}
			}
			if (sessionRevisionChanged && cached.core.activeTranscriptCursors > 0) {
				throw new WorkerConversationOwnershipError(
					"Worker conversation advanced while a transcript commit was active.",
				);
			}
			const reference = metadataState.birthContextForkReference;
			if ((revisionChanged || sessionRevisionChanged) && reference) {
				const parentSessionId = metadataState.parentSessionId;
				if (!parentSessionId) throw new Error("Worker conversation birth context parent session is missing.");
				const snapshot = openWorkerBirthContext(
					options.agentDir,
					parentSessionId,
					metadataState.logicalAgentId,
					reference,
				);
				const verificationManager = sessionRevisionChanged
					? SessionManager.open(sessionFile, cached.agentDir, sessionDir)
					: cached.core.sessionManager;
				const recoveredBirthSuffix = verifyWorkerBirthContextPrefix(
					verificationManager,
					snapshot,
					sessionRevisionChanged && birthContext.recoverBirthContextPrefix,
				);
				if (recoveredBirthSuffix) {
					const recoveredHead = scanWorkerSessionFile(sessionFile, context.sessionId, context.cwd);
					if (verificationManager.getEntryCount() !== recoveredHead.entryCount) {
						throw new WorkerConversationOwnershipError(
							"Worker conversation recovered birth context entries are invalid.",
						);
					}
					assertLinearWorkerSession(verificationManager);
					cached.core.sessionManager = verificationManager;
					cached.core.head = recoveredHead;
					cached.core.invalid = false;
					cached.core.generation += 1;
				}
			}
			assertWorkerConversationMetadataContent(
				metadataFile,
				metadataRevision,
				metadataContent,
				"Worker conversation metadata changed while its cached state was opened.",
			);
			if (revisionChanged) {
				cached.core.metadataState = metadataState;
				cached.core.metadataRevision = metadataRevision;
			}
			const conversation = new WorkerConversation(
				cached.core.sessionManager,
				{ ...context, sessionDir, sessionFile, cwd: cached.core.sessionManager.getCwd() },
				bindWorkerConversationMetadata(cached.metadataFile, cached.agentDir, metadataState),
				cached.core,
			);
			try {
				conversation.refreshCachedCoreLocked();
			} catch (error) {
				if (revisionChanged) {
					cached.core.metadataState = previousMetadataState;
					cached.core.metadataRevision = previousMetadataRevision;
				}
				throw error;
			}
			return conversation;
		}

		const scannedHead = scanWorkerSessionFile(sessionFile, context.sessionId, context.cwd);
		const sessionManager = SessionManager.open(sessionFile, options.agentDir, sessionDir);
		const openedHead = scanWorkerSessionFile(sessionFile, context.sessionId, context.cwd);
		assertWorkerSessionHeadContent(
			scannedHead,
			openedHead,
			"Worker conversation changed while its canonical session was opened.",
		);
		if (sessionManager.getSessionId() !== context.sessionId) {
			throw new Error("Worker conversation session file does not contain the requested durable session id.");
		}
		if (sessionManager.getCwd() !== resolve(context.cwd)) {
			throw new Error("Worker conversation resume context working directory disagrees with the persisted session.");
		}
		if (sessionManager.getEntryCount() !== openedHead.entryCount) {
			throw new WorkerConversationOwnershipError("Worker conversation session entries are invalid.");
		}
		assertLinearWorkerSession(sessionManager);
		let {
			metadata,
			revision: metadataRevision,
			content: metadataContent,
		} = assertStableExactConversationMetadata(
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
				const previousUsageAccountingVersion = metadata.usageAccountingVersion;
				metadata = {
					...metadata,
					parentSessionId,
					birthContextForkReference: expectedReference,
				};
				// Bind identity before the first prefix entry. A crash can only leave an exact suffix to recover.
				writeWorkerConversationMetadata(metadataFile, metadata);
				const boundMetadata = assertStableExactConversationMetadata(
					metadataFile,
					context,
					metadata.logicalAgentId,
					parentSessionId,
					expectedReference,
				);
				assertWorkerConversationUsageAccountingVersion(
					previousUsageAccountingVersion,
					boundMetadata.metadata.usageAccountingVersion,
				);
				metadata = boundMetadata.metadata;
				metadataRevision = boundMetadata.revision;
				metadataContent = boundMetadata.content;
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

		let currentHead: WorkerSessionFileHead;
		if (sessionManager.getEntryCount() === openedHead.entryCount) {
			assertWorkerConversationOpenRevision(
				sessionFile,
				openedHead.revision,
				"Worker conversation changed while its canonical session was opened.",
			);
			currentHead = openedHead;
		} else {
			currentHead = scanWorkerSessionFile(sessionFile, context.sessionId, context.cwd);
		}
		if (sessionManager.getEntryCount() !== currentHead.entryCount) {
			throw new WorkerConversationOwnershipError("Worker conversation session entries are invalid.");
		}
		const metadataState = cloneWorkerConversationMetadataState(metadata);
		assertWorkerConversationMetadataContent(
			metadataFile,
			metadataRevision,
			metadataContent,
			"Worker conversation metadata changed while its canonical state was opened.",
		);
		const core: WorkerConversationCore = {
			sessionManager,
			head: currentHead,
			metadataRevision,
			metadataState,
			invalid: false,
			generation: 0,
			activeTranscriptCursors: 0,
		};
		const conversation = new WorkerConversation(
			sessionManager,
			{
				...context,
				sessionDir,
				sessionFile,
				cwd: sessionManager.getCwd(),
			},
			bindWorkerConversationMetadata(metadataFile, options.agentDir, metadataState),
			core,
		);
		this.cachedCores.set(sessionFile, {
			core,
			resumeContext: cloneResumeContext(context),
			metadataFile,
			agentDir: options.agentDir,
		});
		return conversation;
	}
}

function joinWorkerSessionFile(sessionDir: string, sessionId: string): string {
	return resolve(sessionDir, `${sessionId}.jsonl`);
}

function workerConversationMetadataFile(sessionFile: string): string {
	return `${sessionFile}.worker.json`;
}
