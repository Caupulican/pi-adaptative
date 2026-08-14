import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Message } from "@caupulican/pi-ai";
import { workerAgentMailboxFile } from "../agent-paths.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { parseBoundedStringArray } from "../orchestration/bounded-string-array.ts";
import {
	type AgentBindingStatus,
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	type WorkerRole,
} from "../orchestration/contracts.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import { createReplaySafeMailboxBounder } from "./replay-safe-mailbox-bounds.ts";
import type {
	SessionRootReply,
	SessionRootReplyQuery,
	SessionRootReplyWaitOptions,
	SessionRootReplyWaitResult,
} from "./session-root-mailbox.ts";
import type { WorkerTaskSessionView } from "./worker-task-view.ts";

const MAX_MAILBOX_MESSAGES = 64;
const MAX_MAILBOX_MESSAGE_CHARS = 4_096;
const MAX_ORDINARY_MAILBOX_BYTES = 128 * 1024;
const MAX_MAILBOX_MESSAGE_ID_CHARS = 512;
const MAX_MAILBOX_TIMESTAMP_CHARS = 128;
const MAX_MAILBOX_IDENTITY_CHARS = 512;
const MAX_MAILBOX_IDEMPOTENCY_KEY_CHARS = 2_048;
const MAX_ORDINARY_RETAINED_MESSAGES = MAX_MAILBOX_MESSAGES * 2;
const MAX_MANDATORY_RETAINED_MESSAGES = MAX_MAILBOX_MESSAGES;
const MAX_MAILBOX_RETAINED_MESSAGES = MAX_ORDINARY_RETAINED_MESSAGES + MAX_MANDATORY_RETAINED_MESSAGES;
const MAX_REPLAY_EVIDENCE_SLOTS = MAX_ORDINARY_RETAINED_MESSAGES * 4;
const MAX_MAILBOX_REPLAY_RECEIPTS = MAX_REPLAY_EVIDENCE_SLOTS + MAX_ORDINARY_RETAINED_MESSAGES;
const MAX_MAILBOX_TRANSITION_TIMESTAMP = "9999-12-31T23:59:59.999Z";
const MAX_ENCODED_MANDATORY_MESSAGE_BYTES =
	Buffer.byteLength(
		JSON.stringify({
			messageId: `worker-message-${"f".repeat(64)}`,
			kind: "follow_up",
			content: `c${"\0".repeat(MAX_MAILBOX_MESSAGE_CHARS - 1)}`,
			senderAgentId: `s${"\0".repeat(MAX_MAILBOX_IDENTITY_CHARS - 1)}`,
			threadId: `t${"\0".repeat(MAX_MAILBOX_IDENTITY_CHARS - 1)}`,
			replyToMessageId: `r${"\0".repeat(MAX_MAILBOX_MESSAGE_ID_CHARS - 1)}`,
			expectReply: true,
			task: {
				kind: "terminal_handoff",
				sourceAttemptId: `a${"\0".repeat(MAX_MAILBOX_IDENTITY_CHARS - 1)}`,
			},
			createdAt: MAX_MAILBOX_TRANSITION_TIMESTAMP,
			deliveredAt: MAX_MAILBOX_TRANSITION_TIMESTAMP,
		}),
		"utf-8",
	) + 1;
// The additive reserve keeps every previously valid 128 KiB ordinary mailbox migration-safe and
// covers one maximum accepted source acknowledgement transaction (locked by the saturation tests).
const MAX_MANDATORY_TRANSITION_RESERVE_BYTES = Math.max(48 * 1024, MAX_ENCODED_MANDATORY_MESSAGE_BYTES + 1_024);
const MAX_MAILBOX_BYTES = MAX_ORDINARY_MAILBOX_BYTES + MAX_MANDATORY_TRANSITION_RESERVE_BYTES;
const CONTENT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const assertWorkerAgentMailboxBounds = createReplaySafeMailboxBounder(
	"Worker agent mailbox",
	MAX_MAILBOX_RETAINED_MESSAGES,
	MAX_MAILBOX_REPLAY_RECEIPTS,
	MAX_MAILBOX_BYTES,
);

export type WorkerAgentMessageKind = "steer" | "follow_up";

export type WorkerAgentTaskMetadata =
	| { kind: "agent_turn"; dependsOnTaskIds?: readonly string[] }
	| { kind: "terminal_handoff"; sourceAttemptId: string };

export interface WorkerAgentMessage {
	messageId: string;
	kind: WorkerAgentMessageKind;
	content: string;
	senderAgentId?: string;
	threadId?: string;
	replyToMessageId?: string;
	expectReply?: boolean;
	/** Durable intent requiring one mailbox-correlated agent turn if no live turn consumes it. */
	task?: WorkerAgentTaskMetadata;
	createdAt: string;
	deliveredAt?: string;
	repliedAt?: string;
	replyReceipt?: WorkerReplyReceipt;
	failedAt?: string;
	failureReason?: string;
}

export interface WorkerReplyReceipt {
	replyMessageId: string;
	requestSenderId: string;
	contentDigest: string;
}

interface WorkerAgentMailboxState {
	version: 1;
	parentSessionId: string;
	agentId: string;
	messages: WorkerAgentMessage[];
	replyAcknowledgements: WorkerReplyAcknowledgement[];
	replayReceipts: WorkerMailboxReplayReceipt[];
}

export interface WorkerReplyAcknowledgement {
	messageId: string;
	acknowledgementId: string;
	replyContent: string;
}

type WorkerReplyAcknowledgementIdentity = Pick<WorkerReplyAcknowledgement, "messageId" | "acknowledgementId">;

interface WorkerControlReplayReceipt {
	kind: "control";
	messageId: string;
	intentDigest: string;
	deliveredAt?: string;
}

interface WorkerReplyReplayReceipt extends WorkerReplyReceipt {
	kind: "reply";
	messageId: string;
}

type WorkerMailboxReplayReceipt = WorkerControlReplayReceipt | WorkerReplyReplayReceipt;

export type WorkerAgentEnqueueReceipt =
	| { status: "retained"; messageId: string; message: WorkerAgentMessage; created: boolean }
	| { status: "completed_replay"; messageId: string; created: false };

export interface WorkerAgentMailboxOptions {
	agentDir: string;
	parentSessionId: string;
	agentId: string;
}

export interface WorkerAgentTranscriptPage {
	agentId: string;
	cursor: number;
	messages: Message[];
	nextCursor?: number;
	omittedMessages: number;
	serializedBytes: number;
}

export interface WorkerAgentMessageOptions {
	senderAgentId?: string;
	threadId?: string;
	expectReply?: boolean;
	/** Host-derived replay identity scoped to the caller, session, tool invocation, and action. */
	idempotencyKey?: string;
}

export interface WorkerAgentBroadcastOptions {
	senderAgentId?: string;
	threadId?: string;
	expectReply?: boolean;
	/** Call-level replay identity; the coordinator derives one stable identity per canonical target. */
	idempotencyKey: string;
}

