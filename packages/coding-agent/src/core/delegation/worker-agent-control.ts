import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Message } from "@caupulican/pi-ai";
import { workerAgentMailboxFile } from "../agent-paths.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";

const MAX_MAILBOX_MESSAGES = 64;
const MAX_MAILBOX_MESSAGE_CHARS = 4_096;
const MAX_MAILBOX_BYTES = 128 * 1024;
const MAX_MAILBOX_MESSAGE_ID_CHARS = 512;
const MAX_MAILBOX_TIMESTAMP_CHARS = 128;
const MAX_MAILBOX_IDENTITY_CHARS = 512;
const MAX_MAILBOX_RETAINED_MESSAGES = MAX_MAILBOX_MESSAGES * 2;

export type WorkerAgentMessageKind = "steer" | "follow_up";

export interface WorkerAgentMessage {
	messageId: string;
	kind: WorkerAgentMessageKind;
	content: string;
	senderAgentId?: string;
	threadId?: string;
	replyToMessageId?: string;
	expectReply?: boolean;
	createdAt: string;
	deliveredAt?: string;
	repliedAt?: string;
}

interface WorkerAgentMailboxState {
	version: 1;
	parentSessionId: string;
	agentId: string;
	messages: WorkerAgentMessage[];
}

export interface WorkerAgentMailboxOptions {
	agentDir: string;
	parentSessionId: string;
	agentId: string;
}

export interface WorkerAgentTranscriptPage {
	agentId: string;
	cursor: number;
	totalMessages: number;
	messages: Message[];
	nextCursor?: number;
}

export interface WorkerAgentMessageOptions {
	senderAgentId?: string;
	threadId?: string;
	replyToMessageId?: string;
	expectReply?: boolean;
}

/** One canonical host port for model-facing logical-agent controls. */
export interface WorkerAgentControlPort {
	listWorkerAgents(): AgentBindingContract[];
	readWorkerAgentTranscript(
		agentId: string,
		options?: { cursor?: number; maxMessages?: number },
	): WorkerAgentTranscriptPage;
	sendWorkerAgentMessage(
		agentId: string,
		message: string,
		options?: WorkerAgentMessageOptions,
	): { messageId: string; queued: true };
	followUpWorkerAgent(
		agentId: string,
		message: string,
		options?: WorkerAgentMessageOptions,
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string };
	interruptWorkerAgent(agentId: string): { interrupted: boolean; reason?: string };
	resumeWorkerAgent(agentId: string): { started: boolean; record?: LaneRecord; skipReason?: string };
	cancelWorkerAgent(agentId: string, reasonCode?: string): LaneRecord | undefined;
	waitForWorkerAgent(
		agentId: string,
		timeoutMs?: number,
	): Promise<{ status: "active" | "suspended" | "idle" | "unknown" }>;
}

function mailboxDigest(parentSessionId: string, agentId: string): string {
	return createHash("sha256")
		.update("pi-worker-agent-mailbox-v1")
		.update("\0")
		.update(parentSessionId)
		.update("\0")
		.update(agentId)
		.digest("hex");
}

function assertIdentity(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new TypeError(`A worker ${label} is required.`);
	if (normalized.length > 512) throw new TypeError(`Worker ${label} exceeds 512 characters.`);
	return normalized;
}

