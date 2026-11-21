/**
 * The answer an owner request still owes the chat it came from. A channel batch is answered when the turn its message
 * opened ends; when that turn only acknowledged the request and a worker it launched kept the request waiting, the
 * final answer comes from a later turn of the same request. This reads that answer from the request's own turns after
 * the one the chat was sent, once the request settled; it writes nothing.
 */
import { assistantAnswerTextParts } from "../kernel/assistant-answer.ts";
import type { SessionEntry } from "../kernel/session/session-entries.ts";
import type { OrdinaryWorkRecord } from "./ordinary-work-store.ts";
import { entryTurnOrigin, isDecisiveOrigin, isHostContextEntry } from "./turn-origin.ts";

/** `pending`: the request still works or waits; `none`: it settled with nothing after the sent answer, or was cancelled. */
export type OrdinaryLateAnswer =
	| { readonly state: "pending" }
	| { readonly state: "none" }
	| { readonly state: "ready"; readonly text: string };

/**
 * What the request of `record` owes after the answer at `afterEntryId`, read from `turns()` (the branch from that answer
 * on, read only once the request settled): the last
 * final answer of its later turns, up to the next decisive input (a new owner or third-party message opens other work).
 */
export function readOrdinaryLateAnswer(
	record: OrdinaryWorkRecord | undefined,
	turns: () => readonly SessionEntry[],
	afterEntryId: string,
): OrdinaryLateAnswer {
	if (!record || record.status === "cancelled") return { state: "none" };
	if (record.status === "active" || record.status === "waiting") return { state: "pending" };
	const read = turns();
	const start = read.findIndex((entry) => entry.id === afterEntryId);
	if (start === -1) return { state: "none" };
	let answer: string | undefined;
	for (const entry of read.slice(start + 1)) {
		if (isHostContextEntry(entry)) continue;
		const origin = entryTurnOrigin(entry);
		if (origin && isDecisiveOrigin(origin)) break;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		if (message.stopReason !== "stop" && message.stopReason !== "length") continue;
		const text = assistantAnswerTextParts(message).filter(Boolean).join("\n").trim();
		if (text) answer = text;
	}
	return answer ? { state: "ready", text: answer } : { state: "none" };
}
