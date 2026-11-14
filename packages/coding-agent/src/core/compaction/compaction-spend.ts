/**
 * The spend of a session's compactions as its usage owner keeps it. Every summary call a compaction makes is retained
 * under the `compaction:` operation family (a failed attempt's, a retry's and an idle preparation's calls included)
 * wherever the compaction captures its usage origin, as an `AgentSession` always does, so the family's total is what the
 * session's compactions cost and never another plane's spend recorded meanwhile (System One's, a turn's own messages).
 * Without a captured origin a call keeps its bare source id as its operation and is not in the family.
 */
import type { UsageComponent } from "../../kernel/usage-components.ts";
import type { AccountingOrigin } from "../cost/accounting-evidence.ts";
import type { SessionSemanticUsageDelivery } from "../cost/semantic-usage-delivery.ts";

/** The operation family of a compaction's summary calls: each call's receipt is `compaction:<its source id>`. */
const COMPACTION_OPERATION_PREFIX = "compaction:";

/** The origin a compaction's summary call is recorded with: the compaction's own, in the compaction family. */
export function compactionCallOrigin(
	origin: AccountingOrigin | undefined,
	component: UsageComponent,
): AccountingOrigin | undefined {
	return origin && { ...origin, operationId: `${COMPACTION_OPERATION_PREFIX}${component.sourceId}` };
}

/**
 * The recorded compaction spend so far of the session `usage` owns, in dollars. It only grows: receipts are only added,
 * and a held receipt that becomes a confirmed row counts once. A receipt whose price is unknown counts as the cost it
 * records.
 */
export function recordedCompactionUsd(usage: Pick<SessionSemanticUsageDelivery, "spending">): number {
	return usage.spending(COMPACTION_OPERATION_PREFIX, COMPACTION_OPERATION_PREFIX).totalUsd;
}
