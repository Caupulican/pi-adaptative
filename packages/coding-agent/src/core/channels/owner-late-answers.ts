/**
 * The answer an owner request owes its chat after the chat was answered early (`ordinary-work-late-answer.ts`). A batch
 * answered while its request still worked (a worker it launched kept it waiting) records the entry of that answer; once
 * the hosting session reports the request settled, its final answer goes to the same chat through the owner reply path.
 * The mark is cleared before the send, as a reply is marked replied before it is sent: a crash loses the late answer
 * rather than sending it twice. The same update adds what the request's later turns spent to the batch, so the owner pool
 * holds the whole request. It owns that mark and that spend and nothing else of the journal.
 */
import type { OrdinaryLateAnswer, OrdinaryLateSpend } from "../ordinary-work-late-answer.ts";
import type { ChannelBatchRecord, ChannelJournal } from "./channel-journal.ts";
import type { OwnerChannelControl } from "./owner-channel-types.ts";

/** Where the owed answers of one channel are read, marked and sent. */
export interface LateAnswerPass {
	readonly name: string;
	readonly journal: ChannelJournal;
	readonly now: number;
	/** The session serving the channel: it routes only the batches it accepted, as replies are routed. */
	readonly sessionId: string;
	/** The hosting session's control handle; absent or unreadable while its session is replaced. */
	control(): OwnerChannelControl | undefined;
	/** The metered dollars of later model calls, as a turn's own spend is counted (`batch-outcome.ts`). */
	meteredUsd(spend: readonly OrdinaryLateSpend[]): number;
}

/**
 * What the hosting session says the request of `batchId` owes after `afterEntryId`. A control handle that cannot be read
 * tells nothing yet, so a mark stays for a later pass.
 */
function readLateAnswer(pass: LateAnswerPass, batchId: string, afterEntryId: string): OrdinaryLateAnswer | undefined {
	let control: OwnerChannelControl | undefined;
	try {
		control = pass.control();
	} catch {
		return undefined;
	}
	return control?.lateAnswer?.(pass.name, batchId, afterEntryId);
}

/** Mark replied owner batch `batchId` when the request its answer at `afterEntryId` came from still owes one. */
export function oweLateAnswer(pass: LateAnswerPass, batchId: string, afterEntryId: string): void {
	const late = readLateAnswer(pass, batchId, afterEntryId);
	if (!late || late.state === "none") return;
	pass.journal.update(pass.now, (state) => {
		const batch = state.batches.find((entry) => entry.id === batchId);
		if (batch?.owner === true && batch.state === "replied") batch.lateAnswerAfter = afterEntryId;
	});
}

/**
 * Settle each owed answer of the channel whose request settled: the mark is cleared, and a final answer after the sent
 * one is handed to `send` (the owner reply path, with its draft rules). A request still working keeps its mark.
 */
export async function routeLateAnswers(
	pass: LateAnswerPass,
	batches: readonly ChannelBatchRecord[],
	send: (batch: ChannelBatchRecord, text: string) => Promise<unknown>,
): Promise<void> {
	for (const batch of batches) {
		const after = batch.lateAnswerAfter;
		if (
			after === undefined ||
			batch.owner !== true ||
			batch.state !== "replied" ||
			batch.sessionId !== pass.sessionId
		)
			continue;
		const late = readLateAnswer(pass, batch.id, after);
		if (!late || late.state === "pending") continue;
		const usd = pass.meteredUsd(late.spend);
		const claimed = pass.journal.update(pass.now, (state) => {
			const current = state.batches.find((entry) => entry.id === batch.id);
			if (current?.state !== "replied" || current.lateAnswerAfter !== after) return false;
			delete current.lateAnswerAfter;
			if (usd > 0) current.usd = (current.usd ?? 0) + usd;
			return true;
		}).result;
		if (claimed && late.state === "ready") await send(batch, late.text);
	}
}
