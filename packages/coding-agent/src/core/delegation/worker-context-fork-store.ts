import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { AssistantMessage, TextContent, Usage, UserMessage } from "@caupulican/pi-ai";
import { workerContextForkFile, workerContextForksDir } from "../agent-paths.ts";
import {
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
} from "../orchestration/contracts.ts";
import {
	MAX_WORKER_CONTEXT_FORK_API_LENGTH,
	MAX_WORKER_CONTEXT_FORK_BYTES,
	MAX_WORKER_CONTEXT_FORK_MESSAGES,
	MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS,
	normalizeWorkerContextForkReference,
	WORKER_CONTEXT_FORK_REFERENCE_SCHEMA_VERSION as SCHEMA_VERSION,
	type WorkerContextForkReference,
} from "../orchestration/worker-context-fork-reference.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import { requireBoundedTrimmedText } from "../util/bounded-value.ts";
import type { SanitizedContextForkMessage } from "./sanitized-context-fork.ts";
import { DEFAULT_WORKER_FLEET_LIMITS } from "./worker-fleet-limits.ts";

const MAX_PATH_CHARS = 4096;
const MAX_FILE_BYTES = MAX_WORKER_CONTEXT_FORK_BYTES + 16 * 1024;
const MAX_DIRECTORY_ENTRIES = DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession + 32;
const SNAPSHOT_FILE_PATTERN = /^([a-f0-9]{64})-([a-f0-9]{64})\.json$/;

export const MAX_RETAINED_WORKER_CONTEXT_FORK_SNAPSHOTS = DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession;

export type WorkerContextForkStoreErrorCode =
	| "capacity_reached"
	| "identity_conflict"
	| "identity_claimed"
	| "snapshot_corrupt"
	| "snapshot_missing";

/** Stable failure classification for controller admission and recovery wiring. */
export class WorkerContextForkStoreError extends Error {
	readonly code: WorkerContextForkStoreErrorCode;

	constructor(code: WorkerContextForkStoreErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "WorkerContextForkStoreError";
		this.code = code;
	}
}

export interface WorkerContextForkSnapshot extends WorkerContextForkReference {
	parentSessionId: string;
	logicalAgentId: string;
	messages: SanitizedContextForkMessage[];
}

export interface CaptureWorkerContextForkRequest {
	/**
	 * Newly admitted persistent specialist. Follow-up tasks reuse its durable conversation and must
	 * reopen, never replace, this one birth snapshot.
	 */
	logicalAgentId: string;
	messages: readonly SanitizedContextForkMessage[];
}

export interface OpenWorkerContextForkRequest {
	logicalAgentId: string;
	reference: WorkerContextForkReference;
}

/**
 * Cross-process transaction input for the capture-before-dispatch boundary. The durable-reference
 * reader is invoked while the capture lock is held, so reclamation never relies on a stale snapshot
 * gathered before lock acquisition. `prepare` must synchronously persist or adopt the dispatch.
 */
export interface CaptureAndPrepareWorkerContextForkRequest<T> extends CaptureWorkerContextForkRequest {
	readDurableReferences: () => readonly WorkerContextForkReference[];
	/** Rechecked under the capture lock so a fresh start never adopts another caller's dispatch. */
	isLogicalIdentityClaimed?: () => boolean;
	prepare: (reference: WorkerContextForkReference) => T;
}

export interface CaptureAndPrepareWorkerContextForkResult<T> {
	reference: WorkerContextForkReference;
	value: T;
}

interface NormalizedMessages {
	messages: SanitizedContextForkMessage[];
	serialized: string;
	byteLength: number;
}

interface PreparedWorkerContextForkCapture {
	logicalAgentId: string;
	normalized: NormalizedMessages;
	reference: WorkerContextForkReference;
	targetFile: string;
	targetName: string;
	serialized: string;
}

interface LockedCaptureResult {
	reference: WorkerContextForkReference;
	created: boolean;
}

class DurableWorkerContextForkReferenceIndex {
	private readonly keysByIdentity = new Map<string, Set<string>>();