function parseState(raw: string, parentSessionId: string, agentId: string): WorkerAgentMailboxState {
	let candidate: unknown;
	try {
		candidate = JSON.parse(raw);
	} catch {
		throw new Error("Worker agent mailbox is invalid JSON.");
	}
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
		throw new Error("Worker agent mailbox is invalid.");
	}
	const state = candidate as Partial<WorkerAgentMailboxState>;
	if (
		state.version !== 1 ||
		state.parentSessionId !== parentSessionId ||
		state.agentId !== agentId ||
		!Array.isArray(state.messages)
	) {
		throw new Error("Worker agent mailbox identity conflicts with the requested logical worker.");
	}
	const messages = state.messages.map((message): WorkerAgentMessage => {
		if (
			!message ||
			typeof message !== "object" ||
			Array.isArray(message) ||
			typeof message.messageId !== "string" ||
			message.messageId.length === 0 ||
			message.messageId.length > MAX_MAILBOX_MESSAGE_ID_CHARS ||
			(message.kind !== "steer" && message.kind !== "follow_up") ||
			typeof message.content !== "string" ||
			message.content.length === 0 ||
			message.content.length > MAX_MAILBOX_MESSAGE_CHARS ||
			(message.senderAgentId !== undefined &&
				(typeof message.senderAgentId !== "string" ||
					message.senderAgentId.length === 0 ||
					message.senderAgentId.length > MAX_MAILBOX_IDENTITY_CHARS)) ||
			(message.threadId !== undefined &&
				(typeof message.threadId !== "string" ||
					message.threadId.length === 0 ||
					message.threadId.length > MAX_MAILBOX_IDENTITY_CHARS)) ||
			(message.replyToMessageId !== undefined &&
				(typeof message.replyToMessageId !== "string" ||
					message.replyToMessageId.length === 0 ||
					message.replyToMessageId.length > MAX_MAILBOX_MESSAGE_ID_CHARS)) ||
			(message.expectReply !== undefined && typeof message.expectReply !== "boolean") ||
			typeof message.createdAt !== "string" ||
			message.createdAt.length === 0 ||
			message.createdAt.length > MAX_MAILBOX_TIMESTAMP_CHARS ||
			(message.deliveredAt !== undefined &&
				(typeof message.deliveredAt !== "string" ||
					message.deliveredAt.length === 0 ||
					message.deliveredAt.length > MAX_MAILBOX_TIMESTAMP_CHARS)) ||
			(message.repliedAt !== undefined &&
				(typeof message.repliedAt !== "string" ||
					message.repliedAt.length === 0 ||
					message.repliedAt.length > MAX_MAILBOX_TIMESTAMP_CHARS))
		) {
			throw new Error("Worker agent mailbox contains an invalid message.");
		}
		return { ...message };
	});
	const pendingMessages = messages.filter((message) => message.deliveredAt === undefined);
	if (pendingMessages.length > MAX_MAILBOX_MESSAGES)
		throw new Error("Worker agent mailbox exceeds its pending-message bound.");
	if (messages.length > MAX_MAILBOX_RETAINED_MESSAGES)
		throw new Error("Worker agent mailbox exceeds its retained-message bound.");
	return { version: 1, parentSessionId, agentId, messages };
}

function normalizeOptionalIdentity(value: string | undefined, label: string): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_MAILBOX_IDENTITY_CHARS) {
		throw new TypeError(`Worker control ${label} is invalid.`);
	}
	return normalized;
}

function pruneDeliveredHistory(messages: readonly WorkerAgentMessage[]): WorkerAgentMessage[] {
	const pending = messages.filter((message) => message.deliveredAt === undefined);
	const awaitingReply = messages.filter(
		(message) => message.deliveredAt !== undefined && message.expectReply === true && message.repliedAt === undefined,
	);
	const retainedIds = new Set([...pending, ...awaitingReply].map((message) => message.messageId));
	const remainingSlots = Math.max(0, MAX_MAILBOX_RETAINED_MESSAGES - retainedIds.size);
	const deliveredCandidates = messages.filter(
		(message) => message.deliveredAt !== undefined && !retainedIds.has(message.messageId),
	);
	const recentDelivered = remainingSlots > 0 ? deliveredCandidates.slice(-remainingSlots) : [];
	return [...pending, ...awaitingReply, ...recentDelivered].sort((left, right) =>
		left.createdAt.localeCompare(right.createdAt),
	);
}

function encodedStateBytes(state: WorkerAgentMailboxState): number {
	return Buffer.byteLength(JSON.stringify(state), "utf-8");
}

/**
 * Bounded durable inbox for a single logical worker agent.
 *
 * A message is never considered delivered merely because a controller read it. Its caller must
 * acknowledge it only after the exact corresponding user message has been appended to the child
 * WorkerConversation. The in-process subscription is a notification edge, not a polling loop.
 */
export class WorkerAgentMailbox {
	private readonly parentSessionId: string;
	private readonly agentId: string;
	private readonly file: string;
	private readonly listeners = new Set<() => void>();

