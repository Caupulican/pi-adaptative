import type { Message } from "@caupulican/pi-ai";
import type { AgentMessage, AgentMessageOrigin } from "../../kernel/index.ts";
import {
	receiptMatchesMessageBatch,
	SessionAppendCommittedError,
} from "../../kernel/session/session-append-receipt.ts";

export type ModelRouterBufferedSessionMessage =
	| {
			kind: "message";
			message: Message;
			origin?: AgentMessageOrigin;
	  }
	| {
			kind: "custom";
			message: Extract<AgentMessage, { role: "custom" }>;
	  };

export type ModelRouterSessionBuffer = {
	messages: ModelRouterBufferedSessionMessage[];
	/** True after the complete routed turn has been accepted by the canonical session append owner. */
	committed: boolean;
	/** True after the prompt prefix was accepted; the storage receipt separately identifies physical durability. */
	prefixCommitted: boolean;
};

export function createModelRouterSessionBuffer(): ModelRouterSessionBuffer {
	return { messages: [], committed: false, prefixCommitted: false };
}

export function bufferModelRouterSessionMessage(
	buffer: ModelRouterSessionBuffer,
	message: Message,
	origin?: AgentMessageOrigin,
): void {
	buffer.messages.push({ kind: "message", message, ...(origin === undefined ? {} : { origin }) });
}

export function bufferModelRouterSessionCustomMessage(
	buffer: ModelRouterSessionBuffer,
	message: Extract<AgentMessage, { role: "custom" }>,
): void {
	buffer.messages.push({ kind: "custom", message });
}

export function flushModelRouterSessionBuffer(
	buffer: ModelRouterSessionBuffer,
	appendBatch: (entries: readonly ModelRouterBufferedSessionMessage[]) => readonly string[],
): Map<AgentMessage, string> {
	return flushBufferedMessages(buffer, appendBatch, false);
}

/** Commit only the prompt prefix before provider transport; later assistant/tool messages remain buffered. */
export function flushModelRouterSessionBufferPrefix(
	buffer: ModelRouterSessionBuffer,
	appendBatch: (entries: readonly ModelRouterBufferedSessionMessage[]) => readonly string[],
): Map<AgentMessage, string> {
	return flushBufferedMessages(buffer, appendBatch, true);
}

/** Synchronous append callbacks may add a suffix, but cannot publish the same prefix recursively. */
const publishingBuffers = new WeakSet<ModelRouterSessionBuffer>();

function flushBufferedMessages(
	buffer: ModelRouterSessionBuffer,
	appendBatch: (entries: readonly ModelRouterBufferedSessionMessage[]) => readonly string[],
	prefixOnly: boolean,
): Map<AgentMessage, string> {
	if (buffer.committed || (prefixOnly && buffer.prefixCommitted)) return new Map();
	if (publishingBuffers.has(buffer)) throw new Error("A routed session buffer is already being published.");
	publishingBuffers.add(buffer);
	try {
		const original = buffer.messages.slice();
		const entries = original.map((entry) => Object.freeze({ ...entry }));
		let ids: readonly string[] = [];
		let failure: SessionAppendCommittedError | undefined;
		if (entries.length > 0) {
			try {
				ids = appendBatch(entries);
			} catch (error) {
				if (!(error instanceof SessionAppendCommittedError) || !receiptMatchesMessageBatch(error.receipt, entries))
					throw error;
				ids = error.receipt.entries.map((entry) => entry.id);
				failure = error;
			}
		}
		if (ids.length !== entries.length) throw new Error("Session message batch returned an unexpected entry count.");
		const entryIds = new Map<AgentMessage, string>();
		for (let index = 0; index < entries.length; index += 1) {
			const id = ids[index];
			if (typeof id !== "string") throw new Error("Session message batch returned an invalid entry id.");
			entryIds.set(entries[index]!.message, id);
		}
		// Remove exactly the submitted descriptor occurrences. A callback may append a suffix, but cannot
		// replace the prefix silently or make unrelated entries disappear through a count-only splice.
		const prefixCurrent = original.every((entry, index) => buffer.messages[index] === entry);
		const published = new Map<ModelRouterBufferedSessionMessage, number>();
		for (const entry of original) published.set(entry, (published.get(entry) ?? 0) + 1);
		buffer.messages = buffer.messages.filter((entry) => {
			const remaining = published.get(entry) ?? 0;
			if (remaining === 0) return true;
			published.set(entry, remaining - 1);
			return false;
		});
		buffer.prefixCommitted = true;
		buffer.committed = !prefixOnly && buffer.messages.length === 0;
		const failures: unknown[] = failure ? [failure] : [];
		if (!prefixCurrent) failures.push(new Error("The routed session buffer changed its publishing prefix."));
		if (!prefixOnly && buffer.messages.length > 0)
			failures.push(
				new Error("Input arrived while closing the routed session buffer; its unpersisted suffix remains."),
			);
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Routed session publication did not finish cleanly.");
		return entryIds;
	} finally {
		publishingBuffers.delete(buffer);
	}
}
