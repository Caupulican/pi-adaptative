import { createHash } from "node:crypto";
import type { SessionEntry } from "./session-entries.ts";
import type { SessionMessageBatchEntry } from "./session-manager.ts";

export interface SessionAppendEntryIdentity {
	readonly id: string;
	readonly type: SessionEntry["type"];
	readonly parentId: string | null;
	readonly ownerInputId?: string;
	/** Original message object, including custom messages whose canonical row stores fields instead. */
	readonly source: object | undefined;
}

/** Exact append identity, captured before encoding can invoke external getters. */
export interface SessionAppendIdentity {
	readonly attempt: symbol;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly entries: readonly SessionAppendEntryIdentity[];
}

/** An attempted physical write: fingerprints describe the encoded rows, never a later source projection. */
export interface SessionAppendWriteIdentity extends SessionAppendIdentity {
	readonly entries: readonly (SessionAppendEntryIdentity & { readonly encodedDigest: string })[];
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
					parentId: entry.parentId,
					...(entry.type === "message" && entry.ownerInputId !== undefined
						? { ownerInputId: entry.ownerInputId }
						: {}),
					source: sourceMessages?.[index] ?? (entry.type === "message" ? entry.message : undefined),
				}),
			),
		),
	});
}

/** Only needed after uncertain I/O, using the exact rows retained by the writer. */
export function captureSessionAppendWriteIdentity(
	identity: SessionAppendIdentity,
	encodedEntries: readonly string[],
): SessionAppendWriteIdentity {
	if (identity.entries.length !== encodedEntries.length)
		throw new Error("Session write evidence does not match its encoded entry count.");
	return Object.freeze({
		...identity,
		entries: Object.freeze(
			identity.entries.map((entry, index) =>
				Object.freeze({
					...entry,
					encodedDigest: createHash("sha256").update(encodedEntries[index]!).digest("hex"),
				}),
			),
		),
	});
}

/** A physical write was attempted without a confirmed outcome; the original history needs reconciliation. */
export class SessionAppendUncertainError extends Error {
	readonly identity: SessionAppendWriteIdentity;

	constructor(identity: SessionAppendWriteIdentity, cause: unknown) {
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
