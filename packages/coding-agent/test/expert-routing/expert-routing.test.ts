import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildWorkerCapabilityRequest,
	computeExpertIdentityDigest,
	ExpertAdmissionPolicy,
	type ExpertCandidate,
	type ExpertCandidateState,
	ExpertCapacityService,
	ExpertCatalog,
	type ExpertDescriptor,
	ExpertFeatureBuilder,
	ExpertOutcomeRecorder,
	ExpertOutcomeStore,
	ExpertRankingPolicy,
	ExpertSelectionService,
	materializeExpertDescriptor,
} from "../../src/core/expert-routing/index.ts";
import { ModelRouterController } from "../../src/core/model-router-controller.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/index.ts";

function createMockCandidate(overrides?: {
	expert_id?: string;
	model_id?: string;
	provider?: string;
	role?: string;
	thinking_level?: string;
	runtime_kind?: "remote" | "local" | "managed-local";
	capability_tier?: string;
	tool_names?: string[];
	context_window?: number;
	authenticated?: boolean;
	quotaExhausted?: boolean;
	providerHealthy?: boolean;
	estimatedCostUsd?: number;
	estimatedLatencyMs?: number;
	localResourcesInsufficient?: boolean;
}): ExpertCandidate {
	const provider = overrides?.provider ?? "anthropic";
	const model_id = overrides?.model_id ?? "claude-3-5-sonnet";
	const role = overrides?.role ?? "generalist";
	const thinking_level = overrides?.thinking_level ?? "off";
	const runtime_kind = overrides?.runtime_kind ?? "remote";
	const expert_id =
		overrides?.expert_id ?? `exp_${provider}_${model_id}_${role}_${thinking_level}`.replace(/[^a-zA-Z0-9_-]/g, "_");

	const descriptor: ExpertDescriptor = {
		schema_version: "1.0",
		expert_id,
		provider,
		model_id,
		role,
		thinking_level,
		runtime_kind,
		capability_class: "general",
		capability_tier: overrides?.capability_tier ?? "expensive",
		tool_names: overrides?.tool_names ?? ["bash", "read", "edit", "write"],
		context_window: overrides?.context_window ?? 200000,
		privacy_class: runtime_kind === "remote" ? "remote_allowed" : "local_only",
		identity_digest: computeExpertIdentityDigest({
			provider,
			model_id,
			role,
			thinking_level,
			tool_names: overrides?.tool_names ?? ["bash", "read", "edit", "write"],
		}),
	};

	const state: ExpertCandidateState = {
		authenticated: overrides?.authenticated ?? true,
		quotaExhausted: overrides?.quotaExhausted ?? false,
		providerHealthy: overrides?.providerHealthy ?? true,
		estimatedCostUsd: overrides?.estimatedCostUsd ?? 0.015,
		estimatedLatencyMs: overrides?.estimatedLatencyMs ?? 1200,
		localResourcesInsufficient: overrides?.localResourcesInsufficient ?? false,
		concurrencySlotsAvailable: 4,
	};

	return { descriptor, state };
}

