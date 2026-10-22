import type { SessionEntry } from "./session-entries.ts";
import type { SessionMessageBatchEntry } from "./session-manager.ts";

/** Exact canonical publication, distinct from a physical write whose outcome is still unknown. */
export interface SessionAppendReceipt {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly durability: "persisted" | "buffered" | "memory";
	readonly entries: readonly {
		readonly id: string;
		readonly type: SessionEntry["type"];
		/** Original message object, including custom messages whose canonical row stores fields instead. */
		readonly source: object | undefined;
	}[];
}

/** Publication succeeded; a later projection or notification failed. Retrying the append would duplicate it. */
export class SessionAppendCommittedError extends Error {
	readonly receipt: SessionAppendReceipt;

	constructor(receipt: SessionAppendReceipt, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "SessionAppendCommittedError";
		this.receipt = receipt;
	}
}

/** Match occurrences in order, never payload equality or the last receipt of a different append. */
export function receiptMatchesMessageBatch(
	receipt: SessionAppendReceipt,
	batch: readonly SessionMessageBatchEntry[],
): boolean {
	return (
		receipt.entries.length === batch.length &&
		receipt.entries.every((entry, index) => {
			const item = batch[index]!;
			return (
				entry.type === (item.kind === "message" ? "message" : "custom_message") && entry.source === item.message
			);
		})
	);
}
