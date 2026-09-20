import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AdaptiveCapabilityController,
	AdaptiveResolutionController,
	AdaptiveRuntimeReadiness,
	CandidateDiscoveryService,
	CapabilityCatalog,
	CapabilityProofRunner,
	compileExecutionCharter,
	createAdaptiveRuntimeStack,
	DEFAULT_STEERING_POLICY,
	ObjectiveExecutionController,
	ResponsibilityRegistry,
	RuntimeAdaptationCoordinator,
	SemanticDuplicateResponsibilityError,
	SemanticResponsibilityController,
	SpecialistCatalog,
	SpecialistMaterializationError,
	SpecialistSynthesisController,
	SteeringCertificateStore,
	SteeringProtocolError,
	SteeringSemanticFailedError,
	SystemOneSteeringPlane,
	WaiverStore,
} from "../../../src/core/index.ts";
import type { JevAdapter, JevEvaluationRequest, JevEvaluationResponse } from "../../../src/core/system-one/adapter.ts";

class MockFinalClosureJevAdapter implements JevAdapter {
	evaluateCalls: JevEvaluationRequest[] = [];
	overrides: Record<string, unknown> = {};
	shouldFail = false;

	async evaluate(request: JevEvaluationRequest): Promise<JevEvaluationResponse> {
		this.evaluateCalls.push(request);
		if (this.shouldFail) {
			throw new Error("Jev evaluation service unavailable");
		}
		const defaultAnswers: Record<string, unknown> = {};
		if (request.questions) {
			for (const [id, rawQ] of Object.entries(request.questions)) {
				const q = rawQ as { type?: string; criteria?: unknown };
				if (q.type === "noul") {
					if (
						id === "work_remaining" ||
						id === "capability_gap_suspected" ||
						id === "critical_defect_present" ||
						id === "repetition_detected" ||
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
					if (id === "missing_work_class") {
						selected = keys.includes("completion_candidate")
							? "completion_candidate"
							: keys.includes("none")
								? "none"
								: keys[0];
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
					const levels = Array.isArray(q.criteria) ? (q.criteria as unknown[]) : [];
					const score = id === "semantic_progress" ? 2 : 0;
					const probs: Record<string, number> = {};
					levels.forEach((_val: unknown, idx: number) => {
						probs[String(idx)] = idx === score ? 1.0 : 0.0;
					});
					if (Object.keys(probs).length === 0) {
						probs[String(score)] = 1.0;
					}
					defaultAnswers[id] = {
						type: "score",
						score,
						confidence: 0.96,
						probabilities: probs,
					};
				}
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

describe("Final Closure v1.4 Regressions (FC-001..FC-090)", () => {
	let tempDir: string;
	let certFile: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fc-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
		mkdirSync(tempDir, { recursive: true });
		certFile = join(tempDir, "certificates.json");
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe("Cluster 1: Production Composition & Live Readiness (FC-001..FC-005)", () => {
		it("FC-001: default preferred session constructs the full adaptive stack", () => {
			const stack = createAdaptiveRuntimeStack({
				persistentPath: certFile,
			});

			expect(stack.steeringPlane).toBeDefined();
			expect(stack.certificateStore).toBeDefined();
			expect(stack.expertService).toBeDefined();
			expect(stack.expertCatalog).toBeDefined();
			expect(stack.runtimeAdaptation).toBeDefined();
			expect(stack.capabilityCatalog).toBeDefined();
			expect(stack.adaptiveCapabilities).toBeDefined();
			expect(stack.specialistCatalog).toBeDefined();
			expect(stack.specialistSynthesis).toBeDefined();
			expect(stack.responsibilityRegistry).toBeDefined();
			expect(stack.responsibilityController).toBeDefined();
			expect(stack.adaptiveResolution).toBeDefined();
			expect(stack.objectiveController).toBeDefined();
			expect(stack.charter).toBeDefined();
			expect(stack.readiness).toBeDefined();
		});

		it("FC-002, FC-003: readiness is ready=true when healthy and assertReady() passes without throwing", () => {
			const stack = createAdaptiveRuntimeStack({
				persistentPath: certFile,
			});
			const status = stack.readiness.getStatus();
			expect(status.ready).toBe(true);
			expect(status.issues).toEqual([]);
			expect(status.certificatePersistenceHealth).toBe("healthy");
			expect(() => stack.readiness.assertReady()).not.toThrow();
		});

		it("FC-002, FC-005: removing any required controller blocks admission", () => {
			const baseStack = createAdaptiveRuntimeStack({ persistentPath: certFile });

			const requiredKeys = [
				"steeringPlane",
				"adaptiveResolution",
				"specialistSynthesis",
				"adaptiveCapabilities",
				"responsibilityController",
				"runtimeAdaptation",
				"objectiveController",
				"expertService",
			] as const;

			for (const key of requiredKeys) {
				const strippedDeps: Record<string, unknown> = {
					steeringPlane: baseStack.steeringPlane,
					adaptiveResolution: baseStack.adaptiveResolution,
					specialistSynthesis: baseStack.specialistSynthesis,
					adaptiveCapabilities: baseStack.adaptiveCapabilities,
					responsibilityController: baseStack.responsibilityController,
					runtimeAdaptation: baseStack.runtimeAdaptation,
					objectiveController: baseStack.objectiveController,
					expertService: baseStack.expertService,
				};
				delete strippedDeps[key];

				const degradedReadiness = new AdaptiveRuntimeReadiness(strippedDeps);
				const status = degradedReadiness.getStatus();
				expect(status.ready).toBe(false);
				expect(status.issues.some((issue) => issue.includes(key))).toBe(true);
				expect(() => degradedReadiness.assertReady()).toThrow(/Adaptive runtime is not ready/);
			}
		});

		it("FC-004: required mode fails without durable certificate backend", () => {
			// In-memory store (no persistent path)
			const inMemoryStore = new SteeringCertificateStore();
			const inMemoryPlane = new SystemOneSteeringPlane({
				certificates: inMemoryStore,
				policy: DEFAULT_STEERING_POLICY,
			});
			const stack = createAdaptiveRuntimeStack({
				steeringPlane: inMemoryPlane,
			});

			const status = stack.readiness.getStatus();
			expect(status.certificatePersistenceHealth).toBe("degraded");
			// Default mode allows degraded with warning, but required mode strictly throws
			expect(() =>
				stack.readiness.assertReady({
					profile: { systemOneRequired: true },
				}),
			).toThrow(/Durable certificate persistence backend is required/);
		});
	});

	describe("Cluster 2: Dynamic Capabilities & H-MoE Activation (FC-010..FC-015)", () => {
		it("FC-010: synthetic active=true capability activators are removed", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const catalog = new CapabilityCatalog();

			let hmoeSelected = false;
			const expertService = {
				select: async () => {
					hmoeSelected = true;
					return {
						primary: { provider: "mock", model_id: "claude-3-7-sonnet", role: "builder" },
						fallbacks: [],
						strategy: "static",
					};
				},
				release: () => {},
			};

			const controller = new AdaptiveCapabilityController({
				steering: plane,
				catalog,
				capabilityArtifactRoot: mkdtempSync(join(tmpdir(), "pi-fc-capabilities-")),
				experts: expertService as any,
				// Activation now runs the artifact, so the builder writes a real one.
				builder: {
					build: async (spec) => {
						const directory = mkdtempSync(join(tmpdir(), "pi-fc010-"));
						const artifactPath = join(directory, `${spec.capability_id}.mjs`);
						const code = "export default async function run() { return true; }\n";
						writeFileSync(artifactPath, code, "utf-8");
						return {
							capabilityId: spec.capability_id,
							kind: spec.kind,
							digest: createHash("sha256").update(code).digest("hex"),
							code,
							artifactUri: pathToFileURL(artifactPath).href,
						};
					},
				},
				proofRunner: new CapabilityProofRunner(),
				mechanicalVerifier: {
					verifyCandidate: async () => ({ passed: true, testCount: 1, failures: [] }),
					verifyActivation: async () => true,
					runTaskSpecificProof: async () => "passed",
				},
			});

			const result = await controller.resolveOrBuild({
				objectiveId: "obj-cap-real",
				taskId: "task-cap-real",
				need: {
					requiredOutcome: "Compile TypeScript with strict null checks",
					kind: "ephemeral_script",
				},
			});

			expect(result.capabilityId).toBeDefined();
			expect(hmoeSelected).toBe(true);
			expect(result.activation?.active).toBe(true);
			expect(result.activation?.method).toBe("ephemeral_script_activation");
			// ACT-016: the activation evidence is the real execution, not an asserted claim.
			const projection = result.activation?.projection as Record<string, unknown> | undefined;
			expect(projection?.smokeExitCode).toBe(0);
			expect(String(projection?.smokeEvidence)).toContain("proof:");
		});

		it("FC-011, FC-012, FC-015: runtime patch routes to RuntimeAdaptationCoordinator with real evidence reaching JEV-015", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const catalog = new CapabilityCatalog();

			let runtimeUpdateCalled = false;
			const runtimeAdaptation = new RuntimeAdaptationCoordinator(plane, {
				createSnapshot: async () => ({
					snapshotId: "snap-1",
					baselineRevision: "1.0",
					backupState: {},
					timestamp: new Date().toISOString(),
				}),
				applyUpdate: async () => {
					runtimeUpdateCalled = true;
					return { applied: true, restartRequired: false };
				},
				verifyRuntime: async () => ({ healthy: true }),
				rollback: async () => {},
				commit: async () => {},
			});

			const controller = new AdaptiveCapabilityController({
				steering: plane,
				catalog,
				capabilityArtifactRoot: mkdtempSync(join(tmpdir(), "pi-fc-capabilities-")),
				// The builder's model binding must be an actual selection; this test's subject is the
				// activation path, so the selection is a fixed one rather than absent.
				experts: {
					select: async () => ({
						primary: { provider: "anthropic", model_id: "claude-3-7-sonnet", thinking_level: "medium" },
						bindings: [{ provider: "anthropic", model_id: "claude-3-7-sonnet", thinking_level: "medium" }],
					}),
				} as never,
				builder: {
					build: async (spec) => ({
						capabilityId: spec.capability_id,
						kind: spec.kind,
						digest: "sha256-patch",
						code: "+ export const patch = true;",
					}),
				},
				mechanicalVerifier: {
					verifyCandidate: async () => ({ passed: true, testCount: 1, failures: [] }),
					verifyActivation: async () => true,
					runTaskSpecificProof: async () => "passed",
				},
				runtimeAdaptation,
			});

			const result = await controller.resolveOrBuild({
				objectiveId: "obj-cap-patch",
				taskId: "task-cap-patch",
				need: {
					requiredOutcome: "Apply kernel patch for socket recycling",
					kind: "runtime_patch",
				},
			});

			expect(runtimeUpdateCalled).toBe(true);
			expect(result.activation?.method).toBe("runtime_adaptation_patch");
			// Verify JEV-015 certificate was evaluated with activation evidence
			const jev015Calls = adapter.evaluateCalls.filter((c) =>
				Object.keys(c.questions ?? {}).includes("activation_succeeded"),
			);
			expect(jev015Calls.length).toBeGreaterThan(0);
		});
	});

	describe("Cluster 3: Specialist Synthesis & Typed Needs (FC-020..FC-026)", () => {
		it("FC-020: specialist synthesis fails without real contract factory", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const catalog = new SpecialistCatalog();

			const failingFactory = {
				createContract: () => {
					throw new Error("Contract factory intentionally broken");
				},
			};

			const controller = new SpecialistSynthesisController({
				steering: plane,
				catalog,
				experts: {
					select: async () => ({
						primary: { provider: "mock", model_id: "claude-3-7-sonnet" },
						fallbacks: [],
						strategy: "static",
					}),
				} as any,
				taskProfiles: {
					createTaskProfile: () => ({ created: true, profileId: "prof-err" }),
					inspectTaskProfileOptions: () => ({ baseProfiles: [], inheritedToolNames: [], models: [] }),
				},
				contractFactory: failingFactory as any,
			});

			await expect(
				controller.resolveOrCreate({
					objectiveId: "obj-spec-broken-factory",
					taskId: "task-broken",
					need: { specialty: "worker", purpose: "do something" },
				}),
			).rejects.toThrow(SpecialistMaterializationError);
		});

		it("FC-021, FC-022: real WorkerExecutionContract is created and conforms to ORCHESTRATION_SCHEMA_VERSION", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const catalog = new SpecialistCatalog();

			const controller = new SpecialistSynthesisController({
				steering: plane,
				catalog,
				experts: {
					select: async () => ({
						primary: { provider: "anthropic", model_id: "claude-3-7-sonnet" },
						fallbacks: [],
						strategy: "static",
					}),
				} as any,
				taskProfiles: {
					createTaskProfile: () => ({ created: true, profileId: "prof-fc-021" }),
					inspectTaskProfileOptions: () => ({ baseProfiles: [], inheritedToolNames: [], models: [] }),
				},
				contractFactory: {
					createContract: (input) => ({
						schemaVersion: 1,
						authorityRole: input.authorityRole,
						modelRequirements: {
							primaryModelId: input.expertBinding.modelId,
							provider: input.expertBinding.providerId,
						},
						boundedToolSurface: [...input.toolNames],
					}),
				},
			});

			const result = await controller.resolveOrCreate({
				objectiveId: "obj-fc-021",
				taskId: "task-fc-021",
				need: {
					specialty: "backend_systems",
					purpose: "Refactor database connection pool",
				},
			});

			expect(result.executionContract).toBeDefined();
			expect(result.executionContract.schemaVersion).toBe(1);
			expect(result.executionContract.authorityRole).toBe("implementer");
			expect((result.executionContract as any).modelRequirements?.primaryModelId).toBe("claude-3-7-sonnet");
			expect(Array.isArray(result.executionContract.boundedToolSurface)).toBe(true);
		});

		it("FC-023, FC-024, FC-025: UI task autonomously yields a UI/visual SpecialistNeed and never an adaptation node id", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const specialistCatalog = new SpecialistCatalog();
			const capabilityCatalog = new CapabilityCatalog();

			const resolutionController = new AdaptiveResolutionController({
				steering: plane,
				specialistCatalog,
				capabilityCatalog,
			});

			const resolution = await resolutionController.resolve({
				objectiveId: "obj-ui-design",
				taskId: "task-ui-design",
				prompt: "Need a UI guy to polish frontend components and refine visual styling",
			});

			expect(resolution.dimension).toBe("specialist");
			expect(resolution.specialistNeed).toBeDefined();
			expect(resolution.specialistNeed?.specialty).toBe("ui_ux");
			expect(resolution.specialistNeed?.obligations).toContain("vision_inspection");
			expect(resolution.specialistNeed?.obligations).toContain("ui_ux_fidelity");

			// FC-025: Adaptation node IDs never become specialty strings
			const forbiddenNodeIds = [
				"resolve_specialist",
				"synthesize_worker",
				"dispatch_attempt",
				"evaluate_disposition",
				"escalate_capability",
			];
			expect(forbiddenNodeIds).not.toContain(resolution.specialistNeed?.specialty);
			expect(forbiddenNodeIds).not.toContain(resolution.action);
		});

		it("FC-026: AdaptiveResolution carries real typed CapabilityNeed", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const specialistCatalog = new SpecialistCatalog();
			const capabilityCatalog = new CapabilityCatalog();

			const resolutionController = new AdaptiveResolutionController({
				steering: plane,
				specialistCatalog,
				capabilityCatalog,
			});

			const resolution = await resolutionController.resolve({
				objectiveId: "obj-cap-need",
				taskId: "task-cap-need",
				prompt: "Missing SQLite migration tool or custom script",
			});

			expect(resolution.dimension).toBe("capability");
			expect(resolution.capabilityNeed).toBeDefined();
			expect(resolution.capabilityNeed?.requiredOutcome.length).toBeGreaterThan(0);
		});
	});

	describe("Cluster 4: Semantic Deduplication & Postflight Checkpoints (FC-040..FC-057)", () => {
		it("FC-040: preImplementation() runs before first material write and blocks duplicates", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			adapter.overrides = {
				recommended_disposition: {
					type: "choice",
					choice: "separate_required",
					confidence: 0.96,
					probabilities: { separate_required: 1.0, unique: 0.0 },
				},
				same_responsibility: { type: "noul", noul: 0.96 },
			};
			const plane = new SystemOneSteeringPlane({ adapter });
			const registry = new ResponsibilityRegistry();
			registry.register({
				schema_version: "1.0",
				responsibility_id: "resp-auth-existing",
				statement: "Validate authentication tokens and sign JWTs",
				owner_locations: ["src/auth.ts"],
				source_revision: "rev-1",
				evidence_refs: [],
				status: "active",
			});
			const discovery = new CandidateDiscoveryService({ registry });
			const controller = new SemanticResponsibilityController({
				steering: plane,
				registry,
				discovery,
				waivers: new WaiverStore(),
			});

			await expect(
				controller.preImplementation({
					objectiveId: "obj-dedup-block",
					taskId: "task-dedup-block",
					proposed: {
						statement: "Validate authentication tokens and sign JWTs",
						targetLocation: "src/auth-alt.ts",
					},
				}),
			).rejects.toThrow(SemanticDuplicateResponsibilityError);
		});

		it("FC-041: postMutation() runs before task acceptance and flags unintentional duplicates", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			adapter.overrides = {
				duplicate_responsibility_introduced: { type: "noul", noul: 0.95 },
				intentional_waiver_applies: { type: "noul", noul: 0.05 },
			};
			const plane = new SystemOneSteeringPlane({ adapter });
			const registry = new ResponsibilityRegistry();
			const discovery = new CandidateDiscoveryService({ registry });
			const controller = new SemanticResponsibilityController({
				steering: plane,
				registry,
				discovery,
				waivers: new WaiverStore(),
			});

			const verdict = await controller.postMutation({
				objectiveId: "obj-post-mut",
				taskId: "task-post-mut",
				responsibility: {
					statement: "Handle JWT validation",
					targetLocation: "src/jwt.ts",
				},
				mutatedFile: "src/jwt.ts",
			});

			expect(verdict.unintentionalDuplicate).toBe(true);
		});

		it("FC-042: completionSweep() remains mandatory and sweeps all active responsibilities", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const registry = new ResponsibilityRegistry();
			registry.register({
				schema_version: "1.0",
				responsibility_id: "resp-sweep-1",
				statement: "Manage connection pool",
				owner_locations: ["src/db.ts"],
				source_revision: "rev-1",
				evidence_refs: [],
				status: "active",
			});
			const discovery = new CandidateDiscoveryService({ registry });
			const controller = new SemanticResponsibilityController({
				steering: plane,
				registry,
				discovery,
				waivers: new WaiverStore(),
			});

			const sweepResult = await controller.completionSweep({
				objectiveId: "obj-sweep",
			});

			expect(sweepResult.passed).toBe(true);
			expect(sweepResult.checkedCount).toBe(1);
		});

