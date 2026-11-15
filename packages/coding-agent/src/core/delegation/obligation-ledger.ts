import { join } from "node:path";
import type { OrchestrationHome } from "../agent-paths.ts";
import { appendBoundedJsonLineSync, type BoundedJsonlLimits } from "../util/bounded-jsonl.ts";

/**
 * The ledger of mailbox obligations the harness settled as failed instead of delivering: the startup
 * retention sweep's expiries and a forced retire's discards share one file per orchestration home, the home of the
 * mailboxes they settle (the owner's `state/orchestration/`, a bot's `bots/<id>/orchestration/`), so nothing a mailbox
 * gives up on is silent and a bot's records stay, and go, with its home. Records are bounded; each carries only a
 * content head, never the full message.
 */
export const OBLIGATION_LEDGER_NAME = "expired-obligations.jsonl";

/** `<home>/expired-obligations.jsonl` -- the obligation ledger of the mailboxes of orchestration home `home`. */
export function obligationLedgerFile(home: OrchestrationHome): string {
	return join(home.root, OBLIGATION_LEDGER_NAME);
}
const MAX_LEDGER_ITEMS_PER_RECORD = 8;
const OBLIGATION_LEDGER_LIMITS: BoundedJsonlLimits = {
	maxBytes: 1024 * 1024,
	targetBytes: 512 * 1024,
	maxRecords: 2000,
};

/** Append one bounded, attributed record of settled obligations. Throws when the ledger cannot be written. */
export function recordDiscardedObligations(input: {
	/** The orchestration home of the mailbox that settled them: its ledger takes the record. */
	orchestrationHome: OrchestrationHome;
	parentSessionId: string;
	kind: string;
	/** Absent for a session-root mailbox, which belongs to no single agent. */
	agentId?: string;
	/** The session bundle a retention sweep settled this in, when one did. */
	bundle?: string;
	reason: string;
	/** Bounded, content-free evidence records (worker obligations or session-root replies). */
	settled: readonly object[];
	at?: string;
}): void {
	appendBoundedJsonLineSync(
		obligationLedgerFile(input.orchestrationHome),
		{
			at: input.at ?? new Date().toISOString(),
			...(input.bundle ? { bundle: input.bundle } : {}),
			parentSessionId: input.parentSessionId,
			kind: input.kind,
			...(input.agentId ? { agentId: input.agentId } : {}),
			reason: input.reason,
			count: input.settled.length,
			omitted: Math.max(0, input.settled.length - MAX_LEDGER_ITEMS_PER_RECORD),
			items: input.settled.slice(0, MAX_LEDGER_ITEMS_PER_RECORD),
		},
		OBLIGATION_LEDGER_LIMITS,
	);
}
