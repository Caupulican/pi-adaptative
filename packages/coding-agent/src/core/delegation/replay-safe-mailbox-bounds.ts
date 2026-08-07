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
