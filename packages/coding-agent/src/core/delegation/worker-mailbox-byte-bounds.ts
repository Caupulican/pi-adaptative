/** Encoded storage and transition reserves for worker mail, including its pending reply acknowledgements. */
import { MAX_TURN_ORIGIN_CHANNEL_CHARS, MAX_TURN_ORIGIN_REF_CHARS } from "../../kernel/turn-origin-stamp.ts";
import { MAX_KNOWLEDGE_GRANT_REFERENCES } from "../memory/knowledge-grant.ts";
import {
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_WORKER_AUTHORITY_PATH_LENGTH,
} from "../orchestration/contracts.ts";
import { encodeWorkerBrief } from "../orchestration/worker-brief-attachment.ts";
import { type MailboxBodyEncoder, mailboxStorageCharge } from "./replay-safe-mailbox-bounds.ts";
import type { WorkerAgentMailboxState } from "./worker-agent-control.ts";
import { INLINE_WORKER_MESSAGE_CHARS } from "./worker-agent-message-options.ts";

export const MAX_MAILBOX_IDENTITY_CHARS = 512;
export const MAX_MAILBOX_MESSAGE_ID_CHARS = 512;
export const MAX_ORDINARY_MAILBOX_BYTES = 128 * 1024;
/** Before attachments, version-one task-bearing messages could carry 16 Ki code units directly. */
const INLINE_WORKER_TASK_CHARS = MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH;
export function workerMailboxInlineLimit(task: unknown): number {
	return task === undefined ? INLINE_WORKER_MESSAGE_CHARS : INLINE_WORKER_TASK_CHARS;
}

function projectMailbox(state: WorkerAgentMailboxState, body: MailboxBodyEncoder) {
	return {
		...state,
		messages: state.messages.map((entry) => ({
			...entry,
			content: body(entry.content, workerMailboxInlineLimit(entry.task)),
		})),
		replyAcknowledgements: state.replyAcknowledgements.map((entry) => ({
			...entry,
			replyContent: body(entry.replyContent, INLINE_WORKER_MESSAGE_CHARS),
		})),
	};
}

export function encodeWorkerMailbox(state: WorkerAgentMailboxState): unknown {
	return projectMailbox(state, encodeWorkerBrief);
}

export function workerMailboxStorageCharge(
	state: WorkerAgentMailboxState,
	ordinary = false,
	wireBytes?: number,
): number {
	return mailboxStorageCharge((body) => projectMailbox(state, body), ordinary ? 1 : 2, 1, wireBytes);
}

export const MAX_MAILBOX_TRANSITION_TIMESTAMP = "9999-12-31T23:59:59.999Z";
const MAX_ENCODED_MANDATORY_MESSAGE_BYTES =
	Buffer.byteLength(
		JSON.stringify({
			messageId: `worker-message-${"f".repeat(64)}`,
			kind: "follow_up",
			env: { v: 1, k: "follow_up" },
			content: `c${"\0".repeat(INLINE_WORKER_TASK_CHARS - 1)}`,
			senderAgentId: `s${"\0".repeat(MAX_MAILBOX_IDENTITY_CHARS - 1)}`,
			threadId: `t${"\0".repeat(MAX_MAILBOX_IDENTITY_CHARS - 1)}`,
			replyToMessageId: `r${"\0".repeat(MAX_MAILBOX_MESSAGE_ID_CHARS - 1)}`,
			expectReply: true,
			task: {
				kind: "terminal_handoff",
				sourceAttemptId: `a${"\0".repeat(MAX_MAILBOX_IDENTITY_CHARS - 1)}`,
				newTask: {
					knowledgeReferences: Array.from({ length: MAX_KNOWLEDGE_GRANT_REFERENCES }, (_, index) => ({
						id: index.toString(16).padStart(64, "0"),
						revision: Number.MAX_SAFE_INTEGER,
					})),
					goalId: `g${"\0".repeat(MAX_MAILBOX_IDENTITY_CHARS - 1)}`,
					requirementIds: Array.from(
						{ length: MAX_ORCHESTRATION_COLLECTION_LENGTH },
						(_, index) => `${index}${"\0".repeat(MAX_MAILBOX_IDENTITY_CHARS - 1)}`,
					),
					acceptanceCriterionIds: Array.from(
						{ length: MAX_ORCHESTRATION_COLLECTION_LENGTH },
						(_, index) => `${index}${"\0".repeat(MAX_MAILBOX_IDENTITY_CHARS - 1)}`,
					),
					resourcePointerIds: Array.from(
						{ length: MAX_ORCHESTRATION_COLLECTION_LENGTH },
						(_, index) => `${index}${"\0".repeat(MAX_MAILBOX_IDENTITY_CHARS - 1)}`,
					),
				},
			},
			receiptOrigin: {
				sessionId: "\0".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH),
				leafId: "\0".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH),
				sessionFile: "\0".repeat(MAX_WORKER_AUTHORITY_PATH_LENGTH),
			},
			turnOrigin: {
				v: 1,
				k: "goal-continuation",
				channel: "\0".repeat(MAX_TURN_ORIGIN_CHANNEL_CHARS),
				verified: true,
				thirdParty: true,
				ref: "\0".repeat(MAX_TURN_ORIGIN_REF_CHARS),
			},
			delegationObjectiveId: "\0".repeat(MAX_MAILBOX_IDENTITY_CHARS),
			createdAt: MAX_MAILBOX_TRANSITION_TIMESTAMP,
			deliveredAt: MAX_MAILBOX_TRANSITION_TIMESTAMP,
		}),
		"utf-8",
	) + 1;
// The additive reserve keeps every previously valid 128 KiB ordinary mailbox migration-safe and
// covers one maximum accepted source acknowledgement transaction (locked by the saturation tests).
const MAX_MANDATORY_TRANSITION_RESERVE_BYTES = Math.max(48 * 1024, MAX_ENCODED_MANDATORY_MESSAGE_BYTES + 1_024);
export const MAX_MAILBOX_BYTES = MAX_ORDINARY_MAILBOX_BYTES + MAX_MANDATORY_TRANSITION_RESERVE_BYTES;
