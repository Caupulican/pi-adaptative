/**
 * Falsifiability proofs for every catalogue checker: each invariant is shown going red on a
 * world that violates it, then green on a world that satisfies it. A checker that cannot be
 * made to fail is itself a finding (blueprint §0.3).
 */
import { describe, expect, it } from "vitest";
import { assertInvariants, type InvariantId, type InvariantWorld } from "./invariants.ts";

const REPRO = { seed: 1, injection: 1, scenario: "invariant-falsify" };

function expectRed(ids: readonly InvariantId[], world: InvariantWorld): void {
	expect(() => assertInvariants(world, ids, REPRO)).toThrow(/INV-/);
}

function expectGreen(ids: readonly InvariantId[], world: InvariantWorld): void {
	expect(() => assertInvariants(world, ids, REPRO)).not.toThrow();
}

describe("destructive/invariants: every checker is falsifiable", () => {
	it("INV-G1", () => {
		expectRed(["INV-G1"], {
			goalAccounting: {
				tokensUsed: 10,
				chargedTokens: [3, 4],
				unresolvableFlush: false,
				loudWarningEmitted: false,
				continuationFailed: false,
			},
		});
		expectGreen(["INV-G1"], {
			goalAccounting: {
				tokensUsed: 7,
				chargedTokens: [3, 4],
				unresolvableFlush: false,
				loudWarningEmitted: false,
				continuationFailed: false,
			},
		});
		expectGreen(["INV-G1"], {
			goalAccounting: {
				tokensUsed: 0,
				chargedTokens: [9],
				unresolvableFlush: true,
				loudWarningEmitted: true,
				continuationFailed: true,
			},
		});
	});

	it("INV-G2", () => {
		expectRed(["INV-G2"], {
			goalTermination: { budgeted: true, status: "active", stopReason: "error" },
		});
		expectRed(["INV-G2"], {
			goalTermination: { budgeted: true, status: "active", stopReason: "length" },
		});
		expectGreen(["INV-G2"], {
			goalTermination: { budgeted: true, status: "budget_limited", stopReason: "goal_budget_exhausted" },
		});
	});

	it("INV-G3", () => {
		expectRed(["INV-G3"], { goalRestart: { terminal: true, freshTurnAdmitted: true, wrapUpDraining: false } });
		expectGreen(["INV-G3"], { goalRestart: { terminal: true, freshTurnAdmitted: false, wrapUpDraining: true } });
	});

	it("INV-W1", () => {
		expectRed(["INV-W1"], { leases: { acquired: 2, released: 0, heldByLiveOwner: 0 } });
		expectGreen(["INV-W1"], { leases: { acquired: 2, released: 1, heldByLiveOwner: 1 } });
	});

	it("INV-W2", () => {
		expectRed(["INV-W2"], { terminalPartition: { completed: 1, failed: 0, attention: 0, terminalCount: 2 } });
		expectGreen(["INV-W2"], { terminalPartition: { completed: 1, failed: 1, attention: 1, terminalCount: 3 } });
	});

	it("INV-W3", () => {
		expectRed(["INV-W3"], { concurrency: { observations: [1, 3], maxConcurrent: 2 } });
		expectGreen(["INV-W3"], { concurrency: { observations: [1, 2], maxConcurrent: 2 } });
	});

	it("INV-W4", () => {
		expectRed(["INV-W4"], {
			terminalHandoff: { deliveredCounts: new Map([["a", 2]]), neverDelivered: [] },
		});
		expectGreen(["INV-W4"], {
			terminalHandoff: { deliveredCounts: new Map([["a", 1]]), neverDelivered: [] },
		});
	});

	it("INV-W5", () => {
		expectRed(["INV-W5"], { fencedRenewal: { supersededRenewalRejected: false, liveExpiryStillAbandons: true } });
		expectGreen(["INV-W5"], { fencedRenewal: { supersededRenewalRejected: true, liveExpiryStillAbandons: true } });
	});

	it("INV-W6", () => {
		expectRed(["INV-W6"], { boundedWait: { settledWithinBound: false, silentOverrun: true } });
		expectGreen(["INV-W6"], { boundedWait: { settledWithinBound: true, silentOverrun: false } });
	});

	it("INV-B1", () => {
		expectRed(["INV-B1"], {
			treeBudget: { spendUsd: 2, ceilingUsd: 0.5, finalTurnOverrunUsd: 0, ceilingSource: "none" },
		});
		expectGreen(["INV-B1"], {
			treeBudget: { spendUsd: 2, finalTurnOverrunUsd: 0, ceilingSource: "none" },
		});
		expectRed(["INV-B1"], {
			treeBudget: { spendUsd: 2, ceilingUsd: 0.5, finalTurnOverrunUsd: 0, ceilingSource: "explicit" },
		});
		expectGreen(["INV-B1"], {
			treeBudget: { spendUsd: 0.6, ceilingUsd: 0.5, finalTurnOverrunUsd: 0.2, ceilingSource: "explicit" },
		});
		expectGreen(["INV-B1"], {
			treeBudget: { spendUsd: 0, ceilingUsd: 0, finalTurnOverrunUsd: 0, ceilingSource: "explicit" },
		});
		expectRed(["INV-B1"], {
			treeBudget: { spendUsd: 0.01, ceilingUsd: 0, finalTurnOverrunUsd: 0, ceilingSource: "explicit" },
		});
	});

	it("INV-C1", () => {
		expectRed(["INV-C1"], {
			compactionRoundTrip: {
				userRulesBefore: ["do not use curl"],
				userRulesAfter: [],
				activeTaskBefore: "fix tests",
				activeTaskAfter: "fix tests",
				sentinelPersisted: false,
			},
		});
		expectGreen(["INV-C1"], {
			compactionRoundTrip: {
				userRulesBefore: ["do not use curl"],
				userRulesAfter: ["do not use curl"],
				activeTaskBefore: "fix tests",
				activeTaskAfter: "fix tests",
				sentinelPersisted: false,
			},
		});
	});

	it("INV-C2 / INV-R1", () => {
		expectRed(["INV-C2", "INV-R1"], {
			crashConsistency: { consistent: false, failedLoud: false, silentDivergence: true },
		});
		expectGreen(["INV-C2", "INV-R1"], {
			crashConsistency: { consistent: true, failedLoud: false, silentDivergence: false },
		});
		expectGreen(["INV-C2", "INV-R1"], {
			crashConsistency: { consistent: false, failedLoud: true, silentDivergence: false },
		});
	});

	it("INV-L1", () => {
		expectRed(["INV-L1"], { loopRun: { settledWithinDeadline: false, stopReason: undefined, leaseLeaked: true } });
		expectGreen(["INV-L1"], { loopRun: { settledWithinDeadline: true, stopReason: "stop", leaseLeaked: false } });
	});
});