export interface SessionRootWorkerAgentMessageOptions {
	threadId?: string;
	expectReply?: boolean;
	idempotencyKey?: string;
}

export type WorkerAgentReplyResult =
	| { destination: "session_root"; messageId: string }
	| {
			destination: "worker";
			messageId: string;
			started: boolean;
			steering: boolean;
			record?: LaneRecord;
			skipReason?: string;
	  };

export interface WorkerAgentControlScope {
	callerAgentId?: string;
}

export interface WorkerAgentTaskStartOptions extends WorkerAgentControlScope {
	/** Host-derived replay identity scoped to the caller, session, tool invocation, and action. */
	idempotencyKey?: string;
	/** Existing same-objective durable tasks that must complete before this turn may run. */
	dependsOnTaskIds?: readonly string[];
}

export interface WorkerAgentTranscriptOptions extends WorkerAgentControlScope {
	cursor?: number;
	maxMessages?: number;
	/** Host-owned aggregate-envelope headroom; never accepted directly from a model argument. */
	maxBytes?: number;
}

export type WorkerAgentActivity = "active" | "suspended" | "idle" | "unknown";

export type WorkerAgentWaitMode = "any" | "all";

export interface WorkerAgentWaitStatus {
	agentId: string;
	status: WorkerAgentActivity;
}

export interface WorkerAgentWaitResult {
	statuses: WorkerAgentWaitStatus[];
	updatedAgentIds: string[];
	timedOut: boolean;
}

export type WorkerAgentBroadcastTargetResult =
	| { agentId: string; accepted: true; queued: true; replayed: boolean; messageId: string }
	| { agentId: string; accepted: false; error: string };

export interface WorkerAgentBroadcastResult {
	results: WorkerAgentBroadcastTargetResult[];
}

/** Explicit model-facing projection. Durable resume, session, path, and resource data stay host-only. */
export interface WorkerAgentView {
	agentId: string;
	parentAgentId?: string;
	rootAgentId: string;
	depth: number;
	role: WorkerRole;
	status: AgentBindingStatus;
	activity: WorkerAgentActivity;
	/** True when this caller may start/transcript/cancel the agent. Session-root lists are all true. */
	controllable: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface WorkerAgentRetireResult {
	agent: WorkerAgentView;
	retired: true;
	replayed: boolean;
}

/** One canonical host port for model-facing logical-agent controls. */
export interface WorkerAgentControlPort {
	listWorkerAgents(scope?: WorkerAgentControlScope): WorkerAgentView[];
	getWorkerTaskSessionView(): WorkerTaskSessionView;
	getWorkerAgentActivity(agentId: string, scope?: WorkerAgentControlScope): WorkerAgentActivity;
	readWorkerAgentTranscript(agentId: string, options?: WorkerAgentTranscriptOptions): WorkerAgentTranscriptPage;
	/** Queue-only session-peer delivery. This does not wake or steer an idle or active agent. */
	sendWorkerAgentMessage(
		agentId: string,
		message: string,
		options?: WorkerAgentMessageOptions,
	): { messageId: string; queued: true };
	/** Queue-only fan-out. Peer content is untrusted coordination evidence, never delegated authority. */
	broadcastWorkerAgentMessage(
		agentIds: readonly string[],
		message: string,
		options: WorkerAgentBroadcastOptions,
	): WorkerAgentBroadcastResult;
	/** Worker callers may wake or steer only themselves and descendants; the session root may target any agent. */
	followUpWorkerAgent(
		agentId: string,
		message: string,
		options?: WorkerAgentMessageOptions,
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string };
	sendSessionRootWorkerAgentMessage(
		agentId: string,
		message: string,
		options?: SessionRootWorkerAgentMessageOptions,
	): { messageId: string; queued: true };
	followUpSessionRootWorkerAgent(
		agentId: string,
		message: string,
		options?: SessionRootWorkerAgentMessageOptions,
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string };
	replyToWorkerAgentMessage(sourceAgentId: string, message: string, replyToMessageId: string): WorkerAgentReplyResult;
	listSessionRootReplies(query?: SessionRootReplyQuery): SessionRootReply[];
	waitForSessionRootReplies(options?: SessionRootReplyWaitOptions): Promise<SessionRootReplyWaitResult>;
	acknowledgeSessionRootReply(messageId: string, ackToken: string): boolean;
	reconcileSessionRootReplies(): void;
	/** Worker callers may start only themselves and descendants; the session root may target any agent. */
	startWorkerAgentTask(
		agentId: string,
		message: string,
		options?: WorkerAgentTaskStartOptions,
	): { started: boolean; steering: false; messageId: string; record?: LaneRecord; skipReason?: string };
	interruptWorkerAgent(agentId: string, scope?: WorkerAgentControlScope): { interrupted: boolean; reason?: string };
	resumeWorkerAgent(
		agentId: string,
		scope?: WorkerAgentControlScope,
	): { started: boolean; record?: LaneRecord; skipReason?: string };
	cancelWorkerAgent(agentId: string, reasonCode?: string, scope?: WorkerAgentControlScope): LaneRecord | undefined;
	/** Retire one idle leaf without deleting its durable binding, lineage, transcript, or attempt history. */
	retireWorkerAgent(agentId: string, scope?: WorkerAgentControlScope): WorkerAgentRetireResult;
	waitForWorkerAgent(
		agentId: string,
		timeoutMs?: number,
		scope?: WorkerAgentControlScope,
	): Promise<{ status: WorkerAgentActivity; timedOut: boolean }>;
	waitForWorkerAgents(
		agentIds: readonly string[],
		mode: WorkerAgentWaitMode,
		timeoutMs?: number,
		scope?: WorkerAgentControlScope,
	): Promise<WorkerAgentWaitResult>;
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

/** Derive one target-fenced mailbox replay identity from a host-owned broadcast call identity. */
export function workerAgentBroadcastTargetIdempotencyKey(baseIdempotencyKey: string, agentId: string): string {
	const replayIdentity = baseIdempotencyKey.trim();
	if (!replayIdentity || replayIdentity.length > MAX_MAILBOX_IDEMPOTENCY_KEY_CHARS) {
		throw new TypeError("Worker broadcast idempotency key is invalid.");
	}
	const targetAgentId = assertIdentity(agentId, "agent id");
	return `worker-broadcast-${createHash("sha256")
		.update("pi-worker-broadcast-target-v1")
		.update("\0")
		.update(replayIdentity)
		.update("\0")
		.update(targetAgentId)
		.digest("hex")}`;
}

/** Session-scoped replay identity. The coordinator fences one accepted id to exactly one target mailbox. */
export function workerAgentMessageId(parentSessionId: string, idempotencyKey: string): string {
	const sessionId = assertIdentity(parentSessionId, "parent session id");
	const replayIdentity = idempotencyKey.trim();
	if (!replayIdentity || replayIdentity.length > MAX_MAILBOX_IDEMPOTENCY_KEY_CHARS) {
		throw new TypeError("Worker control idempotency key is invalid.");
	}
	return `worker-message-${createHash("sha256")
		.update("pi-worker-agent-message-v2")
		.update("\0")
		.update(sessionId)
		.update("\0")
		.update(replayIdentity)
		.digest("hex")}`;
}

function contentDigest(domain: string, content: string): string {
	return createHash("sha256").update(domain).update("\0").update(content).digest("hex");
}

function controlIntentDigest(input: {
	content: string;
	senderAgentId?: string;
	threadId?: string;
	replyToMessageId?: string;
	expectReply?: boolean;
	task?: WorkerAgentTaskMetadata;
}): string {
	return contentDigest(
		"pi-worker-agent-control-intent-v1",
		JSON.stringify([
			input.content,
			input.senderAgentId ?? null,
			input.threadId ?? null,
			input.replyToMessageId ?? null,
			input.expectReply === true,
			input.task ?? null,
		]),
	);
}

function replyIntentDigest(content: string): string {
	return contentDigest("pi-worker-reply-content-v1", content);
}

function controlReplayReceipt(
	messageId: string,
	intentDigest: string,
	deliveredAt?: string,
): WorkerControlReplayReceipt {
	return { kind: "control", messageId, intentDigest, ...(deliveredAt ? { deliveredAt } : {}) };
}

function controlReplayReceiptFor(
	receipts: readonly WorkerMailboxReplayReceipt[],
	messageId: string,
): WorkerControlReplayReceipt | undefined {
	return receipts.find(
		(receipt): receipt is WorkerControlReplayReceipt => receipt.kind === "control" && receipt.messageId === messageId,
	);
}

function replyReplayReceiptFor(
	receipts: readonly WorkerMailboxReplayReceipt[],
	messageId: string,
): WorkerReplyReplayReceipt | undefined {
	return receipts.find(
		(receipt): receipt is WorkerReplyReplayReceipt => receipt.kind === "reply" && receipt.messageId === messageId,
	);
}

function requiredMailboxTimestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_MAILBOX_TIMESTAMP_CHARS) {
		throw new Error(`Worker agent mailbox contains an invalid message ${label}.`);
	}
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
		throw new Error(`Worker agent mailbox contains an invalid message ${label}.`);
	}
	return value;
}

