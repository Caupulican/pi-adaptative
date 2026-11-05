/**
 * Hands a reserved turn's owner-knowledge block from the parent's memory to the turn's helper over its IPC channel,
 * immediately before the helper prompts. The block is never written to a job record, a process argument or the
 * environment; a helper whose parent is gone starts without it.
 */
import { MAX_COLLABORATION_KNOWLEDGE_BYTES } from "./job-record.ts";

/** The IPC surface both halves need: the child process on the parent side, `process` on the helper side. */
export interface KnowledgeChannelPort {
	/** Throws or reports an error when the channel is gone. */
	send(message: object, onSent: (error: Error | null) => void): void;
	onMessage(listener: (value: unknown) => void): () => void;
	/** The channel ended: disconnect, or the other process exited. */
	onClose(listener: () => void): () => void;
}

/** What the helper got for a turn whose record names granted versions. */
export type CollaborationKnowledgeRelease =
	| { readonly kind: "delivered"; readonly text: string }
	/** The parent re-checked the grant at the ask: a version changed, was forgotten or may no longer be read. */
	| { readonly kind: "withdrawn" }
	/** No parent answered (gone, channel closed or never opened); the turn starts without knowledge. */
	| { readonly kind: "undelivered" };

/** A turn asks its parent for a block exactly when it is a new task whose record names granted versions. */
export function turnExpectsKnowledge(
	agent: { readonly knowledgeReferences?: readonly unknown[] },
	answering: boolean,
): boolean {
	return !answering && (agent.knowledgeReferences?.length ?? 0) > 0;
}

function isTurnMessage(value: unknown, type: string, turnId: string): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"type" in value &&
		value.type === type &&
		"turnId" in value &&
		value.turnId === turnId
	);
}

/** Helper side: ask once, then wait for the parent's answer or the channel's end. Never reads the block from disk. */
export function requestTurnKnowledge(
	port: KnowledgeChannelPort | undefined,
	turnId: string,
	signal?: AbortSignal,
): Promise<CollaborationKnowledgeRelease> {
	if (!port || signal?.aborted) return Promise.resolve({ kind: "undelivered" });
	return new Promise((resolve) => {
		let settled = false;
		const settle = (release: CollaborationKnowledgeRelease) => {
			if (settled) return;
			settled = true;
			stopMessages();
			stopClose();
			signal?.removeEventListener("abort", onAbort);
			resolve(release);
		};
		const onAbort = () => settle({ kind: "undelivered" });
		const stopMessages = port.onMessage((value) => {
			if (!isTurnMessage(value, "knowledge", turnId)) return;
			const text = value.text;
			if (text === undefined) return settle({ kind: "withdrawn" });
			settle(
				typeof text === "string" &&
					text.trim() &&
					!text.includes("\0") &&
					Buffer.byteLength(text, "utf8") <= MAX_COLLABORATION_KNOWLEDGE_BYTES
					? { kind: "delivered", text }
					: { kind: "undelivered" },
			);
		});
		const stopClose = port.onClose(() => settle({ kind: "undelivered" }));
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			port.send({ type: "need-knowledge", turnId }, (error) => {
				if (error) settle({ kind: "undelivered" });
			});
		} catch {
			settle({ kind: "undelivered" });
		}
	});
}

/**
 * Parent side: answer this turn's one request with the block current at that moment. Resolves when the answer was
 * handed to the channel (`answered`) or when the channel ended, the helper reported its terminal, or `signal`
 * aborted before the request was answered (`ended`); the caller closes the channel or ends the helper in that case.
 */
export function answerTurnKnowledge(
	port: KnowledgeChannelPort,
	turnId: string,
	current: () => string | undefined,
	signal?: AbortSignal,
): Promise<"answered" | "ended"> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (outcome: "answered" | "ended") => {
			if (settled) return;
			settled = true;
			stopMessages();
			stopClose();
			signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		// Once the answer is handed to the channel only its send result, or the channel's end, settles: an abort then
		// could not take back an answer the helper may already be prompting with.
		let answering = false;
		const onAbort = () => {
			if (!answering) settle("ended");
		};
		const stopMessages = port.onMessage((value) => {
			if (isTurnMessage(value, "terminal", turnId)) return settle("ended");
			if (answering || !isTurnMessage(value, "need-knowledge", turnId)) return;
			answering = true;
			let text: string | undefined;
			try {
				text = current() || undefined;
			} catch {
				// A grant that cannot be re-checked is not delivered; the helper is told it was withdrawn.
				text = undefined;
			}
			try {
				port.send({ type: "knowledge", turnId, ...(text === undefined ? {} : { text }) }, (error) =>
					settle(error ? "ended" : "answered"),
				);
			} catch {
				settle("ended");
			}
		});
		const stopClose = port.onClose(() => settle("ended"));
		if (signal?.aborted) settle("ended");
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}