	constructor(value: unknown) {
		if (!Array.isArray(value)) throw new TypeError("Durable worker context fork references must be an array.");
		for (const candidate of value as readonly unknown[]) {
			const reference = normalizeWorkerContextForkReference(candidate);
			const keys = this.keysByIdentity.get(reference.identityDigest) ?? new Set<string>();
			keys.add(referenceKey(reference));
			this.keysByIdentity.set(reference.identityDigest, keys);
		}
	}

	hasIdentity(identityDigest: string): boolean {
		return this.keysByIdentity.has(identityDigest);
	}

	hasConflictingIdentity(reference: WorkerContextForkReference): boolean {
		const keys = this.keysByIdentity.get(reference.identityDigest);
		return keys !== undefined && (keys.size !== 1 || !keys.has(referenceKey(reference)));
	}
}

interface PersistedWorkerContextFork {
	schemaVersion: 1;
	parentSessionId: string;
	logicalAgentId: string;
	identityDigest: string;
	contentDigest: string;
	messageCount: number;
	messageBytes: number;
	messages: SanitizedContextForkMessage[];
}

interface TextBlockCounter {
	count: number;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
	const record = value as Record<string, unknown>;
	const actualKeys = Object.keys(record);
	if (actualKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
		throw new TypeError(`${label} has an unsupported shape.`);
	}
	return record;
}

function boundedString(value: unknown, maximum: number, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new TypeError(`${label} must be non-empty and no longer than ${maximum} characters.`);
	}
	return value;
}