function transitionTimestamp(floor: string): string {
	const current = new Date().toISOString();
	return Date.parse(current) < Date.parse(floor) ? floor : current;
}

function parseReplyReceiptFields(receipt: Record<string, unknown>, label: string): WorkerReplyReceipt {
	if (
		typeof receipt.replyMessageId !== "string" ||
		!receipt.replyMessageId ||
		receipt.replyMessageId.length > MAX_MAILBOX_MESSAGE_ID_CHARS ||
		typeof receipt.requestSenderId !== "string" ||
		!receipt.requestSenderId ||
		receipt.requestSenderId.length > MAX_MAILBOX_IDENTITY_CHARS ||
		typeof receipt.contentDigest !== "string" ||
		!CONTENT_DIGEST_PATTERN.test(receipt.contentDigest)
	) {
		throw new Error(`Worker agent mailbox contains invalid ${label}.`);
	}
	return {
		replyMessageId: receipt.replyMessageId,
		requestSenderId: receipt.requestSenderId,
		contentDigest: receipt.contentDigest,
	};
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
		let task: WorkerAgentTaskMetadata | undefined;
		let replyReceipt: WorkerReplyReceipt | undefined;
		if (message?.task !== undefined) {
			if (!message.task || typeof message.task !== "object" || Array.isArray(message.task)) {
				throw new Error("Worker agent mailbox contains invalid task-bearing message metadata.");
			}
			const taskRecord = message.task as Record<string, unknown>;
			if (
				taskRecord.kind === "agent_turn" &&
				Object.keys(taskRecord).every((field) => field === "kind" || field === "dependsOnTaskIds")
			) {
				const dependsOnTaskIds = normalizeWorkerAgentDependencyTaskIds(taskRecord.dependsOnTaskIds);
				task = {
					kind: "agent_turn",
					...(dependsOnTaskIds.length > 0 ? { dependsOnTaskIds } : {}),
				};
			} else if (
				taskRecord.kind === "terminal_handoff" &&
				typeof taskRecord.sourceAttemptId === "string" &&
				taskRecord.sourceAttemptId.length > 0 &&
				taskRecord.sourceAttemptId.length <= MAX_MAILBOX_IDENTITY_CHARS &&
				Object.keys(taskRecord).every((field) => field === "kind" || field === "sourceAttemptId")
			) {
				task = { kind: "terminal_handoff", sourceAttemptId: taskRecord.sourceAttemptId };
			} else {
				throw new Error("Worker agent mailbox contains invalid task-bearing message metadata.");
			}
		}
		if (message?.replyReceipt !== undefined) {
			if (!message.replyReceipt || typeof message.replyReceipt !== "object" || Array.isArray(message.replyReceipt)) {
				throw new Error("Worker agent mailbox contains invalid reply receipt metadata.");
			}
			const receipt = message.replyReceipt as unknown as Record<string, unknown>;
			if (
				!Object.keys(receipt).every(
					(field) => field === "replyMessageId" || field === "requestSenderId" || field === "contentDigest",
				)
			) {
				throw new Error("Worker agent mailbox contains invalid reply receipt metadata.");
			}
			replyReceipt = parseReplyReceiptFields(receipt, "reply receipt metadata");
		}
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
					message.repliedAt.length > MAX_MAILBOX_TIMESTAMP_CHARS)) ||
			(message.failedAt !== undefined &&
				(typeof message.failedAt !== "string" ||
					message.failedAt.length === 0 ||
					message.failedAt.length > MAX_MAILBOX_TIMESTAMP_CHARS)) ||
			(message.failureReason !== undefined &&
				(typeof message.failureReason !== "string" ||
					message.failureReason.length === 0 ||
					message.failureReason.length > MAX_MAILBOX_IDENTITY_CHARS))
		) {
			throw new Error("Worker agent mailbox contains an invalid message.");
		}
		const createdAt = requiredMailboxTimestamp(message.createdAt, "creation timestamp");
		const deliveredAt =
			message.deliveredAt === undefined
				? undefined
				: requiredMailboxTimestamp(message.deliveredAt, "delivery timestamp");
		const repliedAt =
			message.repliedAt === undefined ? undefined : requiredMailboxTimestamp(message.repliedAt, "reply timestamp");
		const failedAt =
			message.failedAt === undefined ? undefined : requiredMailboxTimestamp(message.failedAt, "failure timestamp");
		if (deliveredAt !== undefined && Date.parse(deliveredAt) < Date.parse(createdAt)) {
			throw new Error("Worker agent mailbox message delivery timestamp predates creation.");
		}
		if (repliedAt !== undefined && deliveredAt === undefined) {
			throw new Error("Worker agent mailbox message reply timestamp has no delivery timestamp.");
		}
		if (repliedAt !== undefined && deliveredAt !== undefined && Date.parse(repliedAt) < Date.parse(deliveredAt)) {
			throw new Error("Worker agent mailbox message reply timestamp predates delivery.");
		}
		if (repliedAt !== undefined && message.expectReply !== true) {
			throw new Error("Worker agent mailbox replied message did not expect a reply.");
		}
		if (failedAt !== undefined && Date.parse(failedAt) < Date.parse(createdAt)) {
			throw new Error("Worker agent mailbox message failure timestamp predates creation.");
		}
		if (
			(failedAt === undefined) !== (message.failureReason === undefined) ||
			(failedAt !== undefined && deliveredAt !== undefined)
		) {
			throw new Error("Worker agent mailbox contains invalid task failure state.");
		}
		if (failedAt !== undefined && (task === undefined || repliedAt !== undefined || replyReceipt !== undefined)) {
			throw new Error("Worker agent mailbox contains invalid task failure state.");
		}
		if ((repliedAt === undefined) !== (replyReceipt === undefined)) {
			throw new Error("Worker agent mailbox replied message is missing its durable reply receipt.");
		}
		return {
			...message,
			createdAt,
			...(deliveredAt ? { deliveredAt } : {}),
			...(repliedAt ? { repliedAt } : {}),
			...(replyReceipt ? { replyReceipt } : {}),
			...(failedAt ? { failedAt, failureReason: message.failureReason } : {}),
			...(task ? { task } : {}),
		};
	});
	if (new Set(messages.map((message) => message.messageId)).size !== messages.length) {
		throw new Error("Worker agent mailbox contains duplicate message identities.");
	}
	const pendingMessages = messages.filter(isPendingMessage);
	if (pendingMessages.filter((message) => !hasExternalReplayAuthority(message)).length > MAX_MAILBOX_MESSAGES)
		throw new Error("Worker agent mailbox exceeds its pending-message bound.");
	if (pendingMessages.filter(hasExternalReplayAuthority).length > MAX_MAILBOX_MESSAGES) {
		throw new Error("Worker agent mailbox exceeds its mandatory pending-message bound.");
	}
	if (messages.length > MAX_MAILBOX_RETAINED_MESSAGES)
		throw new Error("Worker agent mailbox exceeds its retained-message bound.");
	if (messages.filter(usesMandatoryRetainedReserve).length > MAX_MANDATORY_RETAINED_MESSAGES) {
		throw new Error("Worker agent mailbox exceeds its mandatory retained-message reserve.");
	}
	if (messages.filter((message) => !usesMandatoryRetainedReserve(message)).length > MAX_ORDINARY_RETAINED_MESSAGES) {
		throw new Error("Worker agent mailbox exceeds its ordinary retained-message bound.");
	}
	if (state.replyAcknowledgements !== undefined && !Array.isArray(state.replyAcknowledgements)) {
		throw new Error("Worker agent mailbox contains invalid reply acknowledgement state.");
	}
	const messagesById = new Map(messages.map((message) => [message.messageId, message]));
	const acknowledgedMessageIds = new Set<string>();
	const acknowledgementIds = new Set<string>();
	const replyAcknowledgements = (state.replyAcknowledgements ?? []).map(
		(acknowledgement): WorkerReplyAcknowledgement => {
			if (
				!acknowledgement ||
				typeof acknowledgement !== "object" ||
				Array.isArray(acknowledgement) ||
				typeof acknowledgement.messageId !== "string" ||
				acknowledgement.messageId.length === 0 ||
				acknowledgement.messageId.length > MAX_MAILBOX_MESSAGE_ID_CHARS ||
				typeof acknowledgement.acknowledgementId !== "string" ||
				acknowledgement.acknowledgementId.length === 0 ||
				acknowledgement.acknowledgementId.length > MAX_MAILBOX_MESSAGE_ID_CHARS ||
				typeof acknowledgement.replyContent !== "string" ||
				acknowledgement.replyContent.length === 0 ||
				acknowledgement.replyContent.length > MAX_MAILBOX_MESSAGE_CHARS ||
				acknowledgement.replyContent.trim() !== acknowledgement.replyContent ||
				acknowledgedMessageIds.has(acknowledgement.messageId) ||
				acknowledgementIds.has(acknowledgement.acknowledgementId)
			) {
				throw new Error("Worker agent mailbox contains invalid reply acknowledgement state.");
			}
			const message = messagesById.get(acknowledgement.messageId);
			if (
				!message ||
				message.deliveredAt === undefined ||
				message.expectReply !== true ||
				message.repliedAt === undefined ||
				message.replyReceipt?.replyMessageId !== acknowledgement.acknowledgementId ||
				message.replyReceipt.contentDigest !== replyIntentDigest(acknowledgement.replyContent)
			) {
				throw new Error("Worker agent mailbox reply acknowledgement does not reference a retained request.");
			}
			acknowledgedMessageIds.add(acknowledgement.messageId);
			acknowledgementIds.add(acknowledgement.acknowledgementId);
			return {
				messageId: acknowledgement.messageId,
				acknowledgementId: acknowledgement.acknowledgementId,
				replyContent: acknowledgement.replyContent,
			};
		},
	);
	if (state.replayReceipts !== undefined && !Array.isArray(state.replayReceipts)) {
		throw new Error("Worker agent mailbox contains invalid replay receipt state.");
	}
	const replayIdentities = new Set<string>();
	const replyMessageIds = new Set<string>();
	const replayReceipts = (state.replayReceipts ?? []).map((receipt): WorkerMailboxReplayReceipt => {
		if (
			!receipt ||
			typeof receipt !== "object" ||
			Array.isArray(receipt) ||
			typeof receipt.messageId !== "string" ||
			!receipt.messageId ||
			receipt.messageId.length > MAX_MAILBOX_MESSAGE_ID_CHARS
		) {
			throw new Error("Worker agent mailbox contains invalid replay receipt state.");
		}
		const replayIdentity = `${String(receipt.kind)}:${receipt.messageId}`;
		if (replayIdentities.has(replayIdentity)) {
			throw new Error("Worker agent mailbox contains duplicate replay receipt identities.");
		}
		replayIdentities.add(replayIdentity);
		if (receipt.kind === "control") {
			if (
				typeof receipt.intentDigest !== "string" ||
				!CONTENT_DIGEST_PATTERN.test(receipt.intentDigest) ||
				!Object.keys(receipt).every(
					(field) =>
						field === "kind" || field === "messageId" || field === "intentDigest" || field === "deliveredAt",
				)
			) {
				throw new Error("Worker agent mailbox contains invalid control replay receipt state.");
			}
			const deliveredAt =
				receipt.deliveredAt === undefined
					? undefined
					: requiredMailboxTimestamp(receipt.deliveredAt, "replay delivery timestamp");
			return controlReplayReceipt(receipt.messageId, receipt.intentDigest, deliveredAt);
		}
		if (
			receipt.kind !== "reply" ||
			!Object.keys(receipt).every(
				(field) =>
					field === "kind" ||
					field === "messageId" ||
					field === "replyMessageId" ||
					field === "requestSenderId" ||
					field === "contentDigest",
			)
		) {
			throw new Error("Worker agent mailbox contains invalid reply replay receipt state.");
		}
		const replyReceipt = parseReplyReceiptFields(
			receipt as unknown as Record<string, unknown>,
			"reply replay receipt state",
		);
		if (replyMessageIds.has(replyReceipt.replyMessageId)) {
			throw new Error("Worker agent mailbox contains duplicate reply replay identities.");
		}
		replyMessageIds.add(replyReceipt.replyMessageId);
		return {
			kind: "reply",
			messageId: receipt.messageId,
			...replyReceipt,
		};
	});
	if (replayReceipts.length > MAX_MAILBOX_REPLAY_RECEIPTS) {
		throw new Error("Worker agent mailbox exceeds its replay receipt bound.");
	}
	if (replayReceipts.filter((receipt) => receipt.kind === "control").length > MAX_REPLAY_EVIDENCE_SLOTS) {
		throw new Error("Worker agent mailbox exceeds its control replay receipt bound.");
	}
	if (
		replayReceipts.length +
			messages.filter((message) => message.expectReply === true && message.repliedAt === undefined).length >
		MAX_MAILBOX_REPLAY_RECEIPTS
	) {
		throw new Error("Worker agent mailbox exceeds its projected replay evidence bound.");
	}
	for (const message of messages) {
		const controlReceipt = controlReplayReceiptFor(replayReceipts, message.messageId);
		if (controlReceipt && controlReceipt.deliveredAt !== message.deliveredAt) {
			throw new Error("Worker agent mailbox control delivery conflicts with its durable replay receipt.");
		}
		if (message.replyReceipt) {
			const replyReceipt = replyReplayReceiptFor(replayReceipts, message.messageId);
			if (
				!replyReceipt ||
				replyReceipt.replyMessageId !== message.replyReceipt.replyMessageId ||
				replyReceipt.requestSenderId !== message.replyReceipt.requestSenderId ||
				replyReceipt.contentDigest !== message.replyReceipt.contentDigest
			) {
				throw new Error("Worker agent mailbox reply conflicts with its durable replay receipt.");
			}
		}
	}
	return { version: 1, parentSessionId, agentId, messages, replyAcknowledgements, replayReceipts };
}

