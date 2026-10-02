import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DecisionLedgerStore } from "../../src/core/operator-projection/decision-ledger-store.ts";
import { accountPassBindings } from "../../src/core/system-one/account-pass-wiring.ts";
import { tempDir } from "../temp-dir.ts";

describe("unsettled-claim counts in the decision ledger", () => {
	it("keeps the count per session and per claim, and a reopened ledger reads it back", () => {
		const databasePath = join(tempDir("pi-account-passes-"), "state", "decision-ledger.sqlite");
		let session = "session-a";
		const bind = (ledger: DecisionLedgerStore) =>
			accountPassBindings({ getLedger: () => ledger, getSessionId: () => session });
		const ledger = new DecisionLedgerStore({ databasePath });
		const store = bind(ledger);
		expect(store.read()).toEqual({});
		store.write("claim-1", 1);
		store.write("claim-1", 2);
		store.write("claim-2", 1);
		session = "session-b";
		store.write("claim-1", 1);
		expect(store.read()).toEqual({ "claim-1": 1 });
		session = "session-a";
		expect(store.read()).toEqual({ "claim-1": 2, "claim-2": 1 });

		const reopened = bind(new DecisionLedgerStore({ databasePath }));
		expect(reopened.read()).toEqual({ "claim-1": 2, "claim-2": 1 });
	});

	it("reads nothing and writes nothing when the ledger is unavailable", () => {
		const store = accountPassBindings({ getLedger: () => undefined, getSessionId: () => "s" });
		expect(store.read()).toEqual({});
		expect(() => store.write("claim", 1)).not.toThrow();
	});
});
