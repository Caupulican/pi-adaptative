import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { convertToLlm } from "@caupulican/pi-agent-core";
import {
	assertValidSessionId,
	type CompactionPreparation,
	type CompactionResult,
	createDeterministicCompaction,
	estimateContextTokens,
	prepareCompaction,
	type SessionContext,
	SessionManager,
} from "@caupulican/pi-agent-core/node";
import type { Message, Usage } from "@caupulican/pi-ai";
import { orchestrationSessionsDir, workerConversationSessionsDir } from "../agent-paths.ts";
import { sameAgentResumeIdentity } from "../orchestration/agent-resume.ts";
import { validateAttemptUsageSnapshot } from "../orchestration/attempt-usage.ts";
import type { AgentResumeContext, AttemptUsageSnapshot, ResourcePointer } from "../orchestration/contracts.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import {
	collectBoundedWorkerClaimChangedFiles,
	MAX_WORKER_CLAIM_CHANGED_FILES,
	MAX_WORKER_CLAIM_TERMINAL_ATTEMPT_ID_CHARS,
} from "./worker-claim.ts";

const MAX_WORKER_CONVERSATION_METADATA_BYTES = 256 * 1024;
const WORKER_CHANGED_FILE_CUSTOM_TYPE = "worker-changed-file";

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
}

export interface OpenWorkerConversationOptions {
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

export interface WorkerConversationRetentionOutcome {
	status: "within_limit" | "compacted_verified" | "compacted_deterministic" | "cannot_compact";
	context: SessionContext;
	contextUsage: ReturnType<typeof estimateContextTokens>;
}

interface WorkerConversationMetadata {
	logicalAgentId: string;
	resumeContext: AgentResumeContext;
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
	const resumeContext = (metadata as { resumeContext?: unknown }).resumeContext;
	if (typeof logicalAgentId !== "string" || !logicalAgentId.trim() || !resumeContext) {
		throw new Error("Worker conversation metadata is invalid.");
	}
	return { logicalAgentId, resumeContext: cloneResumeContext(resumeContext as AgentResumeContext) };
}

function assertExactConversationMetadata(
	metadataFile: string,
	expected: AgentResumeContext,
	logicalAgentId?: string,
): void {
	const metadata = metadataFromFile(metadataFile);
	if (logicalAgentId && metadata.logicalAgentId !== logicalAgentId) {
		throw new Error("Worker conversation logical agent identity conflicts with the persisted transcript.");
	}
	if (!sameAgentResumeIdentity(metadata.resumeContext, expected)) {
		throw new Error("Worker conversation resume context conflicts with the persisted transcript.");
	}
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
	private readonly sessionManager: SessionManager;
	private readonly resumeContext: AgentResumeContext;

	constructor(sessionManager: SessionManager, resumeContext: AgentResumeContext) {
		this.sessionManager = sessionManager;
		this.resumeContext = cloneResumeContext(resumeContext);
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
		for (const entry of this.sessionManager.getEntries()) {
			if (
				entry.type === "message" &&
				(entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult")
			) {
				messages.push(structuredClone(entry.message));
			}
		}
		return messages;
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
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== WORKER_CHANGED_FILE_CUSTOM_TYPE) continue;
			const data = entry.data;
			if (!data || typeof data !== "object" || Array.isArray(data)) continue;
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
		}
		return collectBoundedWorkerClaimChangedFiles(paths).values;
	}