function normalizeOptionalIdentity(value: string | undefined, label: string): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_MAILBOX_IDENTITY_CHARS) {
		throw new TypeError(`Worker control ${label} is invalid.`);
	}
	return normalized;
}

export function normalizeWorkerAgentDependencyTaskIds(value: unknown): readonly string[] {
	return parseBoundedStringArray(value === undefined ? [] : value, {
		maxEntries: MAX_ORCHESTRATION_COLLECTION_LENGTH,
		maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		trim: true,
		invalidMessage: "Worker dependency task ids must contain bounded, non-empty strings.",
		duplicateMessage: "Worker dependency task ids must contain unique strings.",
		createError: (message) => new TypeError(message),
	});
}

function normalizeTaskMetadata(task: WorkerAgentTaskMetadata | undefined): WorkerAgentTaskMetadata | undefined {
	if (task === undefined) return undefined;
	if (task.kind === "agent_turn") {
		const dependsOnTaskIds = normalizeWorkerAgentDependencyTaskIds(task.dependsOnTaskIds);
		return {
			kind: "agent_turn",
			...(dependsOnTaskIds.length > 0 ? { dependsOnTaskIds } : {}),
		};
	}
	const sourceAttemptId = normalizeOptionalIdentity(task.sourceAttemptId, "terminal source attempt id");
	if (!sourceAttemptId) throw new TypeError("Worker terminal source attempt id is invalid.");
	return { kind: "terminal_handoff", sourceAttemptId };
}

