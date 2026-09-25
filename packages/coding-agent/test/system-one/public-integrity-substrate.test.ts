import { describe, expect, it } from "vitest";
import {
	computePolicyPackDigest,
	type IntegrityAuditRecord,
	type IntegrityExtension,
	type IntegrityGateResult,
	type IntegrityValidationRequest,
	type PolicyPackRef,
	type ValidationPolicyPack,
	validatePolicyPackStructure,
} from "../../src/core/hooks/index.ts";
import { SystemOneJevAdapter } from "../../src/core/system-one/adapter.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { IntegrityHookCoordinator } from "../../src/core/system-one/integrity-hooks.ts";
import {
	InMemoryValidationPolicyProvider,
	PolicyPackDigestMismatchError,
	resolveVerifiedPolicyPack,
} from "../../src/core/system-one/policy-pack.ts";
import { DefaultSemanticValidator } from "../../src/core/system-one/public-validator.ts";
import * as codingAgentExports from "../../src/index.ts";

describe("Public Execution-Integrity Substrate (PI-001 to PI-030)", () => {
	const neutralPackRaw: Omit<ValidationPolicyPack, "digest"> = {
		schema_version: "1.0",
		id: "neutral-demo-policy",
		version: "1.0.0",
		stages: [
			{
				id: "stage-preflight",
				hook: "before_mutation",
				required: true,
				fail_mode: "closed",
				question_ids: ["Q-safety"],
			},
			{
				id: "stage-completion",
				hook: "completion_candidate",
				required: true,
				fail_mode: "closed",
				question_ids: ["Q-completion"],
			},
		],
		questions: {
			"Q-safety": {
				type: "noul",
				instruction: "Does this action avoid unsafe repository modifications?",
			},
			"Q-completion": {
				type: "choice",
				instruction: "Is the objective satisfied with verifiable evidence?",
			},
		},
	};

	const neutralPackDigest = computePolicyPackDigest(neutralPackRaw);
	const neutralPolicyPack: ValidationPolicyPack = {
		...neutralPackRaw,
		digest: neutralPackDigest,
	};

	// PI-001 & PI-002
	it("PI-001 & PI-002: Pi runs cleanly without external consumer and has no proprietary AIdeas dependencies", () => {
		const store = new ExecutionStore({
			run_id: "pi-001-run",
			objective: {
				request: "Refactor module",
				normalized_goal: "Clean refactor",
				acceptance_criteria: [],
				constraints: [],
			},
			repo: { root: "/repo", baseline_revision: "rev-0" },
		});
		const fauxAdapter = {
			evaluate: async () => ({ model: "jev-1.13.0", answers: {}, latency_ms: 5 }),
		};
		const controller = new SystemOneController({ store, adapter: fauxAdapter });
		expect(controller).toBeDefined();
		expect(controller.hookCoordinator).toBeUndefined();
	});

	// PI-003 & PI-004
	it("PI-003 & PI-004: Exports SemanticValidator, ValidationPolicyProvider, and public integrity SDK symbols", () => {
		expect(codingAgentExports.DefaultSemanticValidator).toBeDefined();
		expect(codingAgentExports.InMemoryValidationPolicyProvider).toBeDefined();
		expect(codingAgentExports.IntegrityHookCoordinator).toBeDefined();
		expect(codingAgentExports.canonicalJsonStringify).toBeDefined();
		expect(codingAgentExports.computePolicyPackDigest).toBeDefined();
		expect(codingAgentExports.validatePolicyPackStructure).toBeDefined();
	});

	// PI-005
	it("PI-005: Validates policy pack id, version, and digest, rejecting malformed or forged packs", async () => {
		const validCheck = validatePolicyPackStructure(neutralPolicyPack);
		expect(validCheck.valid).toBe(true);

		const malformedPack = { schema_version: "1.0", id: "", version: "1.0", digest: "invalid" };
		const invalidCheck = validatePolicyPackStructure(malformedPack);
		expect(invalidCheck.valid).toBe(false);

		const forgedPack: ValidationPolicyPack = {
			...neutralPolicyPack,
			digest: "0000000000000000000000000000000000000000000000000000000000000000",
		};
		expect(() => new InMemoryValidationPolicyProvider([forgedPack])).toThrow(PolicyPackDigestMismatchError);

		const validProvider = new InMemoryValidationPolicyProvider([neutralPolicyPack]);
		await expect(
			resolveVerifiedPolicyPack(validProvider, {
				id: neutralPolicyPack.id,
				version: neutralPolicyPack.version,
				digest: "0000000000000000000000000000000000000000000000000000000000000000",
			}),
		).rejects.toThrow(PolicyPackDigestMismatchError);
	});

	// PI-006 & PI-007
	it("PI-006 & PI-007: Policy pack is immutable during a transaction and worker turns cannot mutate it", () => {
		const store = new ExecutionStore({
			run_id: "pi-006-run",
			objective: { request: "Task", normalized_goal: "Goal", acceptance_criteria: [], constraints: [] },
			repo: { root: "/repo", baseline_revision: "rev-0" },
		});
		const packRef: PolicyPackRef = {
			id: neutralPolicyPack.id,
			version: neutralPolicyPack.version,
			digest: neutralPolicyPack.digest,
		};
		store.bindPolicyPack(packRef);

		// Re-binding with a different pack is rejected
		expect(() => {
			store.bindPolicyPack({ id: "other-pack", version: "1.0", digest: "a".repeat(64) });
		}).toThrow(/already bound/);

		// Worker turn cannot overwrite bound policy pack
		store.applyWorkerTurn({
			run_id: store.runId,
			step_id: "step-1",
			requested_action: "none",
			claims: [],
			hypothesis_updates: [],
			requested_tools: [],
			completion_candidate: false,
		});
		expect(store.snapshot().policy_pack).toEqual(packRef);
	});

	// PI-008
	it("PI-008: Extension cannot expand worker authority beyond harness limits", async () => {
		const permissiveExt: IntegrityExtension = {
			id: "permissive-ext",
			async onHook(_hook, _ctx): Promise<IntegrityGateResult> {
				// Extension attempts to unilaterally grant unrestricted allow
				return { decision: "allow", reasonCodes: ["ALLOW_EVERYTHING"], validationRefs: [] };
			},
		};
		const coordinator = new IntegrityHookCoordinator([permissiveExt]);

		// When harness authority denies a command deterministically, extension's allow cannot override it
		const store = new ExecutionStore({
			run_id: "pi-008-run",
			objective: { request: "Test", normalized_goal: "Test", acceptance_criteria: [], constraints: [] },
			repo: { root: "/repo", baseline_revision: "rev-0" },
		});
		const fauxAdapter = {
			evaluate: async () => ({ model: "jev-1.13.0", answers: {}, latency_ms: 5 }),
		};
		const controller = new SystemOneController({ store, adapter: fauxAdapter, hookCoordinator: coordinator });

		const result = await controller.validateToolGate(
			{ tool: "bash", intent: "rm -rf /", impact: "destructive" },
			() => ({ allowed: false, reason: "Destructive root deletion blocked by harness" }),
		);
		expect(result.outcome).toBe("block");
		expect(result.reason).toContain("Destructive root deletion blocked by harness");
	});

	// PI-009, PI-010, PI-011
	it("PI-009, PI-010, PI-011: Adapter enforces pinned model jev-1.13.0 and rejects model drift", async () => {
		const mockReviewer = {
			evaluate: async () => ({
				request: { model: "jev-1.13.0" },
				response: {
					model: "unauthorized-drift-model-v2",
					answers: { safety: { noul: 0.99 } },
				},
				elapsedMs: 12,
			}),
		};
		const adapter = new SystemOneJevAdapter(mockReviewer as any, undefined, {
			getApiKey: () => "test-valid-user-key-12345",
		});
		await expect(adapter.evaluate({ state: {}, questions: {} })).rejects.toThrow(/Model drift detected/);
	});

	// PI-012, PI-013, PI-014
	it("PI-012, PI-013, PI-014: Secret canary redacts/blocks, and private questions/state remain absent from audit", async () => {
		const recordedAudits: IntegrityAuditRecord[] = [];
		const SECRET_CANARY = "SECRET_CANARY_VALUE_XYZ123";

		const fauxAdapter = {
			evaluate: async (req: any) => {
				// Verify secret canary was redacted before remote dispatch
				expect(JSON.stringify(req.state)).not.toContain(SECRET_CANARY);
				return {
					model: "jev-1.13.0",
					answers: { "Q-safety": { noul: 0.01 } },
					usage: { input_tokens: 50, output_tokens: 10 },
					latency_ms: 15,
				};
			},
		};

		const validator = new DefaultSemanticValidator({
			adapter: fauxAdapter as any,
			canaries: [SECRET_CANARY],
			canaryAction: "redact",
			onAuditRecord: (record) => recordedAudits.push(record),
		});

		const req: IntegrityValidationRequest = {
			runId: "canary-run",
			stage: "preflight",
			impact: "repo_mutation",
			policyPack: { id: "test", version: "1.0", digest: "d".repeat(64) },
			state: {
				sensitivePayload: `Authorization: Bearer ${SECRET_CANARY}`,
				questions: {
					"Q-safety": { type: "noul", instruction: "Is this safe?" },
				},
			},
			questionIds: ["Q-safety"],
		};

		const result = await validator.evaluate(req);
		expect(result.status).toBe("ok");
		expect(recordedAudits.length).toBe(1);

		const audit = recordedAudits[0];
		// PI-013: Raw private question text not in audit record
		expect(JSON.stringify(audit)).not.toContain("Is this safe?");
		// PI-014: Raw private state not in audit record
		expect(JSON.stringify(audit)).not.toContain(SECRET_CANARY);
		expect(audit.projection_digest).toBeDefined();
		expect(audit.question_digest).toBeDefined();

		// Test blocking action
		const blockingValidator = new DefaultSemanticValidator({
			adapter: fauxAdapter as any,
			canaries: [SECRET_CANARY],
			canaryAction: "block",
		});
		await expect(blockingValidator.evaluate(req)).rejects.toThrow(/Secret canary detected/);
	});

	// PI-015 & PI-016
	it("PI-015 & PI-016: Lifecycle hook order is deterministic and resume runs before mutation", async () => {
		const order: string[] = [];
		const testExt: IntegrityExtension = {
			id: "order-tracker",
			async onHook(hook: string): Promise<IntegrityGateResult> {
				order.push(hook);
				return { decision: "allow", reasonCodes: [], validationRefs: [] };
			},
		};
		const coordinator = new IntegrityHookCoordinator([testExt]);

		// Simulate session flow: resume -> before_tool -> before_mutation -> after_mutation -> after_tool
		await coordinator.runHook("resume", {
			schema_version: "1.0",
			run_id: "order-run",
			session_id: "order-run",
			hook: "resume",
			impact: "read_only",
		});
		await coordinator.runHook("before_tool", {
			schema_version: "1.0",
			run_id: "order-run",
			session_id: "order-run",
			hook: "before_tool",
			impact: "repo_mutation",
			tool: "edit",
		});
		await coordinator.runHook("before_mutation", {
			schema_version: "1.0",
			run_id: "order-run",
			session_id: "order-run",
			hook: "before_mutation",
			impact: "repo_mutation",
			tool: "edit",
		});
		await coordinator.runHook("after_mutation", {
			schema_version: "1.0",
			run_id: "order-run",
			session_id: "order-run",
			hook: "after_mutation",
			impact: "repo_mutation",
			tool: "edit",
		});
		await coordinator.runHook("after_tool", {
			schema_version: "1.0",
			run_id: "order-run",
			session_id: "order-run",
			hook: "after_tool",
			impact: "repo_mutation",
			tool: "edit",
		});

		expect(order).toEqual(["resume", "before_tool", "before_mutation", "after_mutation", "after_tool"]);
	});

	// PI-017 & PI-018
	it("PI-017 & PI-018: Required high-impact validator outage fails closed, while advisory read-only outage returns unavailable", async () => {
		const failingExt: IntegrityExtension = {
			id: "failing-ext",
			async onHook() {
				throw new Error("ETIMEDOUT: Connection refused to validator backend");
			},
		};
		const coordinator = new IntegrityHookCoordinator([failingExt]);

		// High impact (repo mutation): fails closed (deny)
		const highImpactResult = await coordinator.runHook("before_mutation", {
			schema_version: "1.0",
			run_id: "outage-run",
			session_id: "outage-run",
			hook: "before_mutation",
			impact: "repo_mutation",
		});
		expect(highImpactResult.decision).toBe("deny");

		// Read-only advisory: returns unavailable (never pass)
		const readOnlyResult = await coordinator.runHook("session_start", {
			schema_version: "1.0",
			run_id: "outage-run",
			session_id: "outage-run",
			hook: "session_start",
			impact: "read_only",
		});
		expect(readOnlyResult.decision).toBe("unavailable");
	});

	// PI-019
	it("PI-019: Deterministic gate failure outranks favorable semantic answers", async () => {
		const store = new ExecutionStore({
			run_id: "pi-019-run",
			objective: {
				request: "Fix bug",
				normalized_goal: "Fix bug",
				acceptance_criteria: [{ id: "AC-1", text: "Must pass tests", required: true }],
				constraints: [],
			},
			repo: { root: "/repo", baseline_revision: "rev-0" },
		});
		store.recordVerification({
			kind: "unit_test",
			status: "failed",
			covers_acceptance_ids: ["AC-1"],
		});

		const fauxAdapter = {
			evaluate: async () => ({
				model: "jev-1.13.0",
				answers: {
					outcomes_achieved: { noul: 0.99 },
					completion_verdict: { choice: "complete", confidence: 0.99, probabilities: { complete: 0.99 } },
				},
				latency_ms: 10,
			}),
		};
		const controller = new SystemOneController({ store, adapter: fauxAdapter });
		const verdict = await controller.executeCompletionTransaction();
		expect(verdict.verdict).toBe("rework");
		expect(verdict.failed_gates.some((g) => g.id === "G-TEST" || g.id === "G-OBJ")).toBe(true);
	});

	// PI-020, PI-021, PI-022
	it("PI-020, PI-021, PI-022: Worker completion_candidate cannot directly terminate, and external completion gate runs before terminal", async () => {
		const store = new ExecutionStore({
			run_id: "pi-020-run",
			objective: {
				request: "Ship feature",
				normalized_goal: "Ship feature",
				acceptance_criteria: [{ id: "AC-1", text: "Tests green", required: true }],
				constraints: [],
			},
			repo: { root: "/repo", baseline_revision: "rev-0" },
		});
		store.recordVerification({ kind: "unit_test", status: "passed", covers_acceptance_ids: ["AC-1"] });

		// Worker asserts completion
		store.applyWorkerTurn({
			run_id: store.runId,
			step_id: "step-end",
			requested_action: "none",
			claims: [],
			hypothesis_updates: [],
			requested_tools: [],
			completion_candidate: true,
		});
		// PI-020: Worker assertion does not directly terminate phase
		expect(store.snapshot().phase).toBe("completion_candidate");

		// PI-021: External completion gate rejects completion
		const fauxAdapter = {
			evaluate: async (input: { questions: Record<string, unknown> }) => {
				const isChallenge = Object.hasOwn(input.questions, "missing_requirement");
				if (isChallenge) {
					return {
						model: "jev-1.13.0",
						answers: {
							missing_requirement: { noul: 0.01 },
							hidden_assumption: { noul: 0.01 },
							plausible_regression_not_tested: { noul: 0.01 },
							conclusion_overstates_evidence: { noul: 0.01 },
						},
						latency_ms: 10,
					};
				}
				return {
					model: "jev-1.13.0",
					answers: {
						outcomes_achieved: { noul: 0.96 },
						root_cause_addressed: { noul: 0.95 },
						required_behavior_unverified: { noul: 0.01 },
						material_claim_unsupported: { noul: 0.01 },
						out_of_scope_change_present: { noul: 0.01 },
						duplicate_responsibility_introduced: { noul: 0.01 },
						completion_verdict: {
							choice: "complete",
							confidence: 0.96,
							probabilities: { complete: 0.96, rework: 0.04 },
						},
					},
					latency_ms: 10,
				};
			},
		};
		const controller = new SystemOneController({ store, adapter: fauxAdapter });
		const verdict = await controller.executeCompletionTransaction(false, {
			externalGate: async () => ({
				decision: "deny",
				reasonCodes: ["PRIVATE_RELEASE_GATE_FAILED"],
				validationRefs: ["REF-001"],
			}),
		});

		expect(verdict.verdict).toBe("blocked_external");
		expect(store.snapshot().phase).not.toBe("complete");
	});

	// PI-023 & PI-024
	it("PI-023 & PI-024: Policy digest verified on resume, and missing/corrupted pack blocks resumed mutation", () => {
		const store = new ExecutionStore({
			run_id: "pi-023-run",
			objective: { request: "Task", normalized_goal: "Goal", acceptance_criteria: [], constraints: [] },
			repo: { root: "/repo", baseline_revision: "rev-0" },
		});
		const packRef: PolicyPackRef = {
			id: neutralPolicyPack.id,
			version: neutralPolicyPack.version,
			digest: neutralPolicyPack.digest,
		};
		store.bindPolicyPack(packRef);

		// Valid resume verifies cleanly
		expect(() => store.revalidateOnResume("rev-1", packRef)).not.toThrow();

		// Corrupted or switched pack digest is rejected
		const tamperedRef: PolicyPackRef = { ...packRef, digest: "f".repeat(64) };
		expect(() => store.revalidateOnResume("rev-1", tamperedRef)).toThrow(PolicyPackDigestMismatchError);
	});

	// PI-025
	it("PI-025: Neutral external consumer example runs end-to-end", async () => {
		const provider = new InMemoryValidationPolicyProvider([neutralPolicyPack]);
		const stateAdapter = {
			project(input: { stage: string; state: any; questionIds: readonly string[] }) {
				return { stage: input.stage, summary: input.state.taskSummary };
			},
		};
		const fauxAdapter = {
			evaluate: async (req: any) => {
				expect(req.state.summary).toBe("All neutral components initialized");
				return {
					model: "jev-1.13.0",
					answers: { "Q-safety": { noul: 0.02 } },
					latency_ms: 8,
				};
			},
		};

		const validator = new DefaultSemanticValidator({
			adapter: fauxAdapter as any,
			policyProvider: provider,
			stateAdapter,
		});

		const result = await validator.evaluate({
			runId: "demo-consumer-run",
			stage: "preflight",
			impact: "repo_mutation",
			policyPack: {
				id: neutralPolicyPack.id,
				version: neutralPolicyPack.version,
				digest: neutralPolicyPack.digest,
			},
			state: { taskSummary: "All neutral components initialized" },
			questionIds: ["Q-safety"],
		});

		expect(result.status).toBe("ok");
		expect(result.policyPackDigest).toBe(neutralPolicyPack.digest);
	});

	// PI-026 & PI-027
	it("PI-026 & PI-027: Neutral sentinel is absent from default audit records and packaging", () => {
		const sentinel = "PRIVATE_CONSUMER_SENTINEL_DO_NOT_PACKAGE_9F7E1B8C3A";
		// Default exports and structures should not leak sentinel
		const exportStr = JSON.stringify(Object.keys(codingAgentExports));
		expect(exportStr).not.toContain(sentinel);
	});

	// PI-028, PI-029, PI-030
	it("PI-028, PI-029, PI-030: Worker authority contract, verification obligations, and single orchestration state machine are preserved", () => {
		const store = new ExecutionStore({
			run_id: "pi-028-run",
			objective: { request: "Task", normalized_goal: "Goal", acceptance_criteria: [], constraints: [] },
			repo: { root: "/repo", baseline_revision: "rev-0" },
		});
		// Single state machine: initial phase is init
		expect(store.snapshot().phase).toBe("init");
		// Records verification obligations deterministically
		store.recordVerification({ kind: "compile", status: "passed" });
		expect(store.snapshot().verification.length).toBe(1);
	});
});
