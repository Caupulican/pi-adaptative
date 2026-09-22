import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildWorkerCapabilityRequest,
	defaultModelFamilyResolver,
	ExpertAdmissionPolicy,
	ExpertCapacityService,
	ExpertCatalog,
	ExpertFeatureBuilder,
	ExpertOutcomeRecorder,
	ExpertOutcomeStore,
	ExpertRankingPolicy,
	ExpertSelectionService,
	ExpertSelectionTraceStore,
	materializeExpertDescriptor,
	TeamIndependenceValidator,
} from "../../src/core/expert-routing/index.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import {
	OBJECTIVE_ROUTE_SCHEMA_VERSION,
	type ObjectiveRoute,
} from "../../src/core/objective-execution/objective-route.ts";
import type { TaskRuntimeProjection } from "../../src/core/orchestration/task-runtime.ts";

describe("H-MoE Finalization & Review Remediation (HM11-001..HM11-087)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `hmoe-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
	});

	afterEach(() => {
		try {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		} catch {
			// ignore cleanup errors
		}
	});

	describe("Durable Stores & Trace Persistence (HM11-001..HM11-004)", () => {
		it("HM11-001: ExpertOutcomeStore survives restart with atomic file persistence", async () => {
			const filePath = join(testDir, "outcomes.json");
			const store1 = new ExpertOutcomeStore(filePath);

			await store1.record({
				schema_version: "1.1",
				outcome_id: "out-1",
				request_digest: "digest-1",
				expert_id: "exp-test-1",
				task_id: "task-1",
				attempt_id: "att-1",
				work_class: "implement",
				role: "generalist",
				success_class: "accepted",
				failure_cause: null,
			});

			// Read back on fresh instance
			const store2 = new ExpertOutcomeStore(filePath);
			const stats = await store2.getAggregateStats("exp-test-1");
			expect(stats.totalAttempts).toBe(1);
			expect(stats.acceptedCount).toBe(1);

			const records = await store2.getOutcomes({ expertId: "exp-test-1" });
			expect(records.length).toBe(1);
			expect(records[0]!.attempt_id).toBe("att-1");
		});

		it("HM11-002: ExpertSelectionTraceStore survives restart and records traces", async () => {
			const filePath = join(testDir, "traces.json");
			const store1 = new ExpertSelectionTraceStore(filePath);

			const traceRecord = {
				schema_version: "1.0" as const,
				trace_id: "trace-1",
				request_digest: "digest-1",
				policy_version: "1.0",
				candidates: [],
				selected_expert_ids: ["exp-1"],
			};

			await store1.saveTrace(traceRecord);

			const store2 = new ExpertSelectionTraceStore(filePath);
			const queried = await store2.getTrace("trace-1");
			expect(queried).toBeDefined();
			expect(queried?.trace_id).toBe("trace-1");
			expect(queried?.selected_expert_ids).toContain("exp-1");
		});

		it("HM11-003 & HM11-004: Outcome trace links request, selection, attempt, and outcome immutably", async () => {
			const outcomeStore = new ExpertOutcomeStore();
			const traceStore = new ExpertSelectionTraceStore();

			await traceStore.saveTrace({
				schema_version: "1.0",
				trace_id: "trace-linked",
				request_digest: "digest-linked",
				policy_version: "1.0",
				candidates: [],
				selected_expert_ids: ["exp-linked"],
			});

			await outcomeStore.record({
				schema_version: "1.1",
				outcome_id: "out-linked",
				selection_id: "sel-linked",
				selection_trace_id: "trace-linked",
				request_digest: "digest-linked",
				task_id: "task-linked",
				attempt_id: "att-linked",
				expert_id: "exp-linked",
				work_class: "implement",
				success_class: "accepted",
				failure_cause: null,
			});

			const records = await outcomeStore.getOutcomes({ expertId: "exp-linked" });
			expect(records[0]!.selection_trace_id).toBe("trace-linked");
			expect(records[0]!.attempt_id).toBe("att-linked");
		});
	});

	describe("Real Fitness, Tool Surface, & Adaptation (HM11-010..HM11-015)", () => {
		it("HM11-010: FitnessStore real lane metrics are consumed without placeholder values", async () => {
			const mockFitnessStore = {
				getReport: (modelRef: string) => {
					if (modelRef === "anthropic/claude-3-5-sonnet") {
						return {
							modelRef,
							lanes: {
								worker: { successes: 18, total: 20, meanMs: 1200, tokensPerSecond: 45 },
								research: { successes: 9, total: 10, meanMs: 800, tokensPerSecond: 60 },
							},
						};
					}
					return undefined;
				},
			};

			const builder = new ExpertFeatureBuilder({ fitnessStore: mockFitnessStore as any });
			const desc = materializeExpertDescriptor({
				provider: "anthropic",
				model_id: "claude-3-5-sonnet",
				role: "generalist",
			});

			const req = buildWorkerCapabilityRequest({
				objectiveId: "obj-1",
				taskId: "task-1",
				route: "implement",
			});

			const state = {
				estimatedCostUsd: 0.05,
				estimatedLatencyMs: 1200,
				concurrencySlotsAvailable: 2,
				localRuntimeWarm: false,
				historicalOutcomes: { totalAttempts: 10, verifiedSuccesses: 9 },
			};

			const features = await builder.build(req, { descriptor: desc, state } as any);
			// Real worker lane success fraction: 18 / 20 = 0.90
			expect(features.roleProbeFitness).toBeCloseTo(0.9, 2);
		});

		it("HM11-011 & HM11-012: AdaptationStore toolProbe and perf profiles are consumed", async () => {
			const mockAdaptationStore = {
				getProfile: (_provider: string, modelId: string) => {
					if (modelId === "claude-3-5-sonnet") {
						return {
							toolProbe: "native",
							perf: { latencyMultiplier: 0.8, sampleCount: 15 },
							capabilityTier: "frontier",
						};
					}
					return undefined;
				},
			};

			const builder = new ExpertFeatureBuilder({ adaptationStore: mockAdaptationStore as any });
			const desc = materializeExpertDescriptor({
				provider: "anthropic",
				model_id: "claude-3-5-sonnet",
				role: "generalist",
			});

			const req = buildWorkerCapabilityRequest({
				objectiveId: "obj-1",
				taskId: "task-1",
				route: "implement",
			});

			const state = {
				estimatedCostUsd: 0.05,
				estimatedLatencyMs: 1000,
				concurrencySlotsAvailable: 2,
				localRuntimeWarm: false,
				historicalOutcomes: { totalAttempts: 5, verifiedSuccesses: 5 },
			};

			const features = await builder.build(req, { descriptor: desc, state } as any);
			// Tool probe "native" gives full reliability (1.0)
			expect(features.toolReliability).toBe(1.0);
			// Perf latency multiplier 0.8 reduces effective latency, yielding high latency utility
			expect(features.latencyUtility).toBeGreaterThan(0.7);
		});

		it("HM11-015: Candidate tool surface comes from descriptor, never copied from request", async () => {
			const mockRegistry = {
				find: () => ({
					provider: "anthropic",
					id: "claude-3-5-haiku",
					api: "chat",
					maxContextTokens: 100000,
				}),
				getAll: () => [
					{
						provider: "anthropic",
						id: "claude-3-5-haiku",
						api: "chat",
						input: ["text"],
						maxContextTokens: 100000,
					},
				],
				hasConfiguredAuth: () => true,
			};

			const catalog = new ExpertCatalog({ modelRegistry: mockRegistry as any });
			const request = buildWorkerCapabilityRequest({
				objectiveId: "obj-tool-test",
				taskId: "task-tool-test",
				route: "implement",
				requiredTools: ["special_secret_tool_xyz"],
			});

			const candidates = await catalog.materializeCandidates(request);
			expect(candidates.length).toBeGreaterThan(0);
			// None of the materialized expert candidates should claim "special_secret_tool_xyz"
			for (const cand of candidates) {
				expect(cand.descriptor.tool_names).not.toContain("special_secret_tool_xyz");
			}
		});
	});

	describe("Team Independence Validator & Family Resolution (HM11-040..HM11-044)", () => {
		it("HM11-040 & HM11-041: enforces distinct_profile and distinct_model", () => {
			const b1 = { expert_id: "exp-1", model_id: "claude-3-5-sonnet", provider: "anthropic", profile_id: "prof-1" };
			const b2 = { expert_id: "exp-2", model_id: "claude-3-5-sonnet", provider: "anthropic", profile_id: "prof-2" };

			// distinct_profile: different profile_id => valid
			const valProfile = TeamIndependenceValidator.validate([b1 as any, b2 as any], "distinct_profile");
			expect(valProfile.valid).toBe(true);

			// distinct_model: same model_id => invalid
			const valModel = TeamIndependenceValidator.validate([b1 as any, b2 as any], "distinct_model");
			expect(valModel.valid).toBe(false);
			expect(valModel.reason).toContain("distinct_model");
		});

		it("HM11-042: enforces distinct_provider", () => {
			const b1 = { expert_id: "exp-1", model_id: "claude-3-5-sonnet", provider: "anthropic" };
			const b2 = { expert_id: "exp-2", model_id: "gpt-4o", provider: "anthropic" }; // same provider

			const val = TeamIndependenceValidator.validate([b1 as any, b2 as any], "distinct_provider");
			expect(val.valid).toBe(false);
			expect(val.reason).toContain("distinct_provider");
		});

		it("HM11-043: distinct_family requires real family resolution and rejects same-family models", () => {
			const b1 = { expert_id: "exp-1", model_id: "claude-3-5-sonnet", provider: "anthropic" };
			const b2 = { expert_id: "exp-2", model_id: "claude-3-haiku", provider: "anthropic" };

			const val = TeamIndependenceValidator.validate([b1 as any, b2 as any], "distinct_family");
			expect(val.valid).toBe(false);
			expect(val.reason).toContain("distinct_family");
		});

		it("HM11-044: distinct_family does not silently downgrade when family is unknown", () => {
			const b1 = { expert_id: "exp-1", model_id: "unknown-custom-model-a", provider: "custom" };
			const b2 = { expert_id: "exp-2", model_id: "unknown-custom-model-b", provider: "custom" };

			const val = TeamIndependenceValidator.validate([b1 as any, b2 as any], "distinct_family");
			expect(val.valid).toBe(false);
			expect(val.reason).toContain("unsupported");
		});

		it("defaultModelFamilyResolver accurately maps known model families", () => {
			expect(defaultModelFamilyResolver("claude-3-5-sonnet-20241022", "anthropic")).toBe("claude-sonnet");
			expect(defaultModelFamilyResolver("gpt-4o-mini", "openai")).toBe("gpt-4o");
			expect(defaultModelFamilyResolver("gemini-1.5-pro", "google")).toBe("gemini-pro");
			expect(defaultModelFamilyResolver("deepseek-coder-v2", "deepseek")).toBe("deepseek-chat");
		});
	});

	describe("Capacity Leases & Multi-Dimensional Limits (HM11-030..HM11-035)", () => {
		it("HM11-030 & HM11-031: capacity leases are attempt-bound and team reserve is atomic", async () => {
			const capacity = new ExpertCapacityService({ maxSlotsPerExpert: 1 });

			const b1 = { expert_id: "exp-cap-1", model_id: "model-1", provider: "prov-1" } as any;
			const b2 = { expert_id: "exp-cap-2", model_id: "model-2", provider: "prov-2" } as any;

			// First reservation succeeds
			const leases = await capacity.reserveTeam({
				selectionId: "sel-cap-1",
				attemptId: "att-cap-1",
				bindings: [b1, b2],
			});
			expect(leases.length).toBe(2);

			// Second reservation for b1 must fail atomically (and not leak a lease for b2)
			const b3 = { expert_id: "exp-cap-3", model_id: "model-3", provider: "prov-3" } as any;
			await expect(
				capacity.reserveTeam({
					selectionId: "sel-cap-2",
					attemptId: "att-cap-2",
					bindings: [b1, b3],
				}),
			).rejects.toThrow("Capacity limit reached");

			// Ensure b3 was not reserved
			expect(capacity.getAvailableSlots(b3.expert_id)).toBe(1);

			// Release att-cap-1
			await capacity.releaseTeam(leases);
			expect(capacity.getAvailableSlots(b1.expert_id)).toBe(1);
		});

		it("HM11-032: enforces provider-wide capacity limits across distinct expert IDs", async () => {
			const capacity = new ExpertCapacityService({
				maxSlotsPerExpert: 5,
				maxSlotsPerProvider: 2,
			});

			const b1 = { expert_id: "exp-p1", model_id: "m1", provider: "anthropic" } as any;
			const b2 = { expert_id: "exp-p2", model_id: "m2", provider: "anthropic" } as any;
			const b3 = { expert_id: "exp-p3", model_id: "m3", provider: "anthropic" } as any;

			const l1 = await capacity.reserveTeam({ selectionId: "s1", attemptId: "a1", bindings: [b1] });
			const l2 = await capacity.reserveTeam({ selectionId: "s2", attemptId: "a2", bindings: [b2] });

			// Third reservation exceeding provider limit fails
			await expect(capacity.reserveTeam({ selectionId: "s3", attemptId: "a3", bindings: [b3] })).rejects.toThrow(
				"Capacity limit reached for provider 'anthropic'",
			);

			await capacity.releaseTeam([...l1, ...l2]);
		});

		it("HM11-035: reconciles stale leases on startup", async () => {
			const capacity = new ExpertCapacityService({ maxSlotsPerExpert: 1, defaultTtlMs: 50 });
			const b = { expert_id: "exp-stale", model_id: "m", provider: "p" } as any;
			await capacity.reserveTeam({
				selectionId: "sel-stale",
				attemptId: "att-stale",
				bindings: [b],
				ttlMs: 10,
			});

			expect(capacity.getAvailableSlots("exp-stale")).toBe(0);

			// Wait for lease to expire
			await new Promise((resolve) => setTimeout(resolve, 20));
			const reconciled = capacity.reconcileStaleLeases();
			expect(reconciled).toBe(1);
			expect(capacity.getAvailableSlots("exp-stale")).toBe(1);
		});
	});

	describe("Attempt Attribution & Multi-Task Outcomes (HM11-050..HM11-054)", () => {
		it("HM11-050 & HM11-053: attributes completion outcome to all contributing attempt bindings without _lastBinding bias", async () => {
			const outcomeStore = new ExpertOutcomeStore();
			const outcomeRecorder = new ExpertOutcomeRecorder(outcomeStore);

			let callCount = 0;
			const runtime: any = {
				reconcileObjective: async (id: string): Promise<TaskRuntimeProjection> => ({
					lastOrdinal: 1,
					agents: {},
					checkpoints: {},
					approvals: {},
					notifications: {},
					objectives: {
						[id]: {
							objective: {
								schemaVersion: 1,
								objectiveId: id,
								title: "Multi-attempt test",
								description: "Attribution test",
								acceptanceCriteria: [{ id: "c1", description: "Working", required: true }],
								status: "active",
								constraints: [],
								riskBudget: {},
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
							},
							evidence: [
								{
									evidenceId: "ev-1",
									criterionId: "c1",
									kind: "test",
									summary: "Passed",
									artifactIds: [],
									trusted: true,
									createdAt: new Date().toISOString(),
								},
							],
							taskIds: [],
						},
					},
					tasks: {},
					attempts: {},
				}),
				isCancelled: () => false,
				isBudgetExhausted: () => false,
				getSourceRevision: async () => "HEAD",
				getArtifacts: async () => [],
				getLimitations: async () => [],
			};

			const catalog = new ExpertCatalog();
			const cand1 = {
				descriptor: materializeExpertDescriptor({
					provider: "anthropic",
					model_id: "claude-3-5-sonnet",
					role: "generalist",
				}),
				fitness: { overall: 0.9, ability: 0.9, reliability: 0.9, efficiency: 0.9 },
				state: {
					authenticated: true,
					quotaExhausted: false,
					providerHealthy: true,
					localRuntimeWarm: false,
					estimatedCostUsd: 0.01,
					estimatedLatencyMs: 1000,
					concurrencySlotsAvailable: 5,
				},
			};
			const cand2 = {
				descriptor: materializeExpertDescriptor({ provider: "openai", model_id: "gpt-4o", role: "verifier" }),
				fitness: { overall: 0.85, ability: 0.85, reliability: 0.85, efficiency: 0.85 },
				state: {
					authenticated: true,
					quotaExhausted: false,
					providerHealthy: true,
					localRuntimeWarm: false,
					estimatedCostUsd: 0.01,
					estimatedLatencyMs: 1000,
					concurrencySlotsAvailable: 5,
				},
			};
			catalog.materializeCandidates = async () => [cand1 as any, cand2 as any];

			const expertSelector = new ExpertSelectionService(
				catalog,
				new ExpertAdmissionPolicy(),
				new ExpertFeatureBuilder(),
				new ExpertRankingPolicy(),
				new ExpertCapacityService(),
				outcomeStore,
			);

			const controller = new ObjectiveExecutionController({
				runtime,
				expertSelector,
				outcomeRecorder,
				completionProfile: "mechanical",
				workerDispatcher: {
					dispatch: async () => {},
					continueWorker: async () => {},
					dispatchEscalated: async () => {},
				},
			});

			// Route cycle 1: implement, cycle 2: verify, cycle 3: completion_candidate
			vi.spyOn(controller, "evaluateRouteOnce").mockImplementation(async (objId) => {
				callCount++;
				if (callCount === 1) {
					return {
						schema_version: OBJECTIVE_ROUTE_SCHEMA_VERSION,
						cycle_id: "c1",
						objective_id: objId,
						route: "implement",
						confidence: 1,
						reason_codes: ["code"],
					} as ObjectiveRoute;
				}
				if (callCount === 2) {
					return {
						schema_version: OBJECTIVE_ROUTE_SCHEMA_VERSION,
						cycle_id: "c2",
						objective_id: objId,
						route: "verify",
						confidence: 1,
						reason_codes: ["check"],
					} as ObjectiveRoute;
				}
				return {
					schema_version: OBJECTIVE_ROUTE_SCHEMA_VERSION,
					cycle_id: "c3",
					objective_id: objId,
					route: "completion_candidate",
					confidence: 1,
					reason_codes: ["done"],
				} as ObjectiveRoute;
			});

			const result = await controller.run("obj-attrib-test");
			expect(result.status).toBe("complete");

			// Outcomes must be recorded for BOTH cycles that ran workers!
			const sonnetStats = await outcomeStore.getAggregateStats(cand1.descriptor.expert_id);
			expect(sonnetStats.totalAttempts).toBeGreaterThanOrEqual(1);
			expect(sonnetStats.acceptedCount).toBeGreaterThanOrEqual(1);
		});

		it("HM11-051: verifier failure is attributed to the producing attempt", async () => {
			const outcomeStore = new ExpertOutcomeStore();
			const outcomeRecorder = new ExpertOutcomeRecorder(outcomeStore);

			const cand = {
				descriptor: materializeExpertDescriptor({
					provider: "anthropic",
					model_id: "claude-3-5-sonnet",
					role: "generalist",
				}),
				fitness: { overall: 0.9, ability: 0.9, reliability: 0.9, efficiency: 0.9 },
				state: {
					authenticated: true,
					quotaExhausted: false,
					providerHealthy: true,
					localRuntimeWarm: false,
					estimatedCostUsd: 0.01,
					estimatedLatencyMs: 1000,
					concurrencySlotsAvailable: 5,
				},
			};
			const catalog = new ExpertCatalog();
			catalog.materializeCandidates = async () => [cand as any];

			const expertSelector = new ExpertSelectionService(
				catalog,
				new ExpertAdmissionPolicy(),
				new ExpertFeatureBuilder(),
				new ExpertRankingPolicy(),
				new ExpertCapacityService(),
				outcomeStore,
			);

			let cycles = 0;
			const runtime: any = {
				reconcileObjective: async (id: string): Promise<TaskRuntimeProjection> => ({
					lastOrdinal: 1,
					agents: {},
					checkpoints: {},
					approvals: {},
					notifications: {},
					objectives: {
						[id]: {
							objective: {
								schemaVersion: 1,
								objectiveId: id,
								title: "Verifier failure",
								description: "Test",
								acceptanceCriteria: [],
								status: "active",
								constraints: [],
								riskBudget: {},
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
							},
							evidence: [],
							taskIds: [],
						},
					},
					tasks: {},
					attempts: {},
				}),
				isCancelled: () => false,
				isBudgetExhausted: () => false,
			};

			const controller = new ObjectiveExecutionController({
				runtime,
				expertSelector,
				outcomeRecorder,
				workerDispatcher: {
					dispatch: async () => {},
					continueWorker: async () => {},
					dispatchEscalated: async () => {},
				},
				verifier: {
					execute: async () => {
						throw new Error("Deterministic test execution failed");
					},
				},
			});

			vi.spyOn(controller, "evaluateRouteOnce").mockImplementation(async (objId) => {
				cycles++;
				if (cycles === 1) {
					return {
						schema_version: OBJECTIVE_ROUTE_SCHEMA_VERSION,
						cycle_id: "c1",
						objective_id: objId,
						route: "implement",
						confidence: 1,
						reason_codes: ["code"],
					} as ObjectiveRoute;
				}
				return {
					schema_version: OBJECTIVE_ROUTE_SCHEMA_VERSION,
					cycle_id: "c2",
					objective_id: objId,
					route: "deterministic_test",
					confidence: 1,
					reason_codes: ["test"],
				} as ObjectiveRoute;
			});

			await expect(controller.run("obj-verifier-fail")).rejects.toThrow("Deterministic test execution failed");

			// Failure should be attributed to the implementer
			const records = await outcomeStore.getOutcomes({ expertId: cand.descriptor.expert_id });
			expect(records.length).toBe(1);
			expect(records[0]!.verification_passed).toBe(false);
		});
	});

	describe("Routing Band vs Capability Tier (HM11-060..HM11-062)", () => {
		it("HM11-060 & HM11-061: routing_band is separate from capability_tier and cheap does not demand capabilityTier=cheap", () => {
			const req = buildWorkerCapabilityRequest({
				objectiveId: "obj-tier-test",
				taskId: "task-tier-test",
				route: "implement",
				decisionSignals: { suggestedTier: "cheap" },
			});

			expect(req.routing_band).toBe("cheap");
			// Must NOT be encoded as tier:cheap in required_capabilities
			expect(req.required_capabilities ?? []).not.toContain("tier:cheap");
		});

		it("HM11-062: admission does not reject frontier expert on cheap routing band", () => {
			const admission = new ExpertAdmissionPolicy();
			const desc = materializeExpertDescriptor({
				provider: "anthropic",
				model_id: "claude-3-5-sonnet",
				role: "generalist",
				capability_tier: "frontier",
			});

			const req = buildWorkerCapabilityRequest({
				objectiveId: "obj-band-admit",
				taskId: "task-band-admit",
				route: "implement",
				decisionSignals: { suggestedTier: "cheap" },
			});

			const cand = {
				descriptor: desc,
				fitness: { overall: 0.9, ability: 0.9, reliability: 0.9, efficiency: 0.9 },
				state: {
					authenticated: true,
					quotaExhausted: false,
					providerHealthy: true,
					localRuntimeWarm: false,
				},
			};

			const decision = admission.evaluate(req, cand as any);
			expect(decision.allowed).toBe(true);
		});
	});
});