function safeTimestamp(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${label} must be a non-negative safe integer.`);
	}
	return value;
}

function nonNegativeFinite(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new TypeError(`${label} must be a non-negative finite number.`);
	}
	return value;
}

function nonNegativeTokenCount(value: unknown, label: string): number {
	const normalized = nonNegativeFinite(value, label);
	if (!Number.isSafeInteger(normalized)) throw new TypeError(`${label} must be a safe integer.`);
	return normalized;
}

function normalizeUsage(value: unknown): Usage {
	const usage = exactObject(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"], "Usage");
	const cost = exactObject(usage.cost, ["input", "output", "cacheRead", "cacheWrite", "total"], "Usage cost");
	return {
		input: nonNegativeTokenCount(usage.input, "Usage input"),
		output: nonNegativeTokenCount(usage.output, "Usage output"),
		cacheRead: nonNegativeTokenCount(usage.cacheRead, "Usage cache read"),
		cacheWrite: nonNegativeTokenCount(usage.cacheWrite, "Usage cache write"),
		totalTokens: nonNegativeTokenCount(usage.totalTokens, "Usage total tokens"),
		cost: {
			input: nonNegativeFinite(cost.input, "Usage input cost"),
			output: nonNegativeFinite(cost.output, "Usage output cost"),
			cacheRead: nonNegativeFinite(cost.cacheRead, "Usage cache-read cost"),
			cacheWrite: nonNegativeFinite(cost.cacheWrite, "Usage cache-write cost"),
			total: nonNegativeFinite(cost.total, "Usage total cost"),
		},
	};
}

function normalizeTextBlock(value: unknown, counter: TextBlockCounter): TextContent {
	if (counter.count >= MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS) {
		throw new TypeError(
			`A worker context fork may contain at most ${MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS} text blocks.`,
		);
	}
	const block = exactObject(value, ["type", "text"], "Worker context fork text block");
	if (block.type !== "text") throw new TypeError("Worker context forks may contain text blocks only.");
	const text = boundedString(block.text, MAX_WORKER_CONTEXT_FORK_BYTES, "Worker context fork text");
	counter.count += 1;
	return { type: "text", text };
}

function normalizeUserMessage(value: unknown, counter: TextBlockCounter): UserMessage {
	const message = exactObject(value, ["role", "content", "timestamp"], "Worker context fork user message");
	if (message.role !== "user") throw new TypeError("Worker context fork user role is invalid.");
	let content: UserMessage["content"];
	if (typeof message.content === "string") {
		content = boundedString(message.content, MAX_WORKER_CONTEXT_FORK_BYTES, "Worker context fork user content");
		counter.count += 1;
		if (counter.count > MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS) {
			throw new TypeError(
				`A worker context fork may contain at most ${MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS} text blocks.`,
			);
		}
	} else {
		if (!Array.isArray(message.content) || message.content.length === 0) {
			throw new TypeError("Worker context fork user content must contain text.");
		}
		content = message.content.map((block) => normalizeTextBlock(block, counter));
	}
	return { role: "user", content, timestamp: safeTimestamp(message.timestamp, "User timestamp") };
}

function normalizeAssistantMessage(value: unknown, counter: TextBlockCounter): AssistantMessage {
	const message = exactObject(
		value,
		["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"],
		"Worker context fork assistant message",
	);
	if (message.role !== "assistant") throw new TypeError("Worker context fork assistant role is invalid.");
	if (!Array.isArray(message.content) || message.content.length === 0) {
		throw new TypeError("Worker context fork assistant content must contain text.");
	}
	if (message.stopReason !== "stop") {
		throw new TypeError("Worker context forks may contain complete assistant messages only.");
	}
	return {
		role: "assistant",
		content: message.content.map((block) => normalizeTextBlock(block, counter)),
		api: boundedString(message.api, MAX_WORKER_CONTEXT_FORK_API_LENGTH, "Assistant API"),
		provider: boundedString(message.provider, MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH, "Assistant provider"),
		model: boundedString(message.model, MAX_ORCHESTRATION_MODEL_ID_LENGTH, "Assistant model"),
		usage: normalizeUsage(message.usage),
		stopReason: "stop",
		timestamp: safeTimestamp(message.timestamp, "Assistant timestamp"),
	};
}

function normalizeMessages(value: unknown): NormalizedMessages {
	if (!Array.isArray(value) || value.length > MAX_WORKER_CONTEXT_FORK_MESSAGES) {
		throw new TypeError(`A worker context fork may contain at most ${MAX_WORKER_CONTEXT_FORK_MESSAGES} messages.`);
	}
	const messages: SanitizedContextForkMessage[] = [];
	const counter: TextBlockCounter = { count: 0 };
	let hasUser = false;
	for (const candidate of value as readonly unknown[]) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new TypeError("Worker context fork message must be an object.");
		}
		const role = Object.getOwnPropertyDescriptor(candidate, "role");
		const roleValue = role && "value" in role ? role.value : undefined;
		if (roleValue === "user") {
			messages.push(normalizeUserMessage(candidate, counter));
			hasUser = true;
			continue;
		}
		if (roleValue === "assistant") {
			if (!hasUser) throw new TypeError("A worker context fork cannot begin with an assistant message.");
			messages.push(normalizeAssistantMessage(candidate, counter));
			continue;
		}
		throw new TypeError("Worker context forks may contain user and assistant messages only.");
	}
	const serialized = JSON.stringify(messages);
	const byteLength = Buffer.byteLength(serialized, "utf-8");
	if (byteLength > MAX_WORKER_CONTEXT_FORK_BYTES) {
		throw new TypeError(`A worker context fork may contain at most ${MAX_WORKER_CONTEXT_FORK_BYTES} bytes.`);
	}
	return { messages, serialized, byteLength };
}

function sha256(domain: string, value: string): string {
	return createHash("sha256").update(domain).update("\0").update(value).digest("hex");
}

function identityDigest(parentSessionId: string, logicalAgentId: string): string {
	return sha256("pi-worker-context-fork-identity-v1", `${parentSessionId}\0${logicalAgentId}`);
}

function contentDigest(serializedMessages: string): string {
	return sha256("pi-worker-context-fork-content-v1", serializedMessages);
}

function referenceKey(reference: WorkerContextForkReference): string {
	return JSON.stringify([
		reference.schemaVersion,
		reference.identityDigest,
		reference.contentDigest,
		reference.messageCount,
		reference.messageBytes,
	]);
}

function canonicalEnvelope(
	parentSessionId: string,
	logicalAgentId: string,
	reference: WorkerContextForkReference,
	messages: SanitizedContextForkMessage[],
): PersistedWorkerContextFork {
	return {
		schemaVersion: SCHEMA_VERSION,
		parentSessionId,
		logicalAgentId,
		identityDigest: reference.identityDigest,
		contentDigest: reference.contentDigest,
		messageCount: reference.messageCount,
		messageBytes: reference.messageBytes,
		messages,
	};
}

function serializeEnvelope(envelope: PersistedWorkerContextFork): string {
	const serialized = `${JSON.stringify(envelope)}\n`;
	if (Buffer.byteLength(serialized, "utf-8") > MAX_FILE_BYTES) {
		throw new TypeError("Worker context fork snapshot exceeds its durable byte limit.");
	}
	return serialized;
}

function persistedIdentity(value: unknown, label: string): string {
	if (typeof value !== "string") throw new TypeError(`${label} is invalid.`);
	const normalized = requireBoundedTrimmedText(value, MAX_ORCHESTRATION_IDENTIFIER_LENGTH, label);
	if (normalized !== value) throw new TypeError(`${label} is not canonical.`);
	return normalized;
}

function parseEnvelope(
	raw: string,
	expectedParentSessionId: string,
	expectedLogicalAgentId: string,
	expectedReference?: WorkerContextForkReference,
): WorkerContextForkSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new WorkerContextForkStoreError(
			"snapshot_corrupt",
			"Worker context fork snapshot is not valid JSON.",
			error,
		);
	}
	try {
		const envelope = exactObject(
			parsed,
			[
				"schemaVersion",
				"parentSessionId",
				"logicalAgentId",
				"identityDigest",
				"contentDigest",
				"messageCount",
				"messageBytes",
				"messages",
			],
			"Worker context fork snapshot",
		);
		if (envelope.schemaVersion !== SCHEMA_VERSION) {
			throw new TypeError("Worker context fork snapshot schema is unsupported.");
		}
		const parentSessionId = persistedIdentity(envelope.parentSessionId, "Snapshot parent session id");
		const logicalAgentId = persistedIdentity(envelope.logicalAgentId, "Snapshot logical agent id");
		if (parentSessionId !== expectedParentSessionId || logicalAgentId !== expectedLogicalAgentId) {
			throw new WorkerContextForkStoreError(
				"identity_conflict",
				"Worker context fork snapshot identity conflicts with the requested logical agent.",
			);
		}
		const messages = normalizeMessages(envelope.messages);
		const actualReference: WorkerContextForkReference = {
			schemaVersion: SCHEMA_VERSION,
			identityDigest: identityDigest(parentSessionId, logicalAgentId),
			contentDigest: contentDigest(messages.serialized),
			messageCount: messages.messages.length,
			messageBytes: messages.byteLength,
		};
		if (
			envelope.identityDigest !== actualReference.identityDigest ||
			envelope.contentDigest !== actualReference.contentDigest ||
			envelope.messageCount !== actualReference.messageCount ||
			envelope.messageBytes !== actualReference.messageBytes ||
			(expectedReference !== undefined &&
				(expectedReference.identityDigest !== actualReference.identityDigest ||
					expectedReference.contentDigest !== actualReference.contentDigest ||
					expectedReference.messageCount !== actualReference.messageCount ||
					expectedReference.messageBytes !== actualReference.messageBytes))
		) {
			throw new TypeError("Worker context fork snapshot digest or bounds metadata is invalid.");
		}
		const canonical = canonicalEnvelope(parentSessionId, logicalAgentId, actualReference, messages.messages);
		if (raw !== serializeEnvelope(canonical)) {
			throw new TypeError("Worker context fork snapshot is not in canonical form.");
		}
		return { ...actualReference, parentSessionId, logicalAgentId, messages: messages.messages };
	} catch (error) {
		if (error instanceof WorkerContextForkStoreError) throw error;
		throw new WorkerContextForkStoreError(
			"snapshot_corrupt",
			"Worker context fork snapshot failed schema, digest, or bounds validation.",
			error,
		);
	}
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(error, "code");
	return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}

/**
 * Immutable, per-session store for the exact sanitized message snapshot inherited by a new logical
 * worker. Capture is synchronous so the caller can commit the snapshot before admitting dispatch.
 * Identity is deliberately `(parentSessionId, logicalAgentId)`: persistent-agent follow-up tasks
 * continue the existing transcript and cannot install a second birth context.
 */
export class WorkerContextForkStore {
	private readonly agentDir: string;
	private readonly parentSessionId: string;
	private readonly directory: string;
	private readonly lockFile: string;

	constructor(options: { agentDir: string; parentSessionId: string }) {
		this.agentDir = requireBoundedTrimmedText(options.agentDir, MAX_PATH_CHARS, "Agent directory");
		this.parentSessionId = requireBoundedTrimmedText(
			options.parentSessionId,
			MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
			"Parent session id",
		);
		this.directory = workerContextForksDir(this.agentDir, this.parentSessionId);
		this.lockFile = join(this.directory, "capture-index");
	}

	capture(request: CaptureWorkerContextForkRequest): WorkerContextForkReference {
		const prepared = this.prepareCapture(request);
		return withFileLockSync(this.lockFile, () => this.captureLocked(prepared).reference);
	}

	/**
	 * Hold the capture lock across orphan classification, capture, and synchronous durable prepare.
	 * A callback failure removes only a file created by this invocation, and only after a refreshed
	 * lifecycle reference read still proves the logical identity unbound. A process crash can leave
	 * an orphan, which the next transaction may reclaim under the same proof and lock.
	 */
	captureAndPrepare<T>(
		request: CaptureAndPrepareWorkerContextForkRequest<T>,
	): CaptureAndPrepareWorkerContextForkResult<T> {
		const prepared = this.prepareCapture(request);
		return withFileLockSync(this.lockFile, () => {
			if (request.isLogicalIdentityClaimed?.()) {
				throw new WorkerContextForkStoreError(
					"identity_claimed",
					"Logical worker context identity already owns a durable attempt.",
				);
			}
			const referenced = new DurableWorkerContextForkReferenceIndex(request.readDurableReferences());
			const captured = this.captureLocked(prepared, referenced);
			try {
				const value = request.prepare(structuredClone(captured.reference));
				return { reference: structuredClone(captured.reference), value };
			} catch (error) {
				if (captured.created) this.rollbackCreatedSnapshot(prepared, request.readDurableReferences);
				throw error;
			}
		});
	}

	open(request: OpenWorkerContextForkRequest): WorkerContextForkSnapshot {
		const logicalAgentId = requireBoundedTrimmedText(
			request.logicalAgentId,
			MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
			"Logical agent id",
		);
		let reference: WorkerContextForkReference;
		try {
			reference = normalizeWorkerContextForkReference(request.reference);
		} catch (error) {
			throw new WorkerContextForkStoreError(
				"snapshot_corrupt",
				"Worker context fork reference failed schema or bounds validation.",
				error,
			);
		}
		if (reference.identityDigest !== identityDigest(this.parentSessionId, logicalAgentId)) {
			throw new WorkerContextForkStoreError(
				"identity_conflict",
				"Worker context fork reference conflicts with the requested logical agent.",
			);
		}
		const filePath = workerContextForkFile(
			this.agentDir,
			this.parentSessionId,
			reference.identityDigest,
			reference.contentDigest,
		);
		return this.readSnapshot(filePath, logicalAgentId, reference);
	}

	private prepareCapture(request: CaptureWorkerContextForkRequest): PreparedWorkerContextForkCapture {
		const logicalAgentId = requireBoundedTrimmedText(
			request.logicalAgentId,
			MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
			"Logical agent id",
		);
		const normalized = normalizeMessages(request.messages);
		const reference: WorkerContextForkReference = {
			schemaVersion: SCHEMA_VERSION,
			identityDigest: identityDigest(this.parentSessionId, logicalAgentId),
			contentDigest: contentDigest(normalized.serialized),
			messageCount: normalized.messages.length,
			messageBytes: normalized.byteLength,
		};
		const targetFile = workerContextForkFile(
			this.agentDir,
			this.parentSessionId,
			reference.identityDigest,
			reference.contentDigest,
		);
		const targetName = basename(targetFile);
		const serialized = serializeEnvelope(
			canonicalEnvelope(this.parentSessionId, logicalAgentId, reference, normalized.messages),
		);
		return { logicalAgentId, normalized, reference, targetFile, targetName, serialized };
	}

	private captureLocked(
		prepared: PreparedWorkerContextForkCapture,
		referenced?: DurableWorkerContextForkReferenceIndex,
	): LockedCaptureResult {
		let names: string[];
		try {
			names = readBoundedDirectoryNamesSync(
				this.directory,
				MAX_DIRECTORY_ENTRIES,
				"Worker context fork snapshot directory",
			);
		} catch (error) {
			throw new WorkerContextForkStoreError(
				"capacity_reached",
				"Worker context fork snapshot directory exceeds its bounded retention capacity.",
				error,
			);
		}
		const snapshotNames = names.filter((name) => SNAPSHOT_FILE_PATTERN.test(name));
		const identityPrefix = `${prepared.reference.identityDigest}-`;
		const identityMatches = snapshotNames.filter((name) => name.startsWith(identityPrefix));
		if (identityMatches.length > 1) {
			throw new WorkerContextForkStoreError(
				"identity_conflict",
				"Logical worker context identity has multiple durable snapshots.",
			);
		}

		const existingName = identityMatches[0];
		if (existingName === prepared.targetName) {
			if (referenced?.hasConflictingIdentity(prepared.reference)) {
				throw new WorkerContextForkStoreError(
					"identity_conflict",
					"Logical worker context identity conflicts with its durable lifecycle reference.",
				);
			}
			const existing = this.readSnapshot(prepared.targetFile, prepared.logicalAgentId, prepared.reference);
			if (JSON.stringify(existing.messages) !== prepared.normalized.serialized) {
				throw new WorkerContextForkStoreError(
					"identity_conflict",
					"Logical worker context identity is bound to different snapshot content.",
				);
			}
			return { reference: prepared.reference, created: false };
		}

		let retainedSnapshotCount = snapshotNames.length;
		if (existingName !== undefined) {
			if (!referenced || referenced.hasIdentity(prepared.reference.identityDigest)) {
				throw new WorkerContextForkStoreError(
					"identity_conflict",
					"Logical worker context identity is already bound to a different snapshot.",
				);
			}
			const existingFile = join(this.directory, existingName);
			const existing = this.readSnapshot(existingFile, prepared.logicalAgentId);
			const canonicalExistingName = `${existing.identityDigest}-${existing.contentDigest}.json`;
			if (existingName !== canonicalExistingName) {
				throw new WorkerContextForkStoreError(
					"snapshot_corrupt",
					"Worker context fork snapshot filename conflicts with its canonical content.",
				);
			}
			unlinkSync(existingFile);
			retainedSnapshotCount -= 1;
		} else if (referenced?.hasIdentity(prepared.reference.identityDigest)) {
			throw new WorkerContextForkStoreError(
				"identity_conflict",
				"Logical worker context identity has a durable reference but no exact snapshot replay.",
			);
		}

		if (retainedSnapshotCount >= MAX_RETAINED_WORKER_CONTEXT_FORK_SNAPSHOTS) {
			throw new WorkerContextForkStoreError(
				"capacity_reached",
				`Worker context fork retention is capped at ${MAX_RETAINED_WORKER_CONTEXT_FORK_SNAPSHOTS} snapshots.`,
			);
		}
		writeFileAtomicSync(prepared.targetFile, prepared.serialized, { mode: 0o600 });
		this.readSnapshot(prepared.targetFile, prepared.logicalAgentId, prepared.reference);
		return { reference: prepared.reference, created: true };
	}

	private rollbackCreatedSnapshot(
		prepared: PreparedWorkerContextForkCapture,
		readDurableReferences: () => readonly WorkerContextForkReference[],
	): void {
		try {
			const refreshed = new DurableWorkerContextForkReferenceIndex(readDurableReferences());
			if (refreshed.hasIdentity(prepared.reference.identityDigest)) return;
			unlinkSync(prepared.targetFile);
		} catch {
			// Preserve the snapshot on an ambiguous refresh or cleanup failure. The next locked
			// transaction can reclassify it from a fresh durable lifecycle projection.
		}
	}

	private readSnapshot(
		filePath: string,
		logicalAgentId: string,
		reference?: WorkerContextForkReference,
	): WorkerContextForkSnapshot {
		let raw: string;
		try {
			raw = readBoundedTextFileSync(filePath, MAX_FILE_BYTES, "Worker context fork snapshot");
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				throw new WorkerContextForkStoreError(
					"snapshot_missing",
					"Worker context fork snapshot is missing.",
					error,
				);
			}
			throw new WorkerContextForkStoreError(
				"snapshot_corrupt",
				"Worker context fork snapshot cannot be read within its durable bounds.",
				error,
			);
		}
		return parseEnvelope(raw, this.parentSessionId, logicalAgentId, reference);
	}
}