describe("H-MoE Expert Routing Substrate (HMOE-001..HMOE-125)", () => {
	describe("Contracts & Deterministic Identity (HMOE-001..HMOE-005, HMOE-030..HMOE-032)", () => {
		it("HMOE-001: buildWorkerCapabilityRequest constructs validated request", () => {
			const req = buildWorkerCapabilityRequest({
				objectiveId: "obj-123",
				taskId: "task-456",
				route: "implement",
				consequence: "high",
				requiredTools: ["bash", "write"],
				decisionSignals: { suggestedTier: "expensive" },
			});

			expect(req.schema_version).toBe("1.0");
			expect(req.objective_id).toBe("obj-123");
			expect(req.task_id).toBe("task-456");
			expect(req.work_class).toBe("implement");
			expect(req.consequence).toBe("high");
			expect(req.required_tools).toContain("bash");
			expect(req.routing_band).toBe("expensive");
			expect(req.request_id.startsWith("req_")).toBe(true);
		});

		it("HMOE-030: Same model materializes distinct expert IDs across roles and thinking levels", () => {
			const descGeneral = materializeExpertDescriptor({
				provider: "anthropic",
				model_id: "claude-3-5-sonnet",
				role: "generalist",
				thinking_level: "off",
			});
			const descVerifier = materializeExpertDescriptor({
				provider: "anthropic",
				model_id: "claude-3-5-sonnet",
				role: "verifier",
				thinking_level: "high",
			});

			expect(descGeneral.expert_id).not.toBe(descVerifier.expert_id);
			expect(descGeneral.identity_digest).not.toBe(descVerifier.identity_digest);
			expect(descGeneral.model_id).toBe(descVerifier.model_id);
		});

		it("HMOE-031: Expert identity digest is strictly deterministic", () => {
			const d1 = computeExpertIdentityDigest({
				provider: "openai",
				model_id: "gpt-4o",
				role: "coder",
				thinking_level: "low",
				tool_names: ["edit", "bash"],
			});
			const d2 = computeExpertIdentityDigest({
				provider: "openai",
				model_id: "gpt-4o",
				role: "coder",
				thinking_level: "low",
				// Reversed order should still produce identical digest due to internal sorting
				tool_names: ["bash", "edit"],
			});

			expect(d1).toBe(d2);
		});
	});

	describe("Hard Admission Filters (HMOE-020..HMOE-029)", () => {
		const policy = new ExpertAdmissionPolicy();

		it("rejects unauthenticated candidates with auth_missing", () => {
			const cand = createMockCandidate({ authenticated: false });
			const req = buildWorkerCapabilityRequest({ route: "implement" });
			const evalResult = policy.evaluate(req, cand);

			expect(evalResult.allowed).toBe(false);
			expect(evalResult.reasonCodes).toContain("auth_missing");
		});

		it("rejects quota-exhausted candidates with quota_exhausted", () => {
			const cand = createMockCandidate({ quotaExhausted: true });
			const req = buildWorkerCapabilityRequest({ route: "implement" });
			const evalResult = policy.evaluate(req, cand);

			expect(evalResult.allowed).toBe(false);
			expect(evalResult.reasonCodes).toContain("quota_exhausted");
		});

		it("rejects excluded experts and models", () => {
			const cand = createMockCandidate({ expert_id: "exp-blocked", model_id: "m-blocked" });
			const req = buildWorkerCapabilityRequest({
				route: "implement",
				excludedExpertIds: ["exp-blocked"],
				excludedModelRefs: ["m-blocked"],
			});
			const evalResult = policy.evaluate(req, cand);

			expect(evalResult.allowed).toBe(false);
			expect(evalResult.reasonCodes).toContain("expert_excluded");
			expect(evalResult.reasonCodes).toContain("model_excluded");
		});

		it("rejects remote candidate when local_only is true with privacy_violation", () => {
			const cand = createMockCandidate({ runtime_kind: "remote" });
			const req = buildWorkerCapabilityRequest({
				route: "implement",
				localOnly: true,
			});
			const evalResult = policy.evaluate(req, cand);

			expect(evalResult.allowed).toBe(false);
			expect(evalResult.reasonCodes).toContain("privacy_violation");
		});

		it("rejects insufficient context window with context_insufficient", () => {
			const cand = createMockCandidate({ context_window: 32000 });
			const req = buildWorkerCapabilityRequest({
				route: "implement",
				minimumContextWindow: 128000,
			});
			const evalResult = policy.evaluate(req, cand);

			expect(evalResult.allowed).toBe(false);
			expect(evalResult.reasonCodes).toContain("context_insufficient");
		});

		it("rejects excessive cost with cost_hard_limit", () => {
			const cand = createMockCandidate({ estimatedCostUsd: 0.5 });
			const req = buildWorkerCapabilityRequest({
				route: "implement",
				maxCostUsd: 0.1,
			});
			const evalResult = policy.evaluate(req, cand);

			expect(evalResult.allowed).toBe(false);
			expect(evalResult.reasonCodes).toContain("cost_hard_limit");
		});

		it("rejects missing tools with tools_insufficient", () => {
			const cand = createMockCandidate({ tool_names: ["read", "bash"] });
			const req = buildWorkerCapabilityRequest({
				route: "implement",
				requiredTools: ["write", "special_linter"],
			});
			const evalResult = policy.evaluate(req, cand);

			expect(evalResult.allowed).toBe(false);
			expect(evalResult.reasonCodes).toContain("tools_insufficient");
		});

		it("rejects candidate when local resources are insufficient", () => {
			const cand = createMockCandidate({
				runtime_kind: "local",
				localResourcesInsufficient: true,
			});
			const req = buildWorkerCapabilityRequest({ route: "implement" });
			const evalResult = policy.evaluate(req, cand);

			expect(evalResult.allowed).toBe(false);
			expect(evalResult.reasonCodes).toContain("local_resource_insufficient");
		});

		it("rejects candidate with independence_violation for distinct_model", () => {
			const cand = createMockCandidate({ model_id: "gpt-4o" });
			const req = buildWorkerCapabilityRequest({
				route: "verify",
				decisionSignals: { independentWorkerRequired: true },
				priorAttempts: [
					{
						attemptId: "att-1",
						status: "completed",
						modelId: "gpt-4o",
					},
				],
			});
			const evalResult = policy.evaluate(req, cand);

			expect(evalResult.allowed).toBe(false);
			expect(evalResult.reasonCodes).toContain("independence_violation");
		});
	});

	describe("Feature Scoring & Consequence Weighting (HMOE-040..HMOE-046)", () => {
		const outcomeStore = new ExpertOutcomeStore();
		const featureBuilder = new ExpertFeatureBuilder({ outcomeStore });

		it("HMOE-040: Produces explainable feature vector with normalized scores", async () => {
			const cand = createMockCandidate();
			const req = buildWorkerCapabilityRequest({
				route: "implement",
				consequence: "medium",
			});
			const features = await featureBuilder.build(req, cand);

			expect(features.totalScore).toBeGreaterThan(0);
			expect(features.capabilityFit).toBeGreaterThan(0);
			expect(features.costUtility).toBeGreaterThan(0);
			expect(features.latencyUtility).toBeGreaterThan(0);
		});

		it("HMOE-044: Critical consequence emphasizes ability and reliability over cost", async () => {
			const candExpensive = createMockCandidate({
				capability_tier: "expensive",
				estimatedCostUsd: 0.05,
			});
			const candCheap = createMockCandidate({
				capability_tier: "cheap",
				estimatedCostUsd: 0.001,
			});

			const reqCritical = buildWorkerCapabilityRequest({
				route: "implement",
				consequence: "critical",
			});
			const featCritExp = await featureBuilder.build(reqCritical, candExpensive);
			const featCritCheap = await featureBuilder.build(reqCritical, candCheap);

			expect(featCritExp.totalScore).toBeGreaterThan(featCritCheap.totalScore);

			const reqLow = buildWorkerCapabilityRequest({
				route: "retrieve",
				consequence: "low",
			});
			const featLowExp = await featureBuilder.build(reqLow, candExpensive);
			const featLowCheap = await featureBuilder.build(reqLow, candCheap);

			// Under low consequence, operational cost utility dominates
			expect(featLowCheap.totalScore).toBeGreaterThan(featLowExp.totalScore);
		});
	});

	describe("Team Selection & Ranking Policies (HMOE-050..HMOE-055)", () => {
		const ranking = new ExpertRankingPolicy();
		const capacity = new ExpertCapacityService();

		it("HMOE-050: Top-1 single mode selects highest scoring candidate", () => {
			const c1 = createMockCandidate({ expert_id: "c1", model_id: "m1" });
			const c2 = createMockCandidate({ expert_id: "c2", model_id: "m2" });
			const req = buildWorkerCapabilityRequest({ route: "implement" });

			const plan = ranking.select(
				req,
				[
					{ candidate: c1, features: { totalScore: 0.95 } as any },
					{ candidate: c2, features: { totalScore: 0.8 } as any },
				],
				"single",
			);

			expect(plan.primary.expert_id).toBe("c1");
			expect(plan.bindings.length).toBe(1);
			expect(plan.mode).toBe("single");
		});

		it("HMOE-051: Parallel scouts selects 2 distinct experts", () => {
			const c1 = createMockCandidate({ expert_id: "c1", model_id: "m1" });
			const c2 = createMockCandidate({ expert_id: "c2", model_id: "m2" });
			const req = buildWorkerCapabilityRequest({ route: "investigate" });

			const plan = ranking.select(
				req,
				[
					{ candidate: c1, features: { totalScore: 0.95 } as any },
					{ candidate: c2, features: { totalScore: 0.9 } as any },
				],
				"parallel_scouts",
			);

			expect(plan.bindings.length).toBe(2);
			expect(plan.bindings.map((b) => b.model_id)).toContain("m1");
			expect(plan.bindings.map((b) => b.model_id)).toContain("m2");
		});

		it("HMOE-053: Independent verifier mode selects independent candidate", () => {
			const c1 = createMockCandidate({ expert_id: "c1", model_id: "m1" });
			const c2 = createMockCandidate({ expert_id: "c2", model_id: "m2" });
			const req = buildWorkerCapabilityRequest({
				route: "verify",
				decisionSignals: { independentWorkerRequired: true },
			});

			const plan = ranking.select(
				req,
				[
					{ candidate: c1, features: { totalScore: 0.95 } as any },
					{ candidate: c2, features: { totalScore: 0.85 } as any },
				],
				"independent_verifier",
			);

			expect(plan.primary.expert_id).toBe("c1");
			expect(plan.mode).toBe("independent_verifier");
		});

		it("HMOE-093: ExpertCapacityService reserves and releases worker slots", async () => {
			const c1 = createMockCandidate({ expert_id: "c1" });
			const req = buildWorkerCapabilityRequest({ route: "implement" });
			const plan = ranking.select(req, [{ candidate: c1, features: { totalScore: 0.9 } as any }], "single");

			expect(capacity.getInFlightCount("c1")).toBe(0);
			await capacity.reserve(plan.bindings, req);
			expect(capacity.getInFlightCount("c1")).toBe(1);

			capacity.release(plan.bindings);
			expect(capacity.getInFlightCount("c1")).toBe(0);
		});
	});

	describe("Outcome Store & Statistical Learning (HMOE-070..HMOE-076)", () => {
		it("HMOE-070: Updates Beta posterior distribution on verified outcome", async () => {
			const store = new ExpertOutcomeStore();
			const recorder = new ExpertOutcomeRecorder(store);
			const _cand = createMockCandidate({ expert_id: "exp-learning" });
			const req = buildWorkerCapabilityRequest({ route: "implement" });

			const binding = {
				schema_version: "1.0" as const,
				selection_id: "sel-1",
				request_id: req.request_id,
				expert_id: "exp-learning",
				provider: "anthropic",
				model_id: "claude-3-5-sonnet",
				thinking_level: "off",
				selection_trace_id: "tr-1",
			};

			const initialStats = await store.getAggregateStats("exp-learning", "implement");
			expect(initialStats.totalAttempts).toBe(0);
			expect(initialStats.successRate).toBe(0.5); // Prior (1, 1)

			await recorder.record({
				binding,
				request: req,
				verificationPassed: true,
			});

			const afterSuccess = await store.getAggregateStats("exp-learning", "implement");
			expect(afterSuccess.totalAttempts).toBe(1);
			expect(afterSuccess.acceptedCount).toBe(1);
			expect(afterSuccess.successRate).toBeGreaterThan(0.5);

			await recorder.record({
				binding,
				request: req,
				verifierRejected: true,
			});

			const afterReject = await store.getAggregateStats("exp-learning", "implement");
			expect(afterReject.totalAttempts).toBe(2);
			expect(afterReject.rejectedCount).toBe(1);
		});

		it("HMOE-071: External environment failures do not penalize model outcome fitness", async () => {
			const store = new ExpertOutcomeStore();
			const recorder = new ExpertOutcomeRecorder(store);
			const req = buildWorkerCapabilityRequest({ route: "implement" });
			const binding = {
				schema_version: "1.0" as const,
				selection_id: "sel-1",
				request_id: req.request_id,
				expert_id: "exp-env-failure",
				provider: "openai",
				model_id: "gpt-4o",
				thinking_level: "off",
				selection_trace_id: "tr-1",
			};

			await recorder.record({
				binding,
				request: req,
				result: {
					status: "failed",
					errors: [{ code: "provider_rate_limit_exceeded", message: "429" }],
					error: { code: "provider_rate_limit_exceeded", message: "429" },
				} as any,
			});

			const stats = await store.getAggregateStats("exp-env-failure", "implement");
			expect(stats.externalFailureCount).toBe(1);
			expect(stats.rejectedCount).toBe(0);
		});
	});

	describe("ObjectiveExecutionController Integration (HMOE-011, HMOE-120..HMOE-124)", () => {
		it("HMOE-011 & HMOE-120: Dispatches worker with chosen ExpertBinding and records outcome", async () => {
			const cand = createMockCandidate({
				expert_id: "exp-verified-1",
				model_id: "m-worker-1",
				provider: "anthropic",
			});
			const catalog = new ExpertCatalog({
				modelRegistry: {
					getAll: () => [{ id: "m-worker-1", provider: "anthropic" }],
					hasConfiguredAuth: () => true,
				} as any,
			});
			// Seed catalog with candidate
			const admission = new ExpertAdmissionPolicy();
			const features = new ExpertFeatureBuilder();
			const ranking = new ExpertRankingPolicy();
			const capacity = new ExpertCapacityService();
			const outcomeStore = new ExpertOutcomeStore();
			const outcomeRecorder = new ExpertOutcomeRecorder(outcomeStore);

			const expertSelector = new ExpertSelectionService(
				catalog,
				admission,
				features,
				ranking,
				capacity,
				outcomeStore,
			);

			// Mock catalog candidate materialization
			catalog.materializeCandidates = async () => [cand];

			let dispatchedBinding: any;
			let called = false;
			const controller = new ObjectiveExecutionController({
				runtime: {
					reconcileObjective: async (id) => ({
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
									title: "Test",
									description: "Fix bug",
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
					isCancelled: () => called,
					isBudgetExhausted: () => false,
				},
				expertSelector,
				outcomeRecorder,
				workerDispatcher: {
					dispatch: async (_route, _signal, binding) => {
						dispatchedBinding = binding;
						called = true;
					},
					continueWorker: async () => {},
					dispatchEscalated: async () => {},
				},
				getRouteProposedAction: () => ({ kind: "implement" }),
			});

			await controller.run("obj-test");

			expect(dispatchedBinding).toBeDefined();
			expect(dispatchedBinding.expert_id).toBe("exp-verified-1");
			expect(dispatchedBinding.model_id).toBe("m-worker-1");
		});

		it("HMOE-084: Throws NoEligibleExpertError and marks unrecoverable when no expert is admitted", async () => {
			const catalog = new ExpertCatalog();
			catalog.materializeCandidates = async () => []; // No candidates

			const admission = new ExpertAdmissionPolicy();
			const features = new ExpertFeatureBuilder();
			const ranking = new ExpertRankingPolicy();
			const capacity = new ExpertCapacityService();
			const expertSelector = new ExpertSelectionService(catalog, admission, features, ranking, capacity);

			const controller = new ObjectiveExecutionController({
				runtime: {
					reconcileObjective: async (id) => ({
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
									title: "Test",
									description: "Prompt",
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
				},
				expertSelector,
				workerDispatcher: {
					dispatch: async () => {},
					continueWorker: async () => {},
					dispatchEscalated: async () => {},
				},
			});

			const result = await controller.run("obj-no-expert");
			expect(result.status).toBe("unrecoverable");
			expect(result.reasonCodes).toContain("no_eligible_expert");
		});
	});

	describe("ModelRouterController Shared Selection Bridge (HMOE-012, HMOE-100..HMOE-105)", () => {
		it("HMOE-012: Consults shared ExpertSelectionService for exact foreground turn model resolution", async () => {
			const cand = createMockCandidate({
				expert_id: "exp-fast-cheap",
				model_id: "m-fast-model",
				provider: "test-provider",
				capability_tier: "cheap",
			});
			const catalog = new ExpertCatalog();
			catalog.materializeCandidates = async () => [cand];

			const expertSelector = new ExpertSelectionService(
				catalog,
				new ExpertAdmissionPolicy(),
				new ExpertFeatureBuilder(),
				new ExpertRankingPolicy(),
				new ExpertCapacityService(),
			);

			const testModel: Model<Api> = {
				id: "m-fast-model",
				provider: "test-provider",
				api: "openai-chat" as any,
				name: "Fast Test Model",
				baseUrl: "http://localhost",
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 4096,
				cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
			};

			const mockRegistry = {
				find: (provider: string, modelId: string) =>
					provider === "test-provider" && modelId === "m-fast-model" ? testModel : undefined,
				hasConfiguredAuth: () => true,
				getAll: () => [testModel],
				getAvailable: () => [testModel],
			};

			const router = new ModelRouterController({
				getAgent: () => ({ state: { model: testModel } }) as any,
				getModel: () => testModel,
				getSettingsManager: () =>
					({
						getModelRouterSettings: () => ({
							enabled: true,
							cheapModel: "test-provider/m-fast-model",
							mediumModel: "test-provider/m-fast-model",
							expensiveModel: "test-provider/m-fast-model",
							judgeEnabled: false,
						}),
					}) as any,
				getSessionManager: () =>
					({
						getEntries: () => [],
						getSessionId: () => "sess-1",
					}) as any,
				appendSessionMessageBatch: () => [],
				getModelRegistry: () => mockRegistry as any,
				isModelExhausted: () => false,
				getFailoverStatus: () => ({}) as any,
				getCandidatePool: () => ({ customized: false, models: [testModel] }),
				isUsingSubscription: () => false,
				getAgentDir: () => "/tmp",
				getReflectionSignal: () => new AbortController().signal,
				getBaseSystemPrompt: () => "prompt",
				runAgentPrompt: async () => {},
				runAgentContinuation: async () => {},
				buildSystemPromptForToolNames: () => "prompt",
				refreshCurrentModelFromRegistry: () => {},
				runIsolatedCompletion: async () => ({}) as any,
				addSpawnedUsage: () => undefined,
				emit: () => {},
				emitAutonomyTelemetry: () => {},
				resolveLaneModel: () => undefined,
				resolveCurationModelIfFit: () => undefined,
				getToolProbeVerdict: () => undefined,
				expertSelector,
			});

			const routeInfo = await router.resolveTurnRouteJudged("What is the capital of France?", { skipJudge: true });
			expect(routeInfo).toBeDefined();
			expect(routeInfo?.model.id).toBe("m-fast-model");
			expect(routeInfo?.model.provider).toBe("test-provider");
		});
	});
});