function sameTaskMetadata(
	left: WorkerAgentTaskMetadata | undefined,
	right: WorkerAgentTaskMetadata | undefined,
): boolean {
	if (left?.kind !== right?.kind) return false;
	if (left?.kind === "agent_turn" && right?.kind === "agent_turn") {
		const leftDependencies = left.dependsOnTaskIds ?? [];
		const rightDependencies = right.dependsOnTaskIds ?? [];
		return (
			leftDependencies.length === rightDependencies.length &&
			leftDependencies.every((dependencyId, index) => dependencyId === rightDependencies[index])
		);
	}
	if (left?.kind === "terminal_handoff" && right?.kind === "terminal_handoff") {
		return left.sourceAttemptId === right.sourceAttemptId;
	}
	return true;
}

function hasExternalReplayAuthority(message: Pick<WorkerAgentMessage, "replyToMessageId" | "task">): boolean {
	return message.replyToMessageId !== undefined || message.task?.kind === "terminal_handoff";
}

function isPendingMessage(message: Pick<WorkerAgentMessage, "deliveredAt" | "failedAt">): boolean {
	return message.deliveredAt === undefined && message.failedAt === undefined;
}

function usesMandatoryRetainedReserve(message: WorkerAgentMessage): boolean {
	return isPendingMessage(message) && hasExternalReplayAuthority(message);
}

function projectedReplayEvidenceSlots(state: WorkerAgentMailboxState): number {
	return (
		state.replayReceipts.length +
		state.messages.filter((message) => message.expectReply === true && message.repliedAt === undefined).length
	);
}

function normalizeReplyAcknowledgement(
	messageId: string,
	acknowledgementId: string,
): WorkerReplyAcknowledgementIdentity {
	const normalizedMessageId = messageId.trim();
	if (!normalizedMessageId || normalizedMessageId.length > MAX_MAILBOX_MESSAGE_ID_CHARS) {
		throw new TypeError("A worker control message id is invalid.");
	}
	const normalizedAcknowledgementId = acknowledgementId.trim();
	if (!normalizedAcknowledgementId || normalizedAcknowledgementId.length > MAX_MAILBOX_MESSAGE_ID_CHARS) {
		throw new TypeError("A worker reply acknowledgement id is invalid.");
	}
	return { messageId: normalizedMessageId, acknowledgementId: normalizedAcknowledgementId };
}

function normalizeReplyContent(replyContent: string): string {
	const normalized = replyContent.trim();
	if (!normalized || normalized.length > MAX_MAILBOX_MESSAGE_CHARS) {
		throw new TypeError(
			`Worker reply content must contain from 1 through ${MAX_MAILBOX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`,
		);
	}
	return normalized;
}

