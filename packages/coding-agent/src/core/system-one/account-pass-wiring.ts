/**
 * The session's binding for the completion account's unsettled-claim count: the decision ledger keeps it per
 * session, so resuming a session continues the count instead of asking for the same evidence again.
 */

import type { DecisionLedgerStore } from "../operator-projection/decision-ledger-store.ts";
import type { AccountPassStore } from "./completion-account.ts";

export function accountPassBindings(input: {
	getLedger(): DecisionLedgerStore | undefined;
	getSessionId(): string;
}): AccountPassStore {
	return {
		read: () => input.getLedger()?.readAccountClaimPasses(input.getSessionId()) ?? {},
		write: (fingerprint, passes) =>
			input.getLedger()?.writeAccountClaimPasses(input.getSessionId(), fingerprint, passes, Date.now()),
	};
}
