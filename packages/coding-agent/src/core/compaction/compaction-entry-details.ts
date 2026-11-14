/**
 * What a compaction entry's details carry beyond the summarizer's own: the verification obligations still open at the
 * cut, and the self-compaction handoff the compaction was run for (`SelfCompactionController.compactionDetails`), by
 * which the handoff's state machine finds its compaction.
 */
import type { AgentMessage } from "../../kernel/types.ts";
import { VerificationObligationTracker } from "../../kernel/verification-obligations.ts";
import type { SelfCompactionController } from "./self-compaction-controller.ts";

export function compactionEntryDetails(
	details: unknown,
	messages: readonly AgentMessage[],
	selfCompaction: Pick<SelfCompactionController, "compactionDetails">,
): unknown {
	const snapshot = new VerificationObligationTracker(messages).createSnapshotDetails();
	const handoff = selfCompaction.compactionDetails();
	if (!snapshot && !handoff) return details;
	const base = !details || typeof details !== "object" || Array.isArray(details) ? {} : details;
	return { ...base, ...snapshot, ...handoff };
}
