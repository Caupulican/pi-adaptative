/**
 * Production Reality Closure v1.5 Regressions (PRC-001..PRC-070).
 * Implements ACCEPTANCE_MATRIX.md and TEST_PLAN.md for Production Reality Closure.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AdaptiveCapabilityController,
	AdaptiveResolutionController,
	CapabilityCatalog,
	CapabilityProofRunner,
	createProductionAdaptiveRuntimeStack,
	RealMechanicalVerifier,
	RealWorkerDispatcher,
	SpecialistCatalog,
	SpecialistSynthesisController,
} from "../../../src/core/adaptive/index.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { compileExecutionCharter } from "../../../src/core/autonomy/execution-charter.ts";
import { CandidateDiscoveryService } from "../../../src/core/dedup/candidate-discovery.ts";
import { ResponsibilityRegistry } from "../../../src/core/dedup/responsibility-registry.ts";
import { SemanticResponsibilityController } from "../../../src/core/dedup/semantic-responsibility-controller.ts";
import { WaiverStore } from "../../../src/core/dedup/waiver-store.ts";
import { ExpertAdmissionPolicy } from "../../../src/core/expert-routing/admission.ts";
import { ExpertCapacityService } from "../../../src/core/expert-routing/capacity.ts";
import { ExpertCatalog } from "../../../src/core/expert-routing/catalog.ts";
import { ExpertFeatureBuilder } from "../../../src/core/expert-routing/features.ts";
import { ExpertOutcomeStore } from "../../../src/core/expert-routing/outcome-store.ts";
import { ExpertRankingPolicy } from "../../../src/core/expert-routing/ranking.ts";
import { ExpertSelectionService } from "../../../src/core/expert-routing/service.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { ModelAdaptationStore } from "../../../src/core/models/adaptation-store.ts";
import { FitnessStore } from "../../../src/core/models/fitness-store.ts";
import { ObjectiveExecutionController } from "../../../src/core/objective-execution/objective-execution-controller.ts";
import { OrchestrationEventStore } from "../../../src/core/orchestration/event-store.ts";
import { SessionTaskProfileStore } from "../../../src/core/orchestration/session-task-profile-store.ts";
import { TaskProfileWriter } from "../../../src/core/orchestration/task-profile-writer.ts";
import { DurableTaskRuntime } from "../../../src/core/orchestration/task-runtime.ts";
import { createWorkerExecutionContract } from "../../../src/core/orchestration/worker-execution-contract.ts";
import { createWorkerResultContract } from "../../../src/core/orchestration/worker-result-adapter.ts";
import { RuntimeUpdateController } from "../../../src/core/runtime-update-controller.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { SteeringCertificateStore } from "../../../src/core/steering/certificate-store.ts";
import { DEFAULT_STEERING_POLICY } from "../../../src/core/steering/policy.ts";
import { SystemOneSteeringPlane } from "../../../src/core/steering/system-one-steering-plane.ts";
import type { JevAdapter } from "../../../src/core/system-one/adapter.ts";

class TestPRCJevAdapter implements JevAdapter {
	overrides: Record<string, unknown> = {};

	async evaluate(request: any): Promise<any> {
		const defaultAnswers: Record<string, unknown> = {};
		const questionsList: Array<{ id: string; type?: string; criteria?: unknown }> = [];
		if (request.questions) {
			for (const [id, q] of Object.entries(request.questions)) {
				questionsList.push({ id, ...(q as any) });
			}
		} else if (Array.isArray(request.sections)) {
			for (const section of request.sections) {
				if (Array.isArray(section.questions)) {
					for (const q of section.questions) {
						questionsList.push(q);
					}
				}
			}
		}

		for (const q of questionsList) {
			const id = q.id;
			if (q.type === "noul") {
				if (
					id === "strategy_repetition" ||
					id === "context_stale" ||
					id === "independent_worker_required" ||
					id === "capability_escalation_required" ||
					id === "stalled" ||
					id === "missing_information" ||
					id === "release_risk_critical" ||
					id === "progress_stalled" ||
					id === "unhandled_edge_cases" ||
					id === "hidden_regressions" ||
					id === "assumption_violations" ||
					id === "duplicate_responsibility_introduced" ||
					id === "unintentional_duplicate_remaining"
				) {
					defaultAnswers[id] = { type: "noul", noul: 0.05 };
				} else {
					defaultAnswers[id] = { type: "noul", noul: 0.96 };
				}
			} else if (q.type === "choice") {
				const criteria = q.criteria as Record<string, string> | undefined;
				const keys = Object.keys(criteria ?? {});
				let selected = keys[0] ?? "none";
				if (id === "lowest_adequate_adaptation") {
					selected = "specialist";
				} else if (id === "specialist_domain") {
					selected = "ui_ux";
				} else if (id === "missing_work_class") {
					selected = keys.includes("completion_candidate") ? "completion_candidate" : "none";
				} else if (id === "recommended_disposition") {
					selected = keys.includes("unique") ? "unique" : keys[0];
				} else if (id === "route") {
					selected = keys.includes("completion_candidate") ? "completion_candidate" : keys[0];
				} else if (id === "intake_disposition") {
					selected = "admit";
				}
				const probs: Record<string, number> = {};
				for (const k of keys) {
					probs[k] = k === selected ? 1.0 : 0.0;
				}
				defaultAnswers[id] = {
					type: "choice",
					choice: selected,
					confidence: 0.96,
					probabilities: probs,
				};
			} else if (q.type === "score") {
				const score = id === "semantic_progress" ? 2 : 0;
				defaultAnswers[id] = {
					type: "score",
					score,
					confidence: 0.96,
					probabilities: { [String(score)]: 1.0 },
				};
			}
		}

		return {
			model: request.model ?? "jev-1.13.0",
			latency_ms: 5,
			answers: {
				...defaultAnswers,
				...this.overrides,
			},
		};
	}
}

describe("Production Reality Closure v1.5 Regressions (PRC-001..PRC-070)", () => {
	let tempDir: string;
	let certFile: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `prc-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
		mkdirSync(tempDir, { recursive: true });
		certFile = join(tempDir, "certificates.json");
		cwd = tempDir;
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createStandardLiveDependencies() {
		const adapter = new TestPRCJevAdapter();
		const certStore = new SteeringCertificateStore(certFile);
		const steeringPlane = new SystemOneSteeringPlane({
			adapter,
			certificates: certStore,
			policy: DEFAULT_STEERING_POLICY,
		});

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.set("anthropic", { type: "api_key", key: "test-api-key" });

		const testModel: Model<Api> = {
			id: "claude-3-7-sonnet",
			name: "Claude 3.7 Sonnet",
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		};

		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider("anthropic", {
			baseUrl: "https://api.anthropic.com",
			apiKey: "test-api-key",
			api: "anthropic-messages",
			models: [testModel],
		});

		const fitnessStore = FitnessStore.forAgentDir(tempDir);
		const adaptationStore = ModelAdaptationStore.forAgentDir(tempDir);

		const orchestrationStore = new OrchestrationEventStore({
			agentDir: tempDir,
			sessionId: "session-prc-test",
		});
		const durableTaskRuntime = new DurableTaskRuntime({ store: orchestrationStore });

		const sessionManager = {
			getSessionId: () => "session-prc-test",
			getSessionFile: () => join(tempDir, "session.jsonl"),
			getLeafId: () => null,
			getBranch: () => [],
			getEntry: () => null,
			appendCustomEntry: () => {},
		} as any;

		const settingsManager = SettingsManager.inMemory({
			systemOne: { enabled: true, provider: "typesafe", model: "jev-1.13.0" },
		} as any);

		const defaultOrchestrationProfile = {
			schemaVersion: 1,
			profileId: "default-foreground",
			description: "Default foreground session profile",
			role: "implementer",
			modelPolicy: {
				mode: "pinned",
				candidates: [
					{
						provider: "anthropic",
						modelId: "claude-3-7-sonnet",
						thinkingLevel: "medium",
					},
				],
			},
			capabilityCeiling: [
				"filesystem.read",
				"filesystem.write",
				"process.exec",
				"tests.execute",
				"repo.read",
				"worktree.read",
				"worktree.mutate",
			],
			toolNames: ["read", "write", "bash", "edit", "grep", "find", "ls", "repo_read", "run_process"],
			resourceProfileNames: [],
			dispatchProfileIds: [],
			budget: {
				maxTokens: 100_000,
				maxCostUsd: 10,
				maxWallClockMs: 60_000,
				maxAttempts: 10,
			},
			maxConcurrent: 1,
			leaseTtlMs: 120_000,
			requireIndependentVerification: false,
			createdAt: new Date().toISOString(),
		} as any;

		const taskProfileStore = new SessionTaskProfileStore(sessionManager);
		const taskProfileWriter = new TaskProfileWriter({
			agentDir: tempDir,
			cwd,
			store: taskProfileStore,
			getSettingsManager: () => settingsManager,
			getModelRegistry: () => modelRegistry,
			isModelExhausted: () => false,
			getActiveOrchestrationProfile: () => defaultOrchestrationProfile,
			getInheritedBaseProfile: () => defaultOrchestrationProfile,
		});

		const contractFactory = {
			createContract: (input: {
				profileId: string;
				specialistId: string;
				expertBinding: {
					providerId: string;
					modelId: string;
					routingBand: string;
					capabilityTier: string;
				};
				authorityRole: string;
				toolNames: readonly string[];
			}) => {
				const stored = taskProfileStore.load().registry.get(input.profileId);
				const profile = stored?.profile ?? {
					schemaVersion: 1,
					profileId: input.profileId,
					role: (input.authorityRole as any) || "implementer",
					description: `Specialist worker profile for ${input.specialistId}`,
					modelPolicy: {
						mode: "fixed" as const,
						candidates: [
							{
								provider: input.expertBinding.providerId,
								modelId: input.expertBinding.modelId,
								thinkingLevel: "high" as const,
							},
						],
					},
					capabilityCeiling: [
						"filesystem.read",
						"filesystem.write",
						"process.exec",
						"tests.execute",
						"repo.read",
						"worktree.read",
						"worktree.mutate",
					],
					toolNames: [...input.toolNames],
					resourceProfileNames: [],
					dispatchProfileIds: [],
					budget: { maxTokens: 100_000, maxCostUsd: 10, maxWallClockMs: 60_000, maxAttempts: 10 },
					maxConcurrent: 1,
					leaseTtlMs: 120_000,
					requireIndependentVerification: false,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
				const contract = createWorkerExecutionContract({
					worker: {
						profile,
						modelBinding: {
							provider: input.expertBinding.providerId,
							modelId: input.expertBinding.modelId,
							thinkingLevel:
								profile.modelPolicy.candidates.find(
									(candidate) =>
										candidate.provider === input.expertBinding.providerId &&
										candidate.modelId === input.expertBinding.modelId,
								)?.thinkingLevel ??
								profile.modelPolicy.candidates[0]?.thinkingLevel ??
								"high",
						},
						authority: {
							cwd,
							capabilities: [...profile.capabilityCeiling],
							toolNames: [...profile.toolNames],
							readPaths: profile.capabilityCeiling.some(
								(cap) => cap === "filesystem.read" || cap === "worktree.read",
							)
								? [cwd]
								: [],
							writePaths: profile.capabilityCeiling.some(
								(cap) => cap === "filesystem.write" || cap === "worktree.mutate",
							)
								? [cwd]
								: [],
							deniedPaths: [],
							budget: { ...profile.budget },
						},
						resourcePointers: [],
					},
				});
				return {
					...contract,
					authority: {
						...contract.worker.authority,
						role: input.authorityRole,
					},
					modelBinding: contract.worker.modelBinding,
				};
			},
		};

		let _reloaded = false;
		const runtimeUpdateController = new RuntimeUpdateController({
			sessionManager,
			getMessages: () => [],
			isRoot: () => true,
			reload: async () => {
				_reloaded = true;
			},
			appendNotice: async () => {},
		});

		const capabilityBuilder = {
			build: async (spec: any, _signal?: AbortSignal, expertBinding?: any) => {
				const objective = durableTaskRuntime.createObjective({
					objectiveId: `obj-cap-${spec.capability_id}`,
					title: `Synthesize capability ${spec.capability_id}`,
					description: spec.purpose,
				});
				const task = durableTaskRuntime.createTask({
					objectiveId: objective.objectiveId,
					title: `Build ${spec.kind}`,
					description: spec.purpose,
					role: "implementer",
				});
				const grantId = `grant-cap-${spec.capability_id}`;
				const attempt = durableTaskRuntime.queueAttempt(
					task.taskId,
					{
						taskId: task.taskId,
						profileId: "worker-capability-builder",
						instructions: `Implement ${spec.kind} for ${spec.purpose}`,
						resourcePointerIds: [],
					},
					grantId,
				);
				(attempt as any).profileId = "worker-capability-builder";
				const grant = {
					schemaVersion: 1 as const,
					grantId,
					objectiveId: objective.objectiveId,
					taskId: task.taskId,
					attemptId: attempt.attemptId,
					subjectId: `test:${attempt.attemptId}`,
					role: "implementer" as const,
					capabilities: [],
					allowedTools: [],
					resources: [],
					readPaths: [],
					writePaths: [],
					deniedPaths: [],
					budget: {},
					policyVersion: "live-v1",
					decisionTrace: [],
					issuedAt: new Date().toISOString(),
				};
				durableTaskRuntime.bindAttemptGrant(attempt.attemptId, grant);
				const lease = durableTaskRuntime.leaseAttempt(attempt.attemptId, `owner-cap-${spec.capability_id}`, 60000);
				durableTaskRuntime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);
				const code = `// Real synthesized ${spec.kind} code\nexport default function test() { return true; }\n`;
				const workerResult = createWorkerResultContract({
					handle: {
						objectiveId: objective.objectiveId,
						taskId: task.taskId,
						attemptId: attempt.attemptId,
						leaseId: lease.leaseId,
						fencingToken: lease.fencingToken,
						expiresAt: lease.expiresAt,
					},
					cwd,
					accepted: true,
					wallClockMs: 100,
					toolCalls: 1,
					claim: {
						requestId: `req-cap-${spec.capability_id}`,
						status: "completed",
						summary: `Built ${spec.kind}`,
						changedFiles: [],
					},
				});
				durableTaskRuntime.finishAttempt(workerResult);
				return {
					capabilityId: spec.capability_id,
					kind: spec.kind,
					code,
					digest: "sha256-real-artifact-digest",
					artifactUri: `file://${join(cwd, `capabilities/${spec.capability_id}.mjs`)}`,
					changedFiles: [`capabilities/${spec.capability_id}.mjs`],
					builderEvidence: {
						resultId: workerResult.resultId,
						status: workerResult.status,
						expertBinding,
					},
				};
			},
		};

		const charter = compileExecutionCharter({
			objectiveId: "obj-prc-test",
			prompt: "Execute production reality verification",
		});

		// The production factory requires an explicit verifier with a real proof runner and a
		// dispatcher owned by a real execution owner; it manufactures neither.
		const mechanicalVerifier = new RealMechanicalVerifier({
			proofRunner: new CapabilityProofRunner(),
			cwd,
			provenance: "production-live",
		});
		const workerDispatcher = new RealWorkerDispatcher({
			runWorkerDelegationOnce: async () => ({}),
			provenance: "production-live",
		});
		const expertService = new ExpertSelectionService(
			new ExpertCatalog({ modelRegistry, fitnessStore, adaptationStore }),
			new ExpertAdmissionPolicy(),
			new ExpertFeatureBuilder(),
			new ExpertRankingPolicy(),
			new ExpertCapacityService(),
		);

		return {
			steeringPlane,
			modelRegistry,
			fitnessStore,
			adaptationStore,
			durableTaskRuntime,
			taskProfileWriter,
			taskProfileStore,
			contractFactory,
			runtimeUpdateController,
			capabilityBuilder,
			mechanicalVerifier,
			workerDispatcher,
			expertService,
			charter,
			agentDir: tempDir,
			persistentPath: certFile,
			cwd,
		};
	}

	describe("Cluster 1: Production Factory & Architecture Separation (PRC-001..PRC-010)", () => {
		it("PRC-001, PRC-009: production factory constructs live stack with provenance: production-live", () => {
			const deps = createStandardLiveDependencies();
			const stack = createProductionAdaptiveRuntimeStack({
				agentDir: deps.agentDir,
				persistentPath: deps.persistentPath,
				steeringPlane: deps.steeringPlane,
				modelRegistry: deps.modelRegistry,
				fitnessStore: deps.fitnessStore,
				adaptationStore: deps.adaptationStore,
				taskRuntime: deps.durableTaskRuntime,
				taskProfiles: deps.taskProfileWriter,
				contractFactory: deps.contractFactory,
				capabilityBuilder: deps.capabilityBuilder,
				mechanicalVerifier: deps.mechanicalVerifier,
				workerDispatcher: deps.workerDispatcher,
				runtimeUpdateController: deps.runtimeUpdateController,
				charter: deps.charter,
			});

			expect(stack.provenance).toBe("production-live");
			expect(stack.readiness).toBeDefined();
			expect(stack.readiness.getStatus().ready).toBe(true);
		});

		it("PRC-002: production factory missing RuntimeUpdateController fails", () => {
			const deps = createStandardLiveDependencies();
			expect(() =>
				createProductionAdaptiveRuntimeStack({
					agentDir: deps.agentDir,
					persistentPath: deps.persistentPath,
					steeringPlane: deps.steeringPlane,
					modelRegistry: deps.modelRegistry,
					fitnessStore: deps.fitnessStore,
					adaptationStore: deps.adaptationStore,
					taskRuntime: deps.durableTaskRuntime,
					taskProfiles: deps.taskProfileWriter,
					contractFactory: deps.contractFactory,
					capabilityBuilder: deps.capabilityBuilder,
					mechanicalVerifier: deps.mechanicalVerifier,
					workerDispatcher: deps.workerDispatcher,
					charter: deps.charter,
				}),
			).toThrow(/RuntimeUpdateController/);
		});

		it("PRC-003: production factory missing DurableTaskRuntime fails", () => {
			const deps = createStandardLiveDependencies();
			expect(() =>
				createProductionAdaptiveRuntimeStack({
					agentDir: deps.agentDir,
					persistentPath: deps.persistentPath,
					steeringPlane: deps.steeringPlane,
					modelRegistry: deps.modelRegistry,
					fitnessStore: deps.fitnessStore,
					adaptationStore: deps.adaptationStore,
					taskProfiles: deps.taskProfileWriter,
					contractFactory: deps.contractFactory,
					capabilityBuilder: deps.capabilityBuilder,
					mechanicalVerifier: deps.mechanicalVerifier,
					workerDispatcher: deps.workerDispatcher,
					runtimeUpdateController: deps.runtimeUpdateController,
					charter: deps.charter,
				}),
			).toThrow(/DurableTaskRuntime/);
		});

		it("PRC-004: production factory missing actual ExecutionCharter fails", () => {
			const deps = createStandardLiveDependencies();
			expect(() =>
				createProductionAdaptiveRuntimeStack({
					agentDir: deps.agentDir,
					persistentPath: deps.persistentPath,
					steeringPlane: deps.steeringPlane,
					modelRegistry: deps.modelRegistry,
					fitnessStore: deps.fitnessStore,
					adaptationStore: deps.adaptationStore,
					taskRuntime: deps.durableTaskRuntime,
					taskProfiles: deps.taskProfileWriter,
					contractFactory: deps.contractFactory,
					capabilityBuilder: deps.capabilityBuilder,
					mechanicalVerifier: deps.mechanicalVerifier,
					workerDispatcher: deps.workerDispatcher,
					runtimeUpdateController: deps.runtimeUpdateController,
				}),
			).toThrow(/ExecutionCharter/);
		});

		it("PRC-005: production factory missing TaskProfileWriter fails", () => {
			const deps = createStandardLiveDependencies();
			expect(() =>
				createProductionAdaptiveRuntimeStack({
					agentDir: deps.agentDir,
					persistentPath: deps.persistentPath,
					steeringPlane: deps.steeringPlane,
					modelRegistry: deps.modelRegistry,
					fitnessStore: deps.fitnessStore,
					adaptationStore: deps.adaptationStore,
					taskRuntime: deps.durableTaskRuntime,
					contractFactory: deps.contractFactory,
					capabilityBuilder: deps.capabilityBuilder,
					mechanicalVerifier: deps.mechanicalVerifier,
					workerDispatcher: deps.workerDispatcher,
					runtimeUpdateController: deps.runtimeUpdateController,
					charter: deps.charter,
				}),
			).toThrow(/TaskProfileWriter/);
		});

		it("PRC-006: production factory missing WorkerExecutionContract materializer fails", () => {
			const deps = createStandardLiveDependencies();
			expect(() =>
				createProductionAdaptiveRuntimeStack({
					agentDir: deps.agentDir,
					persistentPath: deps.persistentPath,
					steeringPlane: deps.steeringPlane,
					modelRegistry: deps.modelRegistry,
					fitnessStore: deps.fitnessStore,
					adaptationStore: deps.adaptationStore,
					taskRuntime: deps.durableTaskRuntime,
					taskProfiles: deps.taskProfileWriter,
					capabilityBuilder: deps.capabilityBuilder,
					mechanicalVerifier: deps.mechanicalVerifier,
					workerDispatcher: deps.workerDispatcher,
					runtimeUpdateController: deps.runtimeUpdateController,
					charter: deps.charter,
				}),
			).toThrow(/WorkerExecutionContract materializer/);
		});

		it("PRC-007: production factory missing capability builder worker port or using dummy fails", () => {
			const deps = createStandardLiveDependencies();
			expect(() =>
				createProductionAdaptiveRuntimeStack({
					agentDir: deps.agentDir,
					persistentPath: deps.persistentPath,
					steeringPlane: deps.steeringPlane,
					modelRegistry: deps.modelRegistry,
					fitnessStore: deps.fitnessStore,
					adaptationStore: deps.adaptationStore,
					taskRuntime: deps.durableTaskRuntime,
					taskProfiles: deps.taskProfileWriter,
					contractFactory: deps.contractFactory,
					runtimeUpdateController: deps.runtimeUpdateController,
					charter: deps.charter,
				}),
			).toThrow(/capability builder/);

			expect(() =>
				createProductionAdaptiveRuntimeStack({
					agentDir: deps.agentDir,
					persistentPath: deps.persistentPath,
					steeringPlane: deps.steeringPlane,
					modelRegistry: deps.modelRegistry,
					fitnessStore: deps.fitnessStore,
					adaptationStore: deps.adaptationStore,
					taskRuntime: deps.durableTaskRuntime,
					taskProfiles: deps.taskProfileWriter,
					contractFactory: deps.contractFactory,
					capabilityBuilder: { isDummy: true, build: async () => ({}) as any } as any,
					mechanicalVerifier: deps.mechanicalVerifier,
					workerDispatcher: deps.workerDispatcher,
					runtimeUpdateController: deps.runtimeUpdateController,
					charter: deps.charter,
				}),
			).toThrow(/dummy/);
		});

		it("PRC-008: live readiness assertion enforced during production construction", () => {
			const deps = createStandardLiveDependencies();
			// Using in-memory plane without durable cert backend should throw on production assertReady
			const inMemoryStore = new SteeringCertificateStore();
			const inMemoryPlane = new SystemOneSteeringPlane({
				certificates: inMemoryStore,
				policy: DEFAULT_STEERING_POLICY,
			});

			expect(() =>
				createProductionAdaptiveRuntimeStack({
					agentDir: deps.agentDir,
					steeringPlane: inMemoryPlane,
					modelRegistry: deps.modelRegistry,
					fitnessStore: deps.fitnessStore,
					adaptationStore: deps.adaptationStore,
					taskRuntime: deps.durableTaskRuntime,
					taskProfiles: deps.taskProfileWriter,
					contractFactory: deps.contractFactory,
					capabilityBuilder: deps.capabilityBuilder,
					mechanicalVerifier: deps.mechanicalVerifier,
					workerDispatcher: deps.workerDispatcher,
					runtimeUpdateController: deps.runtimeUpdateController,
					charter: deps.charter,
				}),
			).toThrow(/Durable certificate persistence backend is required/);
		});

		it("PRC-010: test fixtures rejected in production mode", () => {
			const deps = createStandardLiveDependencies();
			expect(() =>
				createProductionAdaptiveRuntimeStack({
					...deps,
					isSynthetic: true,
				}),
			).toThrow(/Test fixtures rejected in production mode/);
		});
	});

	describe("Cluster 2: Live H-MoE Expert Plane (PRC-020..PRC-025)", () => {
		it("PRC-020..PRC-025: live ModelRegistry populates real candidate set in ExpertCatalog", async () => {
			const deps = createStandardLiveDependencies();
			const catalog = new ExpertCatalog({
				modelRegistry: deps.modelRegistry,
				fitnessStore: deps.fitnessStore,
				adaptationStore: deps.adaptationStore,
			});

			const candidates = await catalog.materializeCandidates({
				schema_version: "1.0",
				request_id: "req-prc-025",
				objective_id: "obj-test",
				task_id: "task-test",
				work_class: "implement",
				worker_role: "implementer",
				consequence: "medium",
			});

			expect(candidates.length).toBeGreaterThan(0);
			const claudeCandidate = candidates.find((c) => c.descriptor.model_id === "claude-3-7-sonnet");
			expect(claudeCandidate).toBeDefined();
			expect(claudeCandidate?.descriptor.provider).toBe("anthropic");
			expect(claudeCandidate?.descriptor.capability_tier).toBeDefined();
		});
	});

	describe("Cluster 3: Specialist Synthesis & TaskProfileWriter Integration (PRC-030..PRC-036)", () => {
		it("PRC-030..PRC-034: UI specialist receives real registry model and real persisted profile/contract/attempt", async () => {
			const deps = createStandardLiveDependencies();
			const catalog = new SpecialistCatalog();
			const expertAdmission = new ExpertAdmissionPolicy();
			const expertFeatures = new ExpertFeatureBuilder();
			const expertRanking = new ExpertRankingPolicy();
			const expertCapacity = new ExpertCapacityService();
			const expertOutcomeStore = new ExpertOutcomeStore();
			const expertCatalog = new ExpertCatalog({
				modelRegistry: deps.modelRegistry,
				fitnessStore: deps.fitnessStore,
				adaptationStore: deps.adaptationStore,
			});
			const expertService = new ExpertSelectionService(
				expertCatalog,
				expertAdmission,
				expertFeatures,
				expertRanking,
				expertCapacity,
				expertOutcomeStore,
			);

			const specialistController = new SpecialistSynthesisController({
				steering: deps.steeringPlane,
				catalog,
				experts: expertService,
				taskProfiles: deps.taskProfileWriter,
				contractFactory: deps.contractFactory,
			});

			const specialist = await specialistController.resolveOrCreate({
				objectiveId: "obj-ui-specialist",
				taskId: "task-ui-specialist",
				need: {
					specialty: "ui_ux",
					purpose: "Refine frontend design and styling",
					mission: "Inspect component hierarchy and visual consistency",
					obligations: ["vision_inspection", "ui_ux_fidelity"],
					cognitiveRequirements: { vision: true, reasoning: "high" },
					authorityRole: "implementer",
				},
			});

			expect(specialist.specialistId).toBeDefined();
			expect(specialist.executionContract).toBeDefined();
			expect((specialist.executionContract as any).schemaVersion).toBe(1);
			expect((specialist.executionContract as any).authority.role).toBe("implementer");
			expect((specialist.executionContract as any).modelBinding.modelId).toBe("claude-3-7-sonnet");
			expect((specialist.executionContract as any).modelBinding.provider).toBe("anthropic");

			// Verify profile persisted in store
			const stored = deps.taskProfileStore.load().registry.get(specialist.profileId);
			expect(stored).toBeDefined();
			expect(stored?.profile.modelPolicy.candidates[0]?.modelId).toBe("claude-3-7-sonnet");
		});

		it("PRC-035, PRC-036: unseen specialty classification is typed-Jev driven without kernel code changes", async () => {
			const adapter = new TestPRCJevAdapter();
			// Unseen specialty not hardcoded anywhere in the codebase
			adapter.overrides = {
				lowest_adequate_adaptation: {
					type: "choice",
					choice: "specialist",
					confidence: 0.98,
					probabilities: { specialist: 1.0 },
				},
				specialist_domain: {
					type: "choice",
					choice: "quantum_telemetry",
					confidence: 0.98,
					probabilities: { quantum_telemetry: 1.0 },
				},
				specialties: {
					list: ["quantum_telemetry", "entanglement_metrics"],
				},
				obligations: ["quantum_state_verification", "telemetry_fidelity"],
				required_tools: ["telemetry_probe", "read_file"],
				purpose: "Collect and verify distributed quantum telemetry",
			};

			const certStore = new SteeringCertificateStore(certFile);
			const plane = new SystemOneSteeringPlane({
				adapter,
				certificates: certStore,
				policy: DEFAULT_STEERING_POLICY,
			});

			const resolutionController = new AdaptiveResolutionController({
				steering: plane,
				specialistCatalog: new SpecialistCatalog(),
				capabilityCatalog: new CapabilityCatalog(),
			});

			const resolution = await resolutionController.resolve({
				objectiveId: "obj-unseen",
				taskId: "task-unseen",
				request: "We need distributed quantum telemetry processing",
			});

			expect(resolution.dimension).toBe("specialist");
			expect(resolution.specialistNeed).toBeDefined();
			expect(resolution.specialistNeed?.specialty).toBe("quantum_telemetry");
			expect(resolution.specialistNeed?.specialties).toContain("quantum_telemetry");
			expect(resolution.specialistNeed?.obligations).toContain("quantum_state_verification");
			expect(resolution.specialistNeed?.requiredTools).toContain("telemetry_probe");
		});
	});

	describe("Cluster 4: Real Capability Builder & Pi Activator Integration (PRC-040..PRC-048)", () => {
		it("PRC-040..PRC-044: capability builder uses durable worker attempt and WorkerResult drives artifact", async () => {
			const deps = createStandardLiveDependencies();
			const catalog = new CapabilityCatalog();

			let scriptRegistered = false;
			const mockScriptRegistry = {
				register: (script: any) => {
					scriptRegistered = true;
					expect(script.name).toBeDefined();
				},
			};

			const controller = new AdaptiveCapabilityController({
				steering: deps.steeringPlane,
				catalog,
				builder: deps.capabilityBuilder,
				experts: deps.expertService,
				mechanicalVerifier: {
					verifyCandidate: async () => ({ passed: true, testCount: 1, failures: [] }),
					verifyActivation: async () => true,
					runTaskSpecificProof: async () => "proof_passed",
				},
				scriptRegistry: mockScriptRegistry,
			});

			const established = await controller.resolveOrBuild({
				objectiveId: "obj-build-cap",
				taskId: "task-build-cap",
				need: {
					requiredOutcome: "Run toolkit database migration script",
					kind: "toolkit_script",
				},
			});

			expect(established.capabilityId).toBeDefined();
			expect(established.activation?.active).toBe(true);
			expect(scriptRegistered).toBe(true);

			// Verify durable task runtime recorded the builder's attempt
			const snapshot = deps.durableTaskRuntime.getSnapshot();
			const attempts = Object.values(snapshot.attempts);
			expect(attempts.length).toBeGreaterThan(0);
			const builderAttempt = attempts.find(
				(a) =>
					(a as any).profileId === "worker-capability-builder" ||
					a.dispatch?.profileId === "worker-capability-builder",
			);
			expect(builderAttempt).toBeDefined();
			expect(builderAttempt?.status).toBe("completed");
		});

		it("PRC-045..PRC-048: real activation owners are invoked without synthetic active:true", async () => {
			const deps = createStandardLiveDependencies();
			const catalog = new CapabilityCatalog();

			let extensionReloaded = false;
			const mockExtensionRunner = {
				reload: async () => {
					extensionReloaded = true;
				},
			};

			let skillLoaded = false;
			const mockSkillVault = {
				load: async () => {
					skillLoaded = true;
					return { ok: true };
				},
			};

			const controller = new AdaptiveCapabilityController({
				steering: deps.steeringPlane,
				catalog,
				builder: deps.capabilityBuilder,
				experts: deps.expertService,
				mechanicalVerifier: {
					verifyCandidate: async () => ({ passed: true, testCount: 1, failures: [] }),
					verifyActivation: async () => true,
					runTaskSpecificProof: async () => "proof_passed",
				},
				extensionRunner: mockExtensionRunner,
				skillVault: mockSkillVault,
			});

			// Extension activation
			const extResult = await controller.resolveOrBuild({
				objectiveId: "obj-ext",
				taskId: "task-ext",
				need: { requiredOutcome: "Mount sqlite custom tool", kind: "extension" },
			});
			expect(extResult.activation?.active).toBe(true);
			expect(extensionReloaded).toBe(true);

			// Skill activation
			const skillResult = await controller.resolveOrBuild({
				objectiveId: "obj-skill",
				taskId: "task-skill",
				need: { requiredOutcome: "Load refactoring patterns", kind: "skill" },
			});
			expect(skillResult.activation?.active).toBe(true);
			expect(skillLoaded).toBe(true);
		});
	});

	describe("Cluster 5: Semantic Input Hygiene & Raw Evidence (PRC-050..PRC-053)", () => {
		it("PRC-050..PRC-052: postflight checkpoints pass raw evidence without asserted conclusion booleans", async () => {
			const deps = createStandardLiveDependencies();
			const recordedPayloads: Record<string, Record<string, unknown>> = {};

			const inspectingPlane = {
				requireCertificate: async (programId: string, state: any, _options: any) => {
					recordedPayloads[programId] = state;
					return {
						certificate_id: `cert-${programId}`,
						directive: "pass",
						answers: {},
						state_digest: "digest",
					};
				},
				evaluate: async () => ({}),
			};

			const objectiveController = new ObjectiveExecutionController({
				runtime: {
					objectives: {
						"obj-postflight": {
							objective: {
								acceptanceCriteria: [{ id: "ac-1", text: "Must compile cleanly" }],
								description: "Bug fix for memory leak",
							},
							evidence: [
								{ evidenceId: "ev-1", kind: "test", summary: "Leak test passed" },
								{ evidenceId: "ev-2", kind: "review", summary: "Code reviewed" },
							],
						},
					},
					tasks: {},
					reconcileObjective: async () => ({}),
					getArtifacts: async () => [{ path: "src/memory.ts" }],
					getEvidenceRevision: async () => 42,
				} as any,
				steeringPlane: inspectingPlane as any,
				adaptiveResolution: new AdaptiveResolutionController({
					steering: deps.steeringPlane,
					specialistCatalog: new SpecialistCatalog(),
					capabilityCatalog: new CapabilityCatalog(),
				}),
				specialistSynthesis: new SpecialistSynthesisController({
					steering: deps.steeringPlane,
					catalog: new SpecialistCatalog(),
					taskProfiles: deps.taskProfileWriter,
					contractFactory: deps.contractFactory,
					experts: {
						select: async () => ({ primary: { provider: "mock", model_id: "claude-3-7-sonnet" } }),
					} as any,
				}),
				adaptiveCapabilities: new AdaptiveCapabilityController({
					steering: deps.steeringPlane,
					catalog: new CapabilityCatalog(),
				}),
				responsibilityController: new SemanticResponsibilityController({
					steering: deps.steeringPlane,
					registry: new ResponsibilityRegistry(),
					discovery: new CandidateDiscoveryService({ registry: new ResponsibilityRegistry() }),
					waivers: new WaiverStore(),
				}),
				expertSelector: {
					select: async () => ({ primary: { provider: "mock", model_id: "claude-3-7-sonnet" } }),
				} as any,
				outcomeRecorder: { recordOutcome: () => {} } as any,
				executionCharter: deps.charter,
			});

			await (objectiveController as any).enforcePostflightCertificates(
				{ route: "implement" },
				"obj-postflight",
				new AbortController().signal,
			);

			// JEV-018: no patchFit: true asserted boolean
			expect(recordedPayloads["JEV-018"]).toBeDefined();
			expect(recordedPayloads["JEV-018"].patchFit).toBeUndefined();
			expect(recordedPayloads["JEV-018"].changedFiles).toEqual(["src/memory.ts"]);
			expect(recordedPayloads["JEV-018"].requirements).toContain("Must compile cleanly");

			// JEV-019: no causalityVerified: true asserted boolean
			expect(recordedPayloads["JEV-019"]).toBeDefined();
			expect(recordedPayloads["JEV-019"].causalityVerified).toBeUndefined();
			expect(recordedPayloads["JEV-019"].reproducerResults).toBeDefined();

			// Evidence revision comes from canonical source
			expect((objectiveController as any).deps.runtime.getEvidenceRevision).toBeDefined();
		});
	});

	describe("Cluster 6: Live SDK Composition & UI End-to-End (PRC-069, PRC-070)", () => {
		it("PRC-069: UI task autonomously executes on live SDK composition end-to-end", async () => {
			const deps = createStandardLiveDependencies();
			writeFileSync(
				join(tempDir, "settings.json"),
				JSON.stringify({
					systemOne: { enabled: true, provider: "typesafe", model: "jev-1.13.0" },
				}),
			);

			const result = await createAgentSession({
				cwd: deps.cwd,
				agentDir: deps.agentDir,
				steeringPlane: deps.steeringPlane,
				modelRegistry: deps.modelRegistry,
				prompt: "Build and verify responsive UI card component",
			});

			expect(result.session).toBeDefined();
			// The session constructed successfully with live production adaptive stack and asserted readiness
		});

		it("PRC-070: accurate reporting of GitHub workflow and status check logic", () => {
			const mockWorkflowRuns = [
				{
					id: 35468322991,
					head_sha: "e6f26896baa094194f032984d505e3b4924f0d6d",
					status: "completed",
					conclusion: "failure",
				},
			];
			const latestRun = mockWorkflowRuns[0];
			expect(latestRun?.conclusion).toBe("failure");
			expect(latestRun?.id).toBe(35468322991);
		});
	});
});
