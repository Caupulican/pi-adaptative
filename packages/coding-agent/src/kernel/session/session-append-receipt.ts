import type { SessionEntry } from "./session-entries.ts";
import type { SessionMessageBatchEntry } from "./session-manager.ts";

/** Exact append identity, captured before encoding can invoke external getters. */
export interface SessionAppendIdentity {
	readonly attempt: symbol;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly entries: readonly {
		readonly id: string;
		readonly type: SessionEntry["type"];
		/** Original message object, including custom messages whose canonical row stores fields instead. */
		readonly source: object | undefined;
	}[];
}

/** Exact canonical publication, distinct from a physical write whose outcome is still unknown. */
export interface SessionAppendReceipt extends SessionAppendIdentity {
	readonly durability: "persisted" | "buffered" | "memory";
}

/** One identity path for committed and unresolved append outcomes. */
export function captureSessionAppendIdentity(
	sessionId: string,
	sessionFile: string | undefined,
	entries: readonly SessionEntry[],
	sourceMessages?: readonly object[],
	attempt = Symbol("session append"),
): SessionAppendIdentity {
	return Object.freeze({
		attempt,
		sessionId,
		sessionFile,
		entries: Object.freeze(
			entries.map((entry, index) =>
				Object.freeze({
					id: entry.id,
					type: entry.type,
					source: sourceMessages?.[index] ?? (entry.type === "message" ? entry.message : undefined),
				}),
			),
		),
	});
}

/** A physical write was attempted without a confirmed outcome; the original history needs reconciliation. */
export class SessionAppendUncertainError extends Error {
	readonly identity: SessionAppendIdentity;

	constructor(identity: SessionAppendIdentity, cause: unknown) {
		super(
			"Session write outcome is unknown; reconcile the original session history before retrying these messages.",
			{
				cause,
			},
		);
		this.name = "SessionAppendUncertainError";
		this.identity = identity;
	}
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
	receipt: SessionAppendIdentity,
	batch: readonly SessionMessageBatchEntry[],
	attempt: symbol,
): boolean {
	return (
		receipt.attempt === attempt &&
		receipt.entries.length === batch.length &&
		receipt.entries.every((entry, index) => {
			const item = batch[index]!;
			return (
				entry.type === (item.kind === "message" ? "message" : "custom_message") && entry.source === item.message
			);
		})
	);
}