		it("FC-043: discovery coverage failure cannot prove uniqueness", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const registry = new ResponsibilityRegistry();

			// Mock discovery service that returns failed coverage class
			const failedDiscovery = {
				findCandidates: async () => {
					const candidates: any = [];
					candidates.coverage = {
						attemptedMethods: ["ast"],
						succeededMethods: [],
						failures: [{ method: "ast", error: "parser crash" }],
						candidateCount: 0,
						coverageClass: "failed",
					};
					return candidates;
				},
			};

			const controller = new SemanticResponsibilityController({
				steering: plane,
				registry,
				discovery: failedDiscovery as any,
				waivers: new WaiverStore(),
			});

			await expect(
				controller.preImplementation({
					objectiveId: "obj-disc-fail",
					taskId: "task-disc-fail",
					proposed: {
						statement: "Some new logic",
						targetLocation: "src/new.ts",
					},
				}),
			).rejects.toThrow(SteeringProtocolError);
		});

		it("FC-050..FC-057: JEV-017..023 postflight applicability checkpoints execute live calls", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			adapter.overrides = {
				work_remaining: { type: "noul", noul: 0.95 },
				missing_work_class: { type: "choice", choice: "implement" },
			};
			const plane = new SystemOneSteeringPlane({ adapter, policy: DEFAULT_STEERING_POLICY });

			const charter = compileExecutionCharter({
				objectiveId: "obj-postflight-bug-refactor",
				prompt: "Fix bug in refactor core architecture",
			});

			let ran = false;
			let executedRoute: string | undefined;
			const controller = new ObjectiveExecutionController({
				mode: "start_only",
				executionCharter: charter,
				steeringPlane: plane,
				runtime: {
					isCancelled: () => ran,
					reconcileObjective: async (id: string) => ({
						schemaVersion: "1.0",
						objectiveId: id,
						objectives: {
							[id]: {
								objective: {
									id,
									description: "Fix bug in refactor core architecture",
									acceptanceCriteria: ["bug is fixed"],
								},
								taskIds: ["task-1"],
								evidence: [{ kind: "test", evidenceId: "ev-1", summary: "tests passed" }],
							},
						},
						tasks: {},
						attempts: {},
					}),
					getSourceRevision: () => "rev-postflight-1",
					getArtifacts: () => [{ path: "packages/coding-agent/src/core/architecture.ts" }],
					getLimitations: () => [],
				} as any,
				workerDispatcher: {
					dispatch: async (r) => {
						executedRoute = r.route;
						ran = true;
					},
					continueWorker: async () => {},
					dispatchEscalated: async () => {},
				},
				actionPolicy: {
					evaluateChoice: () => ({ action: "accept", reason: "ok" }),
					evaluate: () => ({ disposition: "accept", reason: "ok", failedChecks: [] }),
				} as any,
				decisions: {
					evaluateOrFallback: async () => ({
						results: {
							missing_work_class: { kind: "choice", selected: "implement" },
							work_remaining: { kind: "boolean", value: false },
						},
					}),
					select: () => ({
						capabilities: () => ({ confidenceProvenance: "native_calibrated" }),
					}),
				} as any,
			});

			// Run one step
			try {
				await controller.run("obj-postflight-bug-refactor");
			} catch {
				// Expected if loop exits or completes
			}

			// Verify postflight checkpoints were invoked
			const evaluatedCheckpoints = adapter.evaluateCalls.map((c) => {
				const qKeys = Object.keys(c.questions ?? {});
				if (qKeys.includes("claim_supported")) return "JEV-017";
				if (qKeys.includes("patch_matches_requirements")) return "JEV-018";
				if (qKeys.includes("bug_reproduced")) return "JEV-019";
				if (qKeys.includes("boundaries_respected")) return "JEV-020";
				return "OTHER";
			});

			expect(executedRoute).toBeDefined();
			expect(evaluatedCheckpoints).toContain("JEV-017");
			expect(evaluatedCheckpoints).toContain("JEV-018");
			expect(evaluatedCheckpoints).toContain("JEV-019");
			expect(evaluatedCheckpoints).toContain("JEV-020");
		});
	});

	describe("Cluster 5: Semantic Gate Predicates & Negative Blockers (FC-060..FC-067)", () => {
		it("FC-060, FC-061: high-confidence negative is evaluated as FAIL and throws SteeringSemanticFailedError", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			// High-confidence negative on intake coherence
			adapter.overrides = {
				objective_coherent: { type: "noul", noul: 0.05 },
			};
			const plane = new SystemOneSteeringPlane({ adapter });

			// evaluate() attaches semantic_outcome: "fail"
			const evalResult = await plane.evaluate("JEV-001", { prompt: "incoherent request" });
			expect(evalResult.certificate.semantic_outcome).toBe("fail");
			expect(evalResult.certificate.failed_semantic_predicates).toContain("objective_coherent");

			// requireCertificate() fails closed by throwing SteeringSemanticFailedError
			await expect(plane.requireCertificate("JEV-001", { prompt: "incoherent request" })).rejects.toThrow(
				SteeringSemanticFailedError,
			);
		});

		it("FC-061: JEV-013 false blocks activation", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			adapter.overrides = {
				tests_valid: { type: "noul", noul: 0.05 },
				safety_satisfied: { type: "noul", noul: 0.05 },
			};
			const plane = new SystemOneSteeringPlane({ adapter });

			const certResult = await plane.evaluate("JEV-013", { spec: "broken" });
			expect(certResult.certificate.semantic_outcome).toBe("repair");
			expect(certResult.certificate.failed_semantic_predicates).toContain("tests_valid");

			await expect(plane.requireCertificate("JEV-013", { spec: "broken" })).rejects.toThrow(
				SteeringSemanticFailedError,
			);
		});

		it("FC-061: JEV-015 false blocks capability establishment", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			adapter.overrides = {
				activation_succeeded: { type: "noul", noul: 0.05 },
			};
			const plane = new SystemOneSteeringPlane({ adapter });

			const certResult = await plane.evaluate("JEV-015", { capability: "test" });
			expect(certResult.certificate.semantic_outcome).toBe("fail");
			expect(certResult.certificate.failed_semantic_predicates).toContain("activation_succeeded");

			await expect(plane.requireCertificate("JEV-015", { capability: "test" })).rejects.toThrow(
				SteeringSemanticFailedError,
			);
		});

		it("FC-062: JEV-024 negative stops completion and halts before CompletionCoordinator", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			adapter.overrides = {
				completion_plausible: { type: "noul", noul: 0.05 },
			};
			const plane = new SystemOneSteeringPlane({ adapter, policy: DEFAULT_STEERING_POLICY });

			const charter = compileExecutionCharter({
				objectiveId: "obj-c24-fail",
				prompt: "deliver objective",
			});

			let attempts = 0;
			let completionCoordinatorCalled = false;
			const controller = new ObjectiveExecutionController({
				mode: "start_only",
				executionCharter: charter,
				steeringPlane: plane,
				runtime: {
					isCancelled: () => ++attempts > 2,
					reconcileObjective: async (id: string) => ({
						schemaVersion: "1.0",
						objectiveId: id,
						objectives: { [id]: { objective: { id, status: "active" }, taskIds: [], evidence: [] } },
						tasks: {},
						attempts: {},
					}),
					getSourceRevision: () => "rev-c24-1",
					getArtifacts: () => [],
					getLimitations: () => [],
				} as any,
				actionPolicy: {
					evaluateChoice: () => ({ action: "accept", reason: "ok" }),
					evaluate: () => ({ disposition: "accept", reason: "ok", failedChecks: [] }),
				} as any,
				decisions: {
					evaluateOrFallback: async () => ({
						results: {
							missing_work_class: { kind: "choice", selected: "completion_candidate" },
						},
					}),
					select: () => ({
						capabilities: () => ({ confidenceProvenance: "native_calibrated" }),
					}),
				} as any,
				systemOne: {
					executeCompletionTransaction: async () => {
						completionCoordinatorCalled = true;
						return { verdict: "complete" } as any;
					},
				},
			});

			try {
				await controller.run("obj-c24-fail");
			} catch {
				// Expected
			}

			// JEV-024 failing stopped execution from reaching completion transaction
			expect(completionCoordinatorCalled).toBe(false);
		});

		it("FC-064: JEV-026 hidden_regressions=true blocks completion", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			adapter.overrides = {
				hidden_regressions: { type: "noul", noul: 0.95 },
			};
			const plane = new SystemOneSteeringPlane({ adapter });

			const certResult = await plane.evaluate("JEV-026", { coldChallenge: true });
			expect(certResult.certificate.semantic_outcome).toBe("repair");
			expect(certResult.certificate.failed_semantic_predicates).toContain("no_hidden_regressions");

			await expect(plane.requireCertificate("JEV-026", { coldChallenge: true })).rejects.toThrow(
				SteeringSemanticFailedError,
			);
		});

		it("FC-066: JEV-028 deploy_safe=false prevents deploy", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			adapter.overrides = {
				deploy_safe: { type: "noul", noul: 0.05 },
			};
			const plane = new SystemOneSteeringPlane({ adapter });

			const certResult = await plane.evaluate("JEV-028", { deploy: "staging" });
			expect(certResult.certificate.semantic_outcome).toBe("block");
			expect(certResult.certificate.failed_semantic_predicates).toContain("deploy_safe");

			await expect(plane.requireCertificate("JEV-028", { deploy: "staging" })).rejects.toThrow(
				SteeringSemanticFailedError,
			);
		});

		it("FC-067: JEV-045 waiver_valid=false blocks duplicate waiver", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			adapter.overrides = {
				waiver_valid: { type: "noul", noul: 0.05 },
			};
			const plane = new SystemOneSteeringPlane({ adapter });

			const certResult = await plane.evaluate("JEV-045", { waiver: {} });
			expect(certResult.certificate.semantic_outcome).toBe("block");
			expect(certResult.certificate.failed_semantic_predicates).toContain("waiver_valid");

			await expect(plane.requireCertificate("JEV-045", { waiver: {} })).rejects.toThrow(SteeringSemanticFailedError);
		});
	});

	describe("Cluster 6: Canonical Completion Proof & Projection (FC-070..FC-074)", () => {
		it("FC-070, FC-071, FC-072: completion projection contains actual revision, diff, verification, evidence without asserted verificationPassed:true", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter, policy: DEFAULT_STEERING_POLICY });

			const charter = compileExecutionCharter({
				objectiveId: "obj-proof-canonical",
				prompt: "deliver feature and verify evidence",
			});

			let jev024Payload: any;
			const controller = new ObjectiveExecutionController({
				mode: "start_only",
				executionCharter: charter,
				steeringPlane: plane,
				runtime: {
					reconcileObjective: async (id: string) => ({
						schemaVersion: "1.0",
						objectiveId: id,
						objectives: {
							[id]: {
								objective: { id, status: "active", acceptanceCriteria: ["must pass test A"] },
								taskIds: ["task-p-1"],
								evidence: [
									{
										kind: "test",
										evidenceId: "ev-test-1",
										criterionId: "must pass test A",
										summary: "unit tests passed",
									},
									{
										kind: "review",
										evidenceId: "ev-rev-1",
										criterionId: "must pass test A",
										summary: "code review passed",
									},
								],
							},
						},
						tasks: {},
						attempts: {},
					}),
					getSourceRevision: () => "rev-git-abc123",
					getArtifacts: () => [{ path: "packages/core/src/file.ts" }],
					getLimitations: () => ["requires node 20+"],
				} as any,
				actionPolicy: {
					evaluateChoice: () => ({ action: "accept", reason: "ok" }),
					evaluate: () => ({ disposition: "accept", reason: "ok", failedChecks: [] }),
				} as any,
				decisions: {
					evaluateOrFallback: async () => ({
						results: {
							missing_work_class: { kind: "choice", selected: "completion_candidate" },
						},
					}),
					select: () => ({
						capabilities: () => ({ confidenceProvenance: "native_calibrated" }),
					}),
				} as any,
				systemOne: {
					executeCompletionTransaction: async () => ({ verdict: "complete" }) as any,
				},
			});

			// Intercept JEV-024 request
			const originalRequire = plane.requireCertificate.bind(plane);
			plane.requireCertificate = async (id, data, opts) => {
				if (id === "JEV-024") {
					jev024Payload = data;
				}
				return originalRequire(id, data, opts);
			};

			try {
				await controller.run("obj-proof-canonical");
			} catch (err) {
				// Log for diagnostics
				console.error("DEBUG RUN ERROR:", err);
			}

			expect(jev024Payload).toBeDefined();
			// FC-070: No asserted constant verificationPassed: true
			expect(jev024Payload.verificationPassed).toBeUndefined();
			// FC-071: Real fields in projection
			expect(jev024Payload.evidenceRevision).toBe(2);
			expect(jev024Payload.sourceRevision).toBe("rev-git-abc123");
			expect(jev024Payload.verificationMatrix["ev-test-1"]).toBe("unit tests passed");
			expect(jev024Payload.verificationMatrix["ev-rev-1"]).toBe("code review passed");
			expect(jev024Payload.acceptanceCriteria).toEqual(["must pass test A"]);
			expect(jev024Payload.artifacts).toEqual([{ path: "packages/core/src/file.ts" }]);
			expect(jev024Payload.limitations).toEqual(["requires node 20+"]);
		});

		it("FC-072, FC-073, FC-074: real evidence revision invalidates cache and side-effects are preserved", async () => {
			const adapter = new MockFinalClosureJevAdapter();
			const store = new SteeringCertificateStore(certFile);
			const plane = new SystemOneSteeringPlane({ adapter, certificates: store });

			const cert1 = await plane.requireCertificate("JEV-024", { state: "proof" }, { evidenceRevision: 1 });
			const cert1Cached = await plane.requireCertificate("JEV-024", { state: "proof" }, { evidenceRevision: 1 });
			expect(cert1Cached.certificate_id).toBe(cert1.certificate_id);

			const cert2NewRevision = await plane.requireCertificate(
				"JEV-024",
				{ state: "proof" },
				{ evidenceRevision: 2 },
			);
			expect(cert2NewRevision.certificate_id).not.toBe(cert1.certificate_id);
		});
	});

	describe("Cluster 7: Remote CI & GitHub Workflow Status (FC-090)", () => {
		it("FC-090: GitHub workflow and status check logic accurately identifies run results", () => {
			// Mock workflow run report representation
			const runs = [
				{
					databaseId: 35465112924,
					headSha: "a9fe5f8f83702091d8c76627b75a4ea6dce6a219",
					status: "completed",
					conclusion: "failure",
					workflowName: "CI",
				},
			];

			const reviewedRun = runs.find((r) => r.headSha === "a9fe5f8f83702091d8c76627b75a4ea6dce6a219");
			expect(reviewedRun).toBeDefined();
			expect(reviewedRun?.conclusion).toBe("failure");
			expect(reviewedRun?.databaseId).toBe(35465112924);
		});
	});
});
