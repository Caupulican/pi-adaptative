/** Shared bounds for mailbox replay evidence, inline metadata, and attached message bodies. */
import { createHash } from "node:crypto";
import {
	type encodeWorkerBrief,
	MAX_WORKER_BRIEF_ATTACHMENT_BYTES,
	measureWorkerBriefFields,
} from "../orchestration/worker-brief-attachment.ts";
import { INLINE_WORKER_MESSAGE_CHARS } from "./worker-agent-message-options.ts";

export type MailboxBodyEncoder = typeof encodeWorkerBrief;

/** Retain the old inline/metadata budget and charge actual attachment bytes against bounded additional space. */
export function mailboxStorageCharge(
	project: (body: MailboxBodyEncoder) => unknown,
	allowance: 1 | 2,
	framingBytes = 1,
	wireBytes?: number,
): number {
	const { skeleton, attachmentDeltaBytes: attachmentBytes } = measureWorkerBriefFields(project);
	const inlineBytes =
		wireBytes === undefined
			? Buffer.byteLength(JSON.stringify(skeleton)) + framingBytes
			: wireBytes - attachmentBytes;
	return inlineBytes + Math.max(0, attachmentBytes - allowance * MAX_WORKER_BRIEF_ATTACHMENT_BYTES);
}

/** Long replies have no historical digests. Hash their exact UTF-16 code units without retaining text in a process cache. */
export function attachedReplyDigest(content: string): string | undefined {
	if (content.length <= INLINE_WORKER_MESSAGE_CHARS) return undefined;
	return createHash("sha256").update("pi-mailbox-reply-attachment-v1\0").update(content, "utf16le").digest("hex");
}

export type ReplaySafeMailboxBounder = (
	retainedEntryCount: number,
	replayReceiptCount: number,
	previousReplayReceiptCount: number,
	encodedBytes: number,
	encodedBytesWithoutNewestReplayReceipt?: number,
) => void;

/** Build one mailbox-specific guard that never converts capacity pressure into forgotten replay evidence. */
export function createReplaySafeMailboxBounder(
	mailboxLabel: string,
	maxRetainedEntries: number,
	maxReplayReceipts: number,
	maxEncodedBytes: number,
): ReplaySafeMailboxBounder {
	return (
		retainedEntryCount,
		replayReceiptCount,
		previousReplayReceiptCount,
		encodedBytes,
		encodedBytesWithoutNewestReplayReceipt,
	) => {
		if (replayReceiptCount > maxReplayReceipts) {
			throw new Error(`${mailboxLabel} replay receipt capacity reached its ${maxReplayReceipts} entry limit.`);
		}
		if (retainedEntryCount > maxRetainedEntries) {
			throw new Error(`${mailboxLabel} exceeds its durable size bound.`);
		}
		if (encodedBytes <= maxEncodedBytes) return;
		if (
			replayReceiptCount > previousReplayReceiptCount &&
			encodedBytesWithoutNewestReplayReceipt !== undefined &&
			encodedBytesWithoutNewestReplayReceipt <= maxEncodedBytes
		) {
			throw new Error(`${mailboxLabel} replay receipt storage capacity is exhausted.`);
		}
		throw new Error(`${mailboxLabel} exceeds its durable size bound.`);
	};
}
