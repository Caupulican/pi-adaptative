import { describe, expect, it } from "vitest";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";

describe("System One ExecutionState", () => {
	function createStore(): ExecutionStore {
		return new ExecutionStore({
			run_id: "test-run-1",
			objective: {
				request: "Fix duplicate payment charge on checkout retry",
				normalized_goal: "Ensure checkout retry does not trigger duplicate payment capture",
				acceptance_criteria: [
					{ id: "AC-1", text: "Retry does not execute second charge", required: true },
					{ id: "AC-2", text: "Customer receives single receipt", required: true },
				],
				constraints: [{ id: "C-1", text: "Do not modify legacy billing schema", severity: "hard" }],
			},
			repo: {
				root: "/workspace",
				baseline_revision: "git-commit-baseline-001",
			},
		});
	}

	it("records observations with immutable locator and sha256 content hash (R-009, R-010)", () => {
		const store = createStore();
		const obs = store.recordObservation({
			text: "checkout.ts invokes processPayment on line 42",
			source: {
				kind: "file",
				locator: "src/checkout.ts",
				content: "function retryPayment() { processPayment(); }",
				line_start: 40,
				line_end: 45,
				trust: "authoritative",
			},
		});

		expect(obs.id).toBe("OBS-1");
		expect(obs.source.content_hash).toMatch(/^[a-f0-9]{64}$/);
		expect(obs.freshness).toBe("fresh");
		expect(obs.status).toBe("observed");
	});

	it("invalidates dependent observations and claim support when files change (R-011, R-047, R-062)", () => {
		const store = createStore();
		const obs = store.recordObservation({
			text: "processPayment is called directly",
			source: {
				kind: "file",
				locator: "src/checkout.ts",
				content: "processPayment();",
				trust: "authoritative",
			},
		});

		const claim = store.recordClaim({
			text: "Payment is triggered without idempotency check",
			materiality: "completion_critical",
			evidence_ids: [obs.id],
		});
		store.updateClaimStatus(claim.id, "supported");

		// Initial verification run
		const run = store.recordVerification({
			kind: "unit_test",
			status: "passed",
			covers_acceptance_ids: ["AC-1"],
		});
		expect(run.status).toBe("passed");

		// Record a file mutation in checkout.ts
		store.recordChange({
			path: "src/checkout.ts",
			kind: "modify",
			ownership: "worker",
			diff_content: "- processPayment();\n+ processPaymentWithIdempotency();",
		});

		// Check that observation is now marked stale
		const updatedObs = store.snapshot().observations.find((o) => o.id === obs.id);
		expect(updatedObs?.freshness).toBe("stale");

		// Check that verification run is now inconclusive (R-074)
		const updatedRun = store.snapshot().verification.find((v) => v.id === run.id);
		expect(updatedRun?.status).toBe("inconclusive");

		// Check that claim is downgraded from supported to partially_supported
		const updatedClaim = store.snapshot().claims.find((c) => c.id === claim.id);
		expect(updatedClaim?.status).toBe("partially_supported");
	});

	it("preserves competing hypotheses during bug hunt until verified or rejected (R-016)", () => {
		const store = createStore();
		const h1 = store.recordHypothesis({
			text: "Retry layer invokes payment gateway twice",
			next_discriminator: "Check gateway request log",
		});
		const h2 = store.recordHypothesis({
			text: "Caller invokes retry layer twice",
			next_discriminator: "Trace caller call site count",
		});
		const h3 = store.recordHypothesis({
			text: "Network timeout triggers duplicate provider operation",
			next_discriminator: "Inspect provider idempotency header",
		});

		expect(store.snapshot().hypotheses).toHaveLength(3);
		expect(h1.status).toBe("candidate");
		expect(h2.status).toBe("candidate");

		// Update h2 with contradicting evidence
		store.updateHypothesis(h2.id, {
			status: "rejected",
			contradicting_evidence: ["OBS-caller-single-call"],
		});

		// Update h1 with supporting evidence
		store.updateHypothesis(h1.id, {
			status: "supported",
			supporting_evidence: ["OBS-duplicate-gateway-trace"],
		});

		const snapshot = store.snapshot();
		expect(snapshot.hypotheses.find((h) => h.id === h2.id)?.status).toBe("rejected");
		expect(snapshot.hypotheses.find((h) => h.id === h1.id)?.status).toBe("supported");
		expect(snapshot.hypotheses.find((h) => h.id === h3.id)?.status).toBe("candidate");
	});

	it("enforces that worker cannot mark complete; only emits completion_candidate=true (R-001, R-002)", () => {
		const store = createStore();
		store.transitionPhase("executing", true);

		const turnResult = store.applyWorkerTurn({
			run_id: store.runId,
			step_id: "S-1",
			requested_action: "test",
			claims: [],
			hypothesis_updates: [],
			requested_tools: [],
			completion_candidate: true,
		});

		expect(turnResult.isCompletionCandidate).toBe(true);
		// Phase is completion_candidate, NOT complete! (R-001)
		expect(store.phase).toBe("completion_candidate");

		// Unauthorized attempt to transition to complete must throw (R-002)
		expect(() => store.transitionPhase("complete", false)).toThrow(
			"Worker or unauthorized caller cannot transition phase to complete (R-001, R-002)",
		);

		// Authorized harness transition succeeds
		store.transitionPhase("complete", true);
		expect(store.phase).toBe("complete");
	});

	it("detects loops when same strategy fails twice without new observations (R-045)", () => {
		const store = createStore();

		// First failure
		const result1 = store.applyWorkerTurn({
			run_id: store.runId,
			step_id: "step-edit-payment",
			requested_action: "edit",
			decision_summary: "Try editing payment logic",
			claims: [],
			hypothesis_updates: [{ hypothesis_id: "HYP-1", status: "candidate" }],
			requested_tools: [{ tool: "file_edit", intent: "edit checkout", impact: "repo_mutation" }],
			completion_candidate: false,
		});
		expect(result1.loopDetected).toBe(false);

		// Second failure with same strategy and NO new observations
		const result2 = store.applyWorkerTurn({
			run_id: store.runId,
			step_id: "step-edit-payment",
			requested_action: "edit",
			decision_summary: "Try editing payment logic again",
			claims: [],
			hypothesis_updates: [{ hypothesis_id: "HYP-1", status: "candidate" }],
			requested_tools: [{ tool: "file_edit", intent: "edit checkout", impact: "repo_mutation" }],
			completion_candidate: false,
		});
		expect(result2.loopDetected).toBe(true);
		expect(result2.failedStrategyCount).toBe(2);
	});

	it("enforces worker_turn schema and rejects unexpected properties (R-071, worker_turn.schema.json)", () => {
		const store = createStore();

		// Additional unexpected property (additionalProperties: false)
		expect(() =>
			store.applyWorkerTurn({
				run_id: store.runId,
				step_id: "step-1",
				requested_action: "inspect",
				claims: [],
				hypothesis_updates: [],
				requested_tools: [],
				completion_candidate: false,
				unexpected_hack: "malicious_payload",
			}),
		).toThrow("Worker turn contains forbidden property 'unexpected_hack'");

		// Invalid requested_action enum
		expect(() =>
			store.applyWorkerTurn({
				run_id: store.runId,
				step_id: "step-1",
				requested_action: "hack_database",
				claims: [],
				hypothesis_updates: [],
				requested_tools: [],
				completion_candidate: false,
			}),
		).toThrow("Worker turn 'requested_action' must be one of");

		// Claim with unexpected property
		expect(() =>
			store.applyWorkerTurn({
				run_id: store.runId,
				step_id: "step-1",
				requested_action: "inspect",
				claims: [{ text: "test", materiality: "informational", evidence_refs: [], rogue_field: 123 }],
				hypothesis_updates: [],
				requested_tools: [],
				completion_candidate: false,
			}),
		).toThrow("Claim at index 0 contains forbidden property 'rogue_field'");
	});

	it("revalidates repository revision and invalidates stale evidence on resume (R-062)", () => {
		const store = createStore();
		const obs = store.recordObservation({
			text: "checkout.ts line 1",
			source: {
				kind: "file",
				locator: "src/checkout.ts",
				content: "code",
				revision: "git-commit-baseline-001",
				trust: "authoritative",
			},
		});

		const claim = store.recordClaim({
			text: "Logic verified at baseline-001",
			materiality: "material",
			evidence_ids: [obs.id],
		});
		store.updateClaimStatus(claim.id, "supported");

		expect(obs.freshness).toBe("fresh");
		expect(store.snapshot().claims.find((c) => c.id === claim.id)?.status).toBe("supported");

		// Resume on same revision: nothing invalidated
		const noChange = store.revalidateOnResume("git-commit-baseline-001");
		expect(noChange.revisionChanged).toBe(false);
		expect(noChange.invalidatedObservations).toBe(0);
		expect(obs.freshness).toBe("fresh");

		// Resume after external commit: evidence invalidated!
		const changed = store.revalidateOnResume("git-commit-new-head-002");
		expect(changed.revisionChanged).toBe(true);
		expect(changed.invalidatedObservations).toBe(1);
		expect(changed.invalidatedClaims).toBe(1);

		const updatedSnapshot = store.snapshot();
		const updatedObs = updatedSnapshot.observations.find((o) => o.id === obs.id);
		const updatedClaim = updatedSnapshot.claims.find((c) => c.id === claim.id);
		expect(updatedObs?.freshness).toBe("invalidated");
		expect(updatedClaim?.status).toBe("unverified");
		expect(updatedSnapshot.repo.current_revision).toBe("git-commit-new-head-002");
	});
});