function pruneDeliveredHistory(
	parentSessionId: string,
	agentId: string,
	messages: readonly WorkerAgentMessage[],
	replyAcknowledgements: readonly WorkerReplyAcknowledgement[],
	replayReceipts: readonly WorkerMailboxReplayReceipt[],
	ordinaryAdmission: boolean,
): { messages: WorkerAgentMessage[]; replayReceipts: WorkerMailboxReplayReceipt[] } {
	const protectedReplyIds = new Set(replyAcknowledgements.map((acknowledgement) => acknowledgement.messageId));
	const protectedMessages = messages.filter(
		(message) =>
			isPendingMessage(message) ||
			(message.expectReply === true && message.repliedAt === undefined) ||
			protectedReplyIds.has(message.messageId),
	);
	const protectedMandatory = protectedMessages.filter(usesMandatoryRetainedReserve);
	const protectedOrdinary = protectedMessages.filter((message) => !usesMandatoryRetainedReserve(message));
	if (protectedMandatory.length > MAX_MANDATORY_RETAINED_MESSAGES) {
		throw new Error("Worker agent mailbox mandatory retained-message reserve is exhausted.");
	}
	if (protectedOrdinary.length > MAX_ORDINARY_RETAINED_MESSAGES) {
		throw new Error("Worker agent mailbox ordinary retained-message capacity is exhausted.");
	}
	const retainedIds = new Set(protectedMessages.map((message) => message.messageId));
	const deliveredCandidates = messages.filter(
		(message) =>
			(message.deliveredAt !== undefined || message.failedAt !== undefined) && !retainedIds.has(message.messageId),
	);
	const remainingOrdinarySlots = MAX_ORDINARY_RETAINED_MESSAGES - protectedOrdinary.length;
	const recentDelivered = remainingOrdinarySlots > 0 ? deliveredCandidates.slice(-remainingOrdinarySlots) : [];
	let retained = [...protectedMessages, ...recentDelivered].sort((left, right) =>
		left.createdAt.localeCompare(right.createdAt),
	);
	const retainedReplayReceipts = [...replayReceipts];
	while (true) {
		const state = {
			version: 1,
			parentSessionId,
			agentId,
			messages: retained,
			replyAcknowledgements: [...replyAcknowledgements],
			replayReceipts: retainedReplayReceipts,
		} satisfies WorkerAgentMailboxState;
		const encodedBytes = ordinaryAdmission ? ordinaryAdmissionEncodedBytes(state) : encodedStateBytes(state);
		const encodedLimit = ordinaryAdmission ? MAX_ORDINARY_MAILBOX_BYTES : MAX_MAILBOX_BYTES;
		if (encodedBytes <= encodedLimit) break;
		const oldestCompletedIndex = retained.findIndex((message) => !retainedIds.has(message.messageId));
		if (oldestCompletedIndex >= 0) {
			retained = retained.filter((_, index) => index !== oldestCompletedIndex);
			continue;
		}
		break;
	}
	return { messages: retained, replayReceipts: retainedReplayReceipts };
}

function encodedStateBytes(state: WorkerAgentMailboxState): number {
	return Buffer.byteLength(`${JSON.stringify(state)}\n`, "utf-8");
}

