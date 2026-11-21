/**
 * The answer an owner request still owes the chat it came from. A channel batch is answered when the turn its message
 * opened ends; when that turn only acknowledged the request and a worker it launched kept the request waiting, the
 * final answer comes from a later turn of the same request. This reads that answer from the request's own turns after
 * the one the chat was sent, once the request settled; it writes nothing.
 */
import { assistantAnswerTextParts } from "../kernel/assistant-answer.ts";
import type { SessionEntry } from "../kernel/session/session-entries.ts";
import type { OrdinaryWorkRecord } from "./ordinary-work-store.ts";
import { awaitsLaunchedWork } from "./ordinary-work-wait.ts";
import { entryTurnOrigin, isDecisiveOrigin, isHostContextEntry } from "./turn-origin.ts";

/** What one model call of the request's later turns cost, by the model that made it. */
export interface OrdinaryLateSpend {
	readonly provider: string;
	readonly model: string;
	readonly usd: number;
}

/**
 * `pending`: the request still works or waits; `none`: it settled with nothing after the sent answer, or was cancelled.
 * A settled request reports what its turns after the sent answer cost (`spend`), answer or not.
 */
export type OrdinaryLateAnswer =
	| { readonly state: "pending" }
	| { readonly state: "none"; readonly spend: readonly OrdinaryLateSpend[] }
	| { readonly state: "ready"; readonly text: string; readonly spend: readonly OrdinaryLateSpend[] };

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
	if (!record) return { state: "none", spend: [] };
	// A request held because its worker kept it waiting past every check still settles when that worker reports.
	if (record.status === "active" || record.status === "waiting" || awaitsLaunchedWork(record))
		return { state: "pending" };
	const read = turns();
	const start = read.findIndex((entry) => entry.id === afterEntryId);
	if (start === -1) return { state: "none", spend: [] };
	let answer: string | undefined;
	const spend: OrdinaryLateSpend[] = [];
	for (const entry of read.slice(start + 1)) {
		if (isHostContextEntry(entry)) continue;
		const origin = entryTurnOrigin(entry);
		if (origin && isDecisiveOrigin(origin)) break;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		const usd = message.usage?.cost?.total ?? 0;
		if (usd > 0) spend.push({ provider: message.provider, model: message.model, usd });
		if (message.stopReason !== "stop" && message.stopReason !== "length") continue;
		const text = assistantAnswerTextParts(message).filter(Boolean).join("\n").trim();
		if (text) answer = text;
	}
	// A cancelled request still spent what its later turns cost; only its answer is withdrawn.
	return answer && record.status !== "cancelled" ? { state: "ready", text: answer, spend } : { state: "none", spend };
}