	/**
	 * Recover cumulative accounting from raw entry metadata without cloning or resolving message
	 * payloads that compaction deliberately moved out of the provider-visible working set.
	 */
	getRawTranscriptUsage(): AttemptUsageSnapshot {
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
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type === "compaction" && entry.usage) {
				usage.inputTokens += entry.usage.input;
				usage.outputTokens += entry.usage.output;
				usage.cacheReadTokens += entry.usage.cacheRead;
				usage.cacheWriteTokens += entry.usage.cacheWrite;
				usage.totalTokens += entry.usage.totalTokens;
				usage.costUsd += entry.usage.cost.total;
				continue;
			}
			if (entry.type !== "message") continue;
			if (entry.message.role === "toolResult") {
				usage.toolCalls += 1;
				continue;
			}
			if (entry.message.role !== "assistant") continue;
			usage.inputTokens += entry.message.usage.input;
			usage.outputTokens += entry.message.usage.output;
			usage.cacheReadTokens += entry.message.usage.cacheRead;
			usage.cacheWriteTokens += entry.message.usage.cacheWrite;
			usage.totalTokens += entry.message.usage.totalTokens;
			usage.costUsd += entry.message.usage.cost.total;
		}
		return validateAttemptUsageSnapshot(usage, "legacy worker transcript usage");
	}

	/**
	 * Locate a bounded set of durable mailbox delivery commits without materializing or cloning the
	 * complete raw transcript. Recovery uses this only to close the narrow crash window after a
	 * control message was appended but before its mailbox acknowledgement was persisted.
	 */
	findDeliveredWorkerControlMessageIds(pendingMessageIds: readonly string[]): Set<string> {
		const unresolved = new Set(pendingMessageIds);
		const delivered = new Set<string>();
		if (unresolved.size === 0) return delivered;
		const entries = this.sessionManager.getEntries();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (!entry) continue;
			if (entry.type !== "message" || entry.message.role !== "user" || typeof entry.message.content !== "string") {
				continue;
			}
			const messageId = /^\[Worker control (worker-message-[^\]]+)\]\n/.exec(entry.message.content)?.[1];
			if (!messageId || !unresolved.delete(messageId)) continue;
			delivered.add(messageId);
			if (unresolved.size === 0) break;
		}
		return delivered;
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
		return this.sessionManager.appendMessage(structuredClone(message));
	}

	/**
	 * Commit one complete child-owned transcript without replaying its persisted prefix.
	 *
	 * Any mismatch is a divergence: appending would duplicate or reorder provider context, so the
	 * caller must resolve it rather than silently branching this logical worker conversation.
	 */
	commitTranscript(transcript: readonly Message[]): number {
		// Compare against the append-only source transcript, not the provider projection: once a
		// compaction checkpoint exists, buildSessionContext() begins with its synthetic summary and is
		// intentionally no longer an exact prefix of the child loop's raw message sequence.
		const persisted = this.getRawTranscript();
		if (transcript.length < persisted.length) {
			throw new Error("Worker conversation transcript is shorter than its persisted raw context.");
		}
		for (let index = 0; index < persisted.length; index++) {
			if (!isDeepStrictEqual(persisted[index], transcript[index])) {
				throw new Error(`Worker conversation transcript diverges from persisted context at message ${index}.`);
			}
		}
		for (const message of transcript.slice(persisted.length)) {
			this.appendMessage(message);
		}
		return transcript.length - persisted.length;
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

		// SessionManager intentionally defers a brand-new header until its first assistant message.
		// A worker must be resumable after its first user/tool message, so atomically seed the exact
		// SessionManager header and immediately reopen it through SessionManager for all later writes.
		const seed = SessionManager.create(resumeContext.cwd, options.agentDir, sessionDir, {
			id: resumeContext.sessionId,
		});
		const header = seed.getHeader();
		if (!header) throw new Error("Unable to create a worker conversation session header.");
		if (existsSync(metadataFile)) {
			assertExactConversationMetadata(metadataFile, resumeContext, options.logicalAgentId);
		} else {
			// Metadata lands first: a crash leaves no visible conversation until the ordinary session
			// header is atomically published, while a later ensure can validate the exact intended identity.
			writeFileAtomicSync(
				metadataFile,
				`${JSON.stringify({ logicalAgentId: options.logicalAgentId, resumeContext })}\n`,
			);
		}
		writeFileAtomicSync(sessionFile, `${JSON.stringify(header)}\n`);

		return this.open({
			agentDir: options.agentDir,
			resumeContext,
			expectedLogicalAgentId: options.logicalAgentId,
		});
	}

	/** Open the one canonical transcript or atomically create it with the exact same durable identity. */
	ensure(options: CreateWorkerConversationOptions): WorkerConversation {
		const resumeContext = expectedResumeContext(options);
		const sessionFile = resumeContext.sessionFile!;
		return withFileLockSync(sessionFile, () => {
			if (!existsSync(sessionFile)) return this.createLocked(options, resumeContext);
			return this.open({
				agentDir: options.agentDir,
				resumeContext,
				expectedLogicalAgentId: options.logicalAgentId,
			});
		});
	}

	open(options: OpenWorkerConversationOptions): WorkerConversation {
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
		assertExactConversationMetadata(
			workerConversationMetadataFile(sessionFile),
			context,
			options.expectedLogicalAgentId,
		);

		return new WorkerConversation(sessionManager, {
			...context,
			sessionDir,
			sessionFile,
			cwd: sessionManager.getCwd(),
		});
	}
}

function joinWorkerSessionFile(sessionDir: string, sessionId: string): string {
	return resolve(sessionDir, `${sessionId}.jsonl`);
}

function workerConversationMetadataFile(sessionFile: string): string {
	return `${sessionFile}.worker.json`;
}