function ordinaryAdmissionEncodedBytes(state: WorkerAgentMailboxState): number {
	const projectedDeliveryIds = new Set(
		state.messages
			.filter(
				(message) =>
					message.deliveredAt === undefined &&
					message.failedAt === undefined &&
					!hasExternalReplayAuthority(message),
			)
			.map((message) => message.messageId),
	);
	return encodedStateBytes({
		...state,
		messages: state.messages.map((message) =>
			projectedDeliveryIds.has(message.messageId)
				? { ...message, deliveredAt: MAX_MAILBOX_TRANSITION_TIMESTAMP }
				: message,
		),
		replayReceipts: state.replayReceipts.map((receipt) =>
			receipt.kind === "control" && receipt.deliveredAt === undefined && projectedDeliveryIds.has(receipt.messageId)
				? { ...receipt, deliveredAt: MAX_MAILBOX_TRANSITION_TIMESTAMP }
				: receipt,
		),
	});
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
		task?: WorkerAgentTaskMetadata;
	}): WorkerAgentMessage {
		const accepted = this.enqueueWithReceipt(input);
		if (accepted.status !== "retained") throw new Error("Unkeyed worker control unexpectedly resolved as a replay.");
		return accepted.message;
	}

	/** Enqueue with exact creation evidence for an idempotent surrounding acceptance flow. */
	enqueueWithReceipt(input: {
		kind: WorkerAgentMessageKind;
		content: string;
		senderAgentId?: string;
		threadId?: string;
		replyToMessageId?: string;
		expectReply?: boolean;
		task?: WorkerAgentTaskMetadata;
		idempotencyKey?: string;
	}): WorkerAgentEnqueueReceipt {
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
		const task = normalizeTaskMetadata(input.task);
		const idempotencyKey = input.idempotencyKey?.trim();
		if (
			input.idempotencyKey !== undefined &&
			(!idempotencyKey || idempotencyKey.length > MAX_MAILBOX_IDEMPOTENCY_KEY_CHARS)
		) {
			throw new TypeError("Worker control idempotency key is invalid.");
		}
		const message: WorkerAgentMessage = {
			messageId: idempotencyKey
				? workerAgentMessageId(this.parentSessionId, idempotencyKey)
				: `worker-message-${randomUUID()}`,
			kind: input.kind,
			content,
			...(senderAgentId ? { senderAgentId } : {}),
			...(threadId ? { threadId } : {}),
			...(replyToMessageId ? { replyToMessageId } : {}),
			...(input.expectReply === true ? { expectReply: true } : {}),
			...(task ? { task } : {}),
			createdAt: new Date().toISOString(),
		};
		const intentDigest = idempotencyKey ? controlIntentDigest(message) : undefined;
		const externallyReplayOwned = hasExternalReplayAuthority(message);
		let queued = message;
		let created = false;
		let completedReplay = false;
		this.update(
			(state) => {
				const existing = state.messages.find((candidate) => candidate.messageId === message.messageId);
				const replayReceipt = controlReplayReceiptFor(state.replayReceipts, message.messageId);
				const addsControlReceipt =
					intentDigest !== undefined && !externallyReplayOwned && replayReceipt === undefined;
				if (
					addsControlReceipt &&
					state.replayReceipts.filter((receipt) => receipt.kind === "control").length >= MAX_REPLAY_EVIDENCE_SLOTS
				) {
					throw new Error(
						`Worker agent mailbox control replay receipt capacity reached its ${MAX_REPLAY_EVIDENCE_SLOTS} entry limit.`,
					);
				}
				if (existing) {
					// `kind` is the delivery-mode projection at first acceptance. It is deliberately not
					// part of task intent and is never rewritten when a retry observes a different live
					// activity state. The durable `task` identity owns whether an idle turn is required.
					const sameIntent =
						existing.content === message.content &&
						existing.senderAgentId === message.senderAgentId &&
						existing.threadId === message.threadId &&
						existing.replyToMessageId === message.replyToMessageId &&
						existing.expectReply === message.expectReply &&
						sameTaskMetadata(existing.task, message.task);
					if (!sameIntent)
						throw new Error("Worker control idempotency identity conflicts with an existing message.");
					if (intentDigest && replayReceipt && replayReceipt.intentDigest !== intentDigest) {
						throw new Error("Worker control idempotency identity conflicts with its durable replay receipt.");
					}
					queued = existing;
					return intentDigest && !externallyReplayOwned && !replayReceipt
						? {
								...state,
								replayReceipts: [
									...state.replayReceipts,
									controlReplayReceipt(message.messageId, intentDigest, existing.deliveredAt),
								],
							}
						: state;
				}
				if (replayReceipt) {
					if (!intentDigest || replayReceipt.intentDigest !== intentDigest) {
						throw new Error("Worker control idempotency identity conflicts with its durable replay receipt.");
					}
					completedReplay = true;
					return state;
				}
				const pending = state.messages.filter(
					(candidate) => candidate.deliveredAt === undefined && candidate.failedAt === undefined,
				);
				if (
					pending.filter((candidate) => hasExternalReplayAuthority(candidate) === externallyReplayOwned).length >=
					MAX_MAILBOX_MESSAGES
				) {
					throw new Error(
						externallyReplayOwned
							? `Worker agent mailbox reached its ${MAX_MAILBOX_MESSAGES} mandatory message limit.`
							: `Worker agent mailbox reached its ${MAX_MAILBOX_MESSAGES} message limit.`,
					);
				}
				created = true;
				return {
					...state,
					messages: [...state.messages, message],
					...(intentDigest && !externallyReplayOwned
						? {
								replayReceipts: [
									...state.replayReceipts,
									controlReplayReceipt(message.messageId, intentDigest),
								],
							}
						: {}),
				};
			},
			!externallyReplayOwned,
			true,
		);
		if (created) this.notify();
		if (completedReplay) return { status: "completed_replay", messageId: message.messageId, created: false };
		return { status: "retained", messageId: queued.messageId, message: structuredClone(queued), created };
	}

	pending(kind?: WorkerAgentMessageKind): WorkerAgentMessage[] {
		return this.read()
			.messages.filter(
				(message) =>
					message.deliveredAt === undefined &&
					message.failedAt === undefined &&
					(kind === undefined || message.kind === kind),
			)
			.map((message) => structuredClone(message));
	}

	/** Oldest-first executable intents that have not reached the durable transcript boundary. */
	pendingTaskBearing(): WorkerAgentMessage[] {
		return this.pending().filter((message) => message.task !== undefined);
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

	getMessage(messageId: string): WorkerAgentMessage | undefined {
		const normalized = messageId.trim();
		if (!normalized) throw new TypeError("A worker control message id is required.");
		const message = this.read().messages.find((candidate) => candidate.messageId === normalized);
		return message ? structuredClone(message) : undefined;
	}

	hasControlReplayReceipt(messageId: string): boolean {
		const normalized = messageId.trim();
		if (!normalized) throw new TypeError("A worker control message id is required.");
		return controlReplayReceiptFor(this.read().replayReceipts, normalized) !== undefined;
	}

	hasDeliveredControlReceipt(messageId: string): boolean {
		const normalized = messageId.trim();
		if (!normalized) throw new TypeError("A worker control message id is required.");
		const state = this.read();
		const message = state.messages.find((candidate) => candidate.messageId === normalized);
		return (
			message?.deliveredAt !== undefined ||
			controlReplayReceiptFor(state.replayReceipts, normalized)?.deliveredAt !== undefined
		);
	}

	resolveCompletedReply(messageId: string, content: string): WorkerReplyReceipt | undefined {
		const normalized = messageId.trim();
		if (!normalized) throw new TypeError("A worker control message id is required.");
		const normalizedContent = normalizeReplyContent(content);
		const state = this.read();
		const request = state.messages.find((candidate) => candidate.messageId === normalized);
		const receipt = request?.replyReceipt ?? replyReplayReceiptFor(state.replayReceipts, normalized);
		if (!receipt) return undefined;
		if (receipt.contentDigest !== replyIntentDigest(normalizedContent)) {
			throw new Error("Worker reply identity conflicts with its durable source receipt.");
		}
		return {
			replyMessageId: receipt.replyMessageId,
			requestSenderId: receipt.requestSenderId,
			contentDigest: receipt.contentDigest,
		};
	}

	getReplyAcknowledgementId(messageId: string): string | undefined {
		const normalized = messageId.trim();
		if (!normalized) throw new TypeError("A worker control message id is required.");
		return this.read().replyAcknowledgements.find((acknowledgement) => acknowledgement.messageId === normalized)
			?.acknowledgementId;
	}

	listReplyAcknowledgements(): WorkerReplyAcknowledgement[] {
		return this.read().replyAcknowledgements.map((acknowledgement) => ({ ...acknowledgement }));
	}

	/**
	 * Mark one request replied while retaining the exact target receipt until transcript consumption.
	 * The acknowledgement id is the durable target reply id, so a retry adopts a crash-left marker.
	 */
	beginReplyAcknowledgement(messageId: string, acknowledgementId: string, replyContent: string): boolean {
		const normalized = normalizeReplyAcknowledgement(messageId, acknowledgementId);
		const normalizedContent = normalizeReplyContent(replyContent);
		const contentDigest = replyIntentDigest(normalizedContent);
		let acquired = false;
		let changed = false;
		this.update((state) => {
			const request = state.messages.find((message) => message.messageId === normalized.messageId);
			if (!request || request.deliveredAt === undefined || request.expectReply !== true) return state;
			if (!request.senderAgentId) {
				throw new Error("Worker reply request has no routable requester.");
			}
			const receipt: WorkerReplyReceipt = {
				replyMessageId: normalized.acknowledgementId,
				requestSenderId: request.senderAgentId,
				contentDigest,
			};
			const durableReceipt = replyReplayReceiptFor(state.replayReceipts, normalized.messageId);
			if (
				durableReceipt &&
				(durableReceipt.replyMessageId !== receipt.replyMessageId ||
					durableReceipt.requestSenderId !== receipt.requestSenderId ||
					durableReceipt.contentDigest !== receipt.contentDigest)
			) {
				throw new Error("Worker reply identity conflicts with its durable replay receipt.");
			}
			const existing = state.replyAcknowledgements.find(
				(acknowledgement) =>
					acknowledgement.messageId === normalized.messageId ||
					acknowledgement.acknowledgementId === normalized.acknowledgementId,
			);
			if (existing) {
				if (
					existing.messageId !== normalized.messageId ||
					existing.acknowledgementId !== normalized.acknowledgementId
				) {
					throw new Error("Worker reply acknowledgement identity conflicts with an active transaction.");
				}
				if (
					request?.replyReceipt?.replyMessageId !== receipt.replyMessageId ||
					request.replyReceipt.requestSenderId !== receipt.requestSenderId ||
					request.replyReceipt.contentDigest !== receipt.contentDigest ||
					existing.replyContent !== normalizedContent
				) {
					throw new Error("Worker reply content conflicts with its active acknowledgement transaction.");
				}
				acquired = true;
				return state;
			}
			if (request.repliedAt !== undefined) return state;
			acquired = true;
			changed = true;
			return {
				...state,
				messages: state.messages.map((message) =>
					message.messageId === normalized.messageId
						? {
								...message,
								repliedAt: transitionTimestamp(message.deliveredAt ?? message.createdAt),
								replyReceipt: receipt,
							}
						: message,
				),
				replyAcknowledgements: [...state.replyAcknowledgements, { ...normalized, replyContent: normalizedContent }],
				replayReceipts: durableReceipt
					? state.replayReceipts
					: [...state.replayReceipts, { kind: "reply", messageId: normalized.messageId, ...receipt }],
			};
		});
		if (changed) this.notify();
		return acquired;
	}

	/** Dead-letter only an ordinary executable turn with no reply or terminal-delivery obligation. */
	deadLetterOrdinaryTask(messageId: string, reason: string): boolean {
		const normalized = messageId.trim();
		const failureReason = reason.trim();
		if (!normalized) throw new TypeError("A worker control message id is required.");
		if (!failureReason || failureReason.length > MAX_MAILBOX_IDENTITY_CHARS) {
			throw new TypeError("A worker task failure reason is invalid.");
		}
		let changed = false;
		this.update(
			(state) => ({
				...state,
				messages: state.messages.map((message) => {
					if (
						message.messageId !== normalized ||
						message.task?.kind !== "agent_turn" ||
						message.replyToMessageId !== undefined ||
						message.expectReply === true ||
						message.deliveredAt !== undefined ||
						message.failedAt !== undefined
					) {
						return message;
					}
					changed = true;
					return { ...message, failedAt: transitionTimestamp(message.createdAt), failureReason };
				}),
			}),
			true,
		);
		if (changed) this.notify();
		return changed;
	}

	/** Commit one exact reply acknowledgement and release its protected history slot. */
	commitReplyAcknowledgement(messageId: string, acknowledgementId: string): boolean {
		return this.finishReplyAcknowledgement(messageId, acknowledgementId, false);
	}

	/** Roll back one exact reply acknowledgement without clearing a later or unrelated reply. */
	rollbackReplyAcknowledgement(messageId: string, acknowledgementId: string): boolean {
		return this.finishReplyAcknowledgement(messageId, acknowledgementId, true);
	}

	private markTimestamp(messageId: string, field: "deliveredAt"): boolean {
		const normalized = messageId.trim();
		if (!normalized) throw new TypeError("A worker control message id is required.");
		let changed = false;
		this.update((state) => {
			let deliveredAt: string | undefined;
			const messages: WorkerAgentMessage[] = state.messages.map((message) => {
				if (message.messageId !== normalized || message[field] !== undefined || message.failedAt !== undefined) {
					return message;
				}
				changed = true;
				deliveredAt = transitionTimestamp(message.createdAt);
				return { ...message, [field]: deliveredAt };
			});
			if (!changed || !deliveredAt) return state;
			return {
				...state,
				messages,
				replayReceipts: state.replayReceipts.map((receipt) =>
					receipt.kind === "control" && receipt.messageId === normalized ? { ...receipt, deliveredAt } : receipt,
				),
			};
		});
		if (changed) this.notify();
		return changed;
	}

	private finishReplyAcknowledgement(messageId: string, acknowledgementId: string, rollback: boolean): boolean {
		const normalized = normalizeReplyAcknowledgement(messageId, acknowledgementId);
		let changed = false;
		this.update((state) => {
			const acknowledgement = state.replyAcknowledgements.find(
				(candidate) =>
					candidate.messageId === normalized.messageId &&
					candidate.acknowledgementId === normalized.acknowledgementId,
			);
			if (!acknowledgement) return state;
			changed = true;
			const messages = rollback
				? state.messages.map((message) => {
						if (message.messageId !== normalized.messageId || message.repliedAt === undefined) return message;
						const restored = { ...message };
						delete restored.repliedAt;
						delete restored.replyReceipt;
						return restored;
					})
				: state.messages;
			return {
				...state,
				messages,
				replyAcknowledgements: state.replyAcknowledgements.filter((candidate) => candidate !== acknowledgement),
				...(rollback
					? {
							replayReceipts: state.replayReceipts.filter(
								(receipt) => receipt.kind !== "reply" || receipt.messageId !== normalized.messageId,
							),
						}
					: {}),
			};
		});
		if (changed) this.notify();
		return changed;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Mailbox subscribers are advisory; durable mutation results remain authoritative.
			}
		}
	}

	private read(): WorkerAgentMailboxState {
		if (!existsSync(this.file)) {
			return {
				version: 1,
				parentSessionId: this.parentSessionId,
				agentId: this.agentId,
				messages: [],
				replyAcknowledgements: [],
				replayReceipts: [],
			};
		}
		return parseState(
			readBoundedTextFileSync(this.file, MAX_MAILBOX_BYTES, "Worker agent mailbox durable size bound"),
			this.parentSessionId,
			this.agentId,
		);
	}

	private update(
		mutator: (state: WorkerAgentMailboxState) => WorkerAgentMailboxState,
		ordinaryAdmission = false,
		replayEvidenceAdmission = false,
	): void {
		withFileLockSync(this.file, () => {
			const state = this.read();
			const previousOrdinaryBytes = ordinaryAdmissionEncodedBytes(state);
			const previousReplayEvidenceSlots = projectedReplayEvidenceSlots(state);
			const mutated = mutator(state);
			const retained = pruneDeliveredHistory(
				this.parentSessionId,
				this.agentId,
				mutated.messages,
				mutated.replyAcknowledgements,
				mutated.replayReceipts,
				ordinaryAdmission,
			);
			const next = {
				...mutated,
				messages: retained.messages,
				replayReceipts: retained.replayReceipts,
			};
			const addedReplayReceipt = mutated.replayReceipts.length > state.replayReceipts.length;
			const bytesWithoutAddedReceipt = addedReplayReceipt
				? encodedStateBytes({ ...next, replayReceipts: next.replayReceipts.slice(0, -1) })
				: undefined;
			const changed = JSON.stringify(next) !== JSON.stringify(state);
			const nextOrdinaryBytes = ordinaryAdmissionEncodedBytes(next);
			if (
				ordinaryAdmission &&
				changed &&
				nextOrdinaryBytes > MAX_ORDINARY_MAILBOX_BYTES &&
				nextOrdinaryBytes > previousOrdinaryBytes
			) {
				throw new Error(
					addedReplayReceipt
						? "Worker agent mailbox replay receipt storage exhausted its mandatory control byte reserve."
						: "Worker agent mailbox passive control storage exhausted its mandatory control byte reserve.",
				);
			}
			const nextReplayEvidenceSlots = projectedReplayEvidenceSlots(next);
			if (nextReplayEvidenceSlots > MAX_MAILBOX_REPLAY_RECEIPTS) {
				throw new Error("Worker agent mailbox exceeds its projected replay evidence bound.");
			}
			if (
				replayEvidenceAdmission &&
				nextReplayEvidenceSlots > MAX_REPLAY_EVIDENCE_SLOTS &&
				nextReplayEvidenceSlots > previousReplayEvidenceSlots
			) {
				throw new Error(
					`Worker agent mailbox replay evidence capacity reached its ${MAX_REPLAY_EVIDENCE_SLOTS} slot limit.`,
				);
			}
			assertWorkerAgentMailboxBounds(
				next.messages.length,
				next.replayReceipts.length,
				state.replayReceipts.length,
				encodedStateBytes(next),
				bytesWithoutAddedReceipt,
			);
			if (changed) writeFileAtomicSync(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
		});
	}
}
