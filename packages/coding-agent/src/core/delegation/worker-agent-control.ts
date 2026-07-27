import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { workerAgentMailboxFile } from "../agent-paths.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";

const MAX_MAILBOX_MESSAGES = 64;
const MAX_MAILBOX_MESSAGE_CHARS = 4_096;
const MAX_MAILBOX_BYTES = 128 * 1024;
const MAX_MAILBOX_MESSAGE_ID_CHARS = 512;
const MAX_MAILBOX_TIMESTAMP_CHARS = 128;

export type WorkerAgentMessageKind = "steer" | "follow_up";

export interface WorkerAgentMessage {
	messageId: string;
	kind: WorkerAgentMessageKind;
	content: string;
	createdAt: string;
	deliveredAt?: string;
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

/** One canonical host port for model-facing logical-agent controls. */
export interface WorkerAgentControlPort {
	sendWorkerAgentMessage(agentId: string, message: string): { messageId: string; queued: true };
	followUpWorkerAgent(
		agentId: string,
		message: string,
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
			typeof message.createdAt !== "string" ||
			message.createdAt.length === 0 ||
			message.createdAt.length > MAX_MAILBOX_TIMESTAMP_CHARS ||
			(message.deliveredAt !== undefined &&
				(typeof message.deliveredAt !== "string" ||
					message.deliveredAt.length === 0 ||
					message.deliveredAt.length > MAX_MAILBOX_TIMESTAMP_CHARS))
		) {
			throw new Error("Worker agent mailbox contains an invalid message.");
		}
		return { ...message };
	});
	const pendingMessages = messages.filter((message) => message.deliveredAt === undefined);
	if (pendingMessages.length > MAX_MAILBOX_MESSAGES)
		throw new Error("Worker agent mailbox exceeds its pending-message bound.");
	return { version: 1, parentSessionId, agentId, messages: pendingMessages };
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

	enqueue(input: { kind: WorkerAgentMessageKind; content: string }): WorkerAgentMessage {
		const content = input.content.trim();
		if (!content) throw new TypeError("A worker control message is required.");
		if (content.length > MAX_MAILBOX_MESSAGE_CHARS) {
			throw new TypeError(
				`Worker control messages may not exceed ${MAX_MAILBOX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`,
			);
		}
		const message: WorkerAgentMessage = {
			messageId: `worker-message-${randomUUID()}`,
			kind: input.kind,
			content,
			createdAt: new Date().toISOString(),
		};
		this.update((state) => {
			if (state.messages.length >= MAX_MAILBOX_MESSAGES) {
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
		const normalized = messageId.trim();
		if (!normalized) throw new TypeError("A worker control message id is required.");
		let changed = false;
		this.update((state) => {
			const messages = state.messages.filter((message) => {
				if (message.messageId !== normalized) return true;
				changed = true;
				return false;
			});
			return changed ? { ...state, messages } : state;
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
			const next = mutator(state);
			if (next.messages.length > MAX_MAILBOX_MESSAGES || encodedStateBytes(next) > MAX_MAILBOX_BYTES) {
				throw new Error("Worker agent mailbox exceeds its durable size bound.");
			}
			if (JSON.stringify(next) !== JSON.stringify(state))
				writeFileAtomicSync(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
		});
	}
}