	constructor(options: WorkerAgentMailboxOptions) {
		this.parentSessionId = assertIdentity(options.parentSessionId, "parent session id");
		this.agentId = assertIdentity(options.agentId, "agent id");
		this.file = workerAgentMailboxFile(
			options.agentDir,
			this.parentSessionId,
			mailboxDigest(this.parentSessionId, this.agentId),
		);
	}

	enqueue(input: {
		kind: WorkerAgentMessageKind;
		content: string;
		senderAgentId?: string;
		threadId?: string;
		replyToMessageId?: string;
		expectReply?: boolean;
	}): WorkerAgentMessage {
		const content = input.content.trim();
		if (!content) throw new TypeError("A worker control message is required.");
		if (content.length > MAX_MAILBOX_MESSAGE_CHARS) {
			throw new TypeError(
				`Worker control messages may not exceed ${MAX_MAILBOX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`,
			);
		}
		const senderAgentId = normalizeOptionalIdentity(input.senderAgentId, "sender agent id");
		const threadId = normalizeOptionalIdentity(input.threadId, "thread id");
		const replyToMessageId = normalizeOptionalIdentity(input.replyToMessageId, "reply message id");
		const message: WorkerAgentMessage = {
			messageId: `worker-message-${randomUUID()}`,
			kind: input.kind,
			content,
			...(senderAgentId ? { senderAgentId } : {}),
			...(threadId ? { threadId } : {}),
			...(replyToMessageId ? { replyToMessageId } : {}),
			...(input.expectReply === true ? { expectReply: true } : {}),
			createdAt: new Date().toISOString(),
		};
		this.update((state) => {
			if (state.messages.filter((candidate) => candidate.deliveredAt === undefined).length >= MAX_MAILBOX_MESSAGES) {
				throw new Error(`Worker agent mailbox reached its ${MAX_MAILBOX_MESSAGES} message limit.`);
			}
			return { ...state, messages: [...state.messages, message] };
		});
		this.notify();
		return structuredClone(message);
	}

	pending(kind?: WorkerAgentMessageKind): WorkerAgentMessage[] {
		return this.read()
			.messages.filter(
				(message) => message.deliveredAt === undefined && (kind === undefined || message.kind === kind),
			)
			.map((message) => structuredClone(message));
	}

	acknowledgeDelivered(messageId: string): void {
		this.markTimestamp(messageId, "deliveredAt");
	}

	awaitingReplies(): WorkerAgentMessage[] {
		return this.read()
			.messages.filter(
				(message) =>
					message.deliveredAt !== undefined && message.expectReply === true && message.repliedAt === undefined,
			)
			.map((message) => structuredClone(message));
	}

	markReplied(messageId: string): void {
		this.markTimestamp(messageId, "repliedAt");
	}

	private markTimestamp(messageId: string, field: "deliveredAt" | "repliedAt"): void {
		const normalized = messageId.trim();
		if (!normalized) throw new TypeError("A worker control message id is required.");
		let changed = false;
		this.update((state) => {
			const messages: WorkerAgentMessage[] = state.messages.map((message) => {
				if (message.messageId !== normalized || message[field] !== undefined) return message;
				changed = true;
				return { ...message, [field]: new Date().toISOString() };
			});
			return changed ? { ...state, messages: pruneDeliveredHistory(messages) } : state;
		});
		if (changed) this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private read(): WorkerAgentMailboxState {
		if (!existsSync(this.file)) {
			return { version: 1, parentSessionId: this.parentSessionId, agentId: this.agentId, messages: [] };
		}
		return parseState(
			readBoundedTextFileSync(this.file, MAX_MAILBOX_BYTES, "Worker agent mailbox durable size bound"),
			this.parentSessionId,
			this.agentId,
		);
	}

	private update(mutator: (state: WorkerAgentMailboxState) => WorkerAgentMailboxState): void {
		withFileLockSync(this.file, () => {
			const state = this.read();
			const mutated = mutator(state);
			const next = { ...mutated, messages: pruneDeliveredHistory(mutated.messages) };
			if (next.messages.length > MAX_MAILBOX_RETAINED_MESSAGES || encodedStateBytes(next) > MAX_MAILBOX_BYTES) {
				throw new Error("Worker agent mailbox exceeds its durable size bound.");
			}
			if (JSON.stringify(next) !== JSON.stringify(state))
				writeFileAtomicSync(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
		});
	}
}
