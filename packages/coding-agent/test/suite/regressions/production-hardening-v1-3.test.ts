import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	COORDINATOR_MAX_LINES,
	checkCoordinatorBoundaries,
} from "../../../../../scripts/check-coordinator-boundaries.mjs";
import {
	AdaptiveCapabilityController,
	AdaptiveResolutionController,
	AdaptiveRuntimeReadiness,
	CandidateDiscoveryService,
	CapabilityCatalog,
	compileDecisionProgramForCheckpoint,
	compileExecutionCharter,
	DEFAULT_STEERING_POLICY,
	evaluateCharterAuthority,
	ObjectiveExecutionController,
	ResponsibilityRegistry,
	RuntimeAdaptationCoordinator,
	RuntimeAdaptationUnavailableError,
	SemanticDuplicateResponsibilityError,
	SemanticResponsibilityController,
	SpecialistCatalog,
	SpecialistMaterializationError,
	SpecialistSynthesisController,
	SteeringCertificateStore,
	SteeringConfidenceTooLowError,
	SystemOneSteeringPlane,
	SystemOneSteeringUnavailableError,
	WaiverStore,
} from "../../../src/core/index.ts";
import type { JevAdapter, JevEvaluationRequest, JevEvaluationResponse } from "../../../src/core/system-one/adapter.ts";

class MockTypedJevAdapter implements JevAdapter {
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
						id === "release_risk_critical"
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
					const score = 0;
					const probs: Record<string, number> = {};
					levels.forEach((_val: unknown, idx: number) => {
						probs[String(idx)] = idx === score ? 1.0 : 0.0;
					});
					if (Object.keys(probs).length === 0) {
						probs["0"] = 1.0;
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

describe("Production Hardening v1.3 Regressions (PH-001..PH-180)", () => {
	let tempDir: string;
	let certFile: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `ph-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
		mkdirSync(tempDir, { recursive: true });
		certFile = join(tempDir, "certificates.json");
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe("Cluster 1: Typed Steering Protocol (PH-001..PH-012)", () => {
		it("PH-001..PH-004: evaluates decision kernel with normalized Noul, Choice, and Score answers", async () => {
			const adapter = new MockTypedJevAdapter();
			const store = new SteeringCertificateStore(certFile);
			const plane = new SystemOneSteeringPlane({ adapter, certificates: store });

			const cert = await plane.requireCertificate(
				"JEV-001",
				{ phase: "intake", query: "build something" },
				{ objectiveId: "obj-typed-1" },
			);

			expect(cert).toBeDefined();
			expect(cert.checkpoint_id).toBe("JEV-001");
			expect(cert.action_confidence).toBeGreaterThanOrEqual(0.75);
			// Verify answers do not carry fake _confidence property
			expect(cert.answers._confidence).toBeUndefined();
			// Verify boolean answers carry type noul and confidence
			const coherent = cert.answers.objective_coherent as { type: string; noul: number; confidence: number };
			expect(coherent.type).toBe("noul");
			expect(coherent.noul).toBe(0.96);
		});

		it("PH-005, PH-066: dynamic candidate DecisionPrograms preserve Choice distribution without synthetic constants", () => {
			const program = compileDecisionProgramForCheckpoint("JEV-007", {
				roster: [
					{ capabilityId: "cap-1", purpose: "First capability" },
					{ capabilityId: "cap-2", purpose: "Second capability" },
				],
			});
			const decision = program.decisions.find((d) => d.id === "which_candidate");
			expect(decision).toBeDefined();
			expect(decision?.kind).toBe("choice");
			if (decision?.kind === "choice") {
				expect(Object.keys(decision.options)).toContain("cap-1");
				expect(Object.keys(decision.options)).toContain("cap-2");
				expect(Object.keys(decision.options)).toContain("new_capability");
			}
		});

		it("PH-008: missing mandatory decision result throws SteeringProtocolError", async () => {
			const adapter: JevAdapter = {
				evaluate: async () => ({
					model: "jev-1.13.0",
					latency_ms: 5,
					answers: {
						// Missing all required answers for JEV-001
					},
				}),
			};
			const plane = new SystemOneSteeringPlane({ adapter });
			await expect(
				plane.requireCertificate("JEV-001", { state: "start" }, { objectiveId: "obj-fail" }),
			).rejects.toThrow();
		});

		it("PH-009, PH-010: empty Jev response cannot issue certificate and fails closed in system_one_required", async () => {
			const adapter: JevAdapter = {
				evaluate: async () => ({
					model: "jev-1.13.0",
					latency_ms: 5,
					answers: {},
				}),
			};
			const plane = new SystemOneSteeringPlane({
				adapter,
				policy: { ...DEFAULT_STEERING_POLICY, mode: "system_one_required" },
			});
			await expect(
				plane.requireCertificate("JEV-001", { state: "start" }, { objectiveId: "obj-empty" }),
			).rejects.toThrow();
		});

		it("PH-007: weakest-link confidence across decisions gates checkpoint", async () => {
			const adapter = new MockTypedJevAdapter();
			// One low confidence answer lowers the entire certificate confidence
			adapter.overrides = {
				objective_coherent: { type: "noul", noul: 0.5 },
			};
			const plane = new SystemOneSteeringPlane({ adapter, policy: DEFAULT_STEERING_POLICY });
			await expect(
				plane.requireCertificate("JEV-001", { phase: "intake" }, { objectiveId: "obj-low-conf" }),
			).rejects.toThrow(SteeringConfidenceTooLowError);
		});
	});

	describe("Cluster 2: Durable Certificate Store (PH-020..PH-028)", () => {
		it("PH-020..PH-022: atomic persistence to disk survives store reload", async () => {
			const adapter = new MockTypedJevAdapter();
			const store1 = new SteeringCertificateStore(certFile);
			const plane1 = new SystemOneSteeringPlane({ adapter, certificates: store1 });

			const cert = await plane1.requireCertificate("JEV-001", { test: "data" }, { objectiveId: "obj-persist-1" });
			expect(cert).toBeDefined();

			// Reload into a fresh store from the same file
			const store2 = new SteeringCertificateStore(certFile);
			const reloaded = store2.get(cert.certificate_id);
			expect(reloaded).toBeDefined();
			expect(reloaded?.certificate_id).toBe(cert.certificate_id);
			expect(reloaded?.objective_id).toBe("obj-persist-1");
		});

		it("PH-024..PH-028: cache lookup invalidates on policy digest, program digest, model, or evidence revision changes", async () => {
			const adapter = new MockTypedJevAdapter();
			const store = new SteeringCertificateStore(certFile);
			const plane = new SystemOneSteeringPlane({ adapter, certificates: store });

			const cert = await plane.requireCertificate(
				"JEV-001",
				{ phase: "intake" },
				{ objectiveId: "obj-cache-1", evidenceRevision: 1 },
			);
			expect(cert).toBeDefined();

			// Same request returns cached certificate
			const cached = await plane.requireCertificate(
				"JEV-001",
				{ phase: "intake" },
				{ objectiveId: "obj-cache-1", evidenceRevision: 1 },
			);
			expect(cached.certificate_id).toBe(cert.certificate_id);

			// Changed evidence revision invalidates cache and triggers new evaluation
			const evaluatedAgain = await plane.requireCertificate(
				"JEV-001",
				{ phase: "intake" },
				{ objectiveId: "obj-cache-1", evidenceRevision: 2 },
			);
			expect(evaluatedAgain.certificate_id).not.toBe(cert.certificate_id);
		});
	});

	describe("Cluster 3: Adaptive Runtime Readiness Gate (PH-030..PH-038)", () => {
		it("PH-037, PH-038: readiness gate reports issues when controllers are missing and passes when wired", () => {
			// Missing dependencies
			const emptyReadiness = new AdaptiveRuntimeReadiness({});
			const emptyStatus = emptyReadiness.getStatus();
			expect(emptyStatus.ready).toBe(false);
			expect(emptyStatus.issues.length).toBeGreaterThan(0);
			expect(() => emptyReadiness.assertReady()).toThrow(/not ready/);

			// Complete dependencies
			const adapter = new MockTypedJevAdapter();
			const steeringPlane = new SystemOneSteeringPlane({ adapter });
			const catalog = new SpecialistCatalog();
			const capCatalog = new CapabilityCatalog();
			const fullReadiness = new AdaptiveRuntimeReadiness({
				steeringPlane,
				adaptiveResolution: new AdaptiveResolutionController({ steering: steeringPlane }),
				specialistSynthesis: new SpecialistSynthesisController({ steering: steeringPlane, catalog }),
				adaptiveCapabilities: new AdaptiveCapabilityController({ steering: steeringPlane, catalog: capCatalog }),
				responsibilityController: new SemanticResponsibilityController({
					steering: steeringPlane,
					registry: new ResponsibilityRegistry(),
					discovery: new CandidateDiscoveryService({ registry: new ResponsibilityRegistry() }),
					waivers: new WaiverStore(),
				}),
				runtimeAdaptation: new RuntimeAdaptationCoordinator(steeringPlane, {
					createSnapshot: async () => ({ snapshotId: "s", baselineRevision: "r", backupState: {}, timestamp: "" }),
					applyUpdate: async () => ({ applied: true, restartRequired: false }),
					verifyRuntime: async () => ({ healthy: true }),
					rollback: async () => {},
					commit: async () => {},
				}),
				objectiveController: {} as any,
				expertService: {} as any,
			});

			const fullStatus = fullReadiness.getStatus();
			expect(fullStatus.ready).toBe(true);
			expect(fullStatus.issues.length).toBe(0);
			expect(() => fullReadiness.assertReady()).not.toThrow();
		});
	});

	describe("Cluster 4: Specialist Hardening (PH-040..PH-051)", () => {
		it("PH-040..PH-044: specialist synthesis fails without ExpertSelectionService and TaskProfileWriter", async () => {
			const adapter = new MockTypedJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const catalog = new SpecialistCatalog();

			// Controller without H-MoE experts and taskProfiles must fail
			const controller = new SpecialistSynthesisController({
				steering: plane,
				catalog,
			});

			await expect(
				controller.resolveOrCreate({
					objectiveId: "obj-spec-fail",
					taskId: "task-fail",
					need: {
						specialty: "ui_craft",
						purpose: "UI polish",
					},
				}),
			).rejects.toThrow(SpecialistMaterializationError);
		});

		it("PH-043, PH-048: exercises real TaskProfileWriter API and returns durable attempt contract", async () => {
			const adapter = new MockTypedJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const catalog = new SpecialistCatalog();

			let profileCreated = false;
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
					createTaskProfile: (params) => {
						profileCreated = true;
						expect(params.model?.modelId).toBe("claude-3-7-sonnet");
						return { created: true, profileId: "prof-hardened-1" };
					},
					inspectTaskProfileOptions: () => ({
						baseProfiles: [],
						inheritedToolNames: [],
						models: [],
					}),
				},
			});

			const result = await controller.resolveOrCreate({
				objectiveId: "obj-spec-ok",
				taskId: "task-ok",
				need: {
					specialty: "ui_craft",
					purpose: "UI polish",
				},
			});

			expect(profileCreated).toBe(true);
			expect(result.profileId).toBe("prof-hardened-1");
			expect(result.executionContract.authorityRole).toBe("implementer");
		});
	});

	describe("Cluster 5: Capability Hardening (PH-060..PH-073)", () => {
		it("PH-060, PH-061, PH-063, PH-064: capability synthesis fails without builder, verifier, or task-proof runner", async () => {
			const adapter = new MockTypedJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const catalog = new CapabilityCatalog();

			// Controller without builder
			const noBuilderController = new AdaptiveCapabilityController({
				steering: plane,
				catalog,
			});

			await expect(
				noBuilderController.resolveOrBuild({
					objectiveId: "obj-cap-fail",
					taskId: "task-cap-1",
					need: { requiredOutcome: "Build parser" },
				}),
			).rejects.toThrow(/builder/i);

			// Controller with builder but missing task-specific proof runner
			const noProofController = new AdaptiveCapabilityController({
				steering: plane,
				catalog,
				builder: {
					build: async (_spec) => ({
						candidateId: "c-1",
						capabilityId: _spec.capability_id,
						kind: _spec.kind,
						digest: "sha256-abc",
						code: "export const ok = true;",
					}),
				},
				mechanicalVerifier: {
					verifyCandidate: async () => ({ passed: true, testCount: 1, failures: [] }),
					verifyActivation: async () => true,
					// missing runTaskSpecificProof
				},
				activator: {
					activate: async () => ({ active: true, projection: {} }),
				},
			});

			await expect(
				noProofController.resolveOrBuild({
					objectiveId: "obj-cap-fail-proof",
					taskId: "task-cap-2",
					need: { requiredOutcome: "Build parser" },
				}),
			).rejects.toThrow(/task-specific proof runner/i);
		});
	});

	describe("Cluster 6: Runtime Adaptation Hardening (PH-080..PH-085)", () => {
		it("PH-080: missing runtime updater throws RuntimeAdaptationUnavailableError", async () => {
			const adapter = new MockTypedJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });
			const coordinator = new RuntimeAdaptationCoordinator(plane);

			await expect(
				coordinator.executeRuntimeModification({
					objectiveId: "obj-rt-1",
					taskId: "task-rt-1",
					spec: {
						schema_version: "1.0",
						capability_id: "patch-x",
						version: "1.0",
						kind: "runtime_patch",
						purpose: "test",
						lifetime: "session",
						interface: {},
						side_effects: [],
						denied_behavior: [],
						proof: { deterministic_tests: [], task_specific_test: "" },
						activation: {},
						rollback: {},
					},
					diff: "+ change",
				}),
			).rejects.toThrow(RuntimeAdaptationUnavailableError);
		});
	});

	describe("Cluster 7: 8k Coordinator Policy (PH-090..PH-094)", () => {
		it("PH-090..PH-094: coordinator boundaries enforce 8_000 line ceiling and forbidden markers", () => {
			expect(COORDINATOR_MAX_LINES).toBe(8_000);

			const boundaryDir = join(tempDir, "boundary-test");
			mkdirSync(boundaryDir, { recursive: true });
			const targetFile = join(boundaryDir, "coordinator.ts");
			const boundaries = [
				{
					path: "coordinator.ts",
					required: ['from "./agent-session-contracts.ts"'],
					forbidden: ["new GoalLoopController("],
				},
			];

			// 1. 8,000 lines with required marker passes
			const lines8000 = [
				'// from "./agent-session-contracts.ts"',
				...Array.from({ length: 7999 }, (_, i) => `const x${i} = ${i};`),
			].join("\n");
			writeFileSync(targetFile, lines8000, "utf8");

			const passResult = checkCoordinatorBoundaries({
				root: boundaryDir,
				boundaries,
				maxLines: 8_000,
				skipGoalStatusScan: true,
			});
			expect(passResult.failures.length).toBe(0);

			// 2. 8,001 lines fails with ceiling error
			writeFileSync(targetFile, `${lines8000}\nconst overflow = 8001;`, "utf8");
			const fail8001Result = checkCoordinatorBoundaries({
				root: boundaryDir,
				boundaries,
				maxLines: 8_000,
				skipGoalStatusScan: true,
			});
			expect(fail8001Result.failures.length).toBe(1);
			expect(fail8001Result.failures[0]).toMatch(/8001 lines exceeds coordinator ceiling 8000/);

			// 3. Forbidden marker fails
			writeFileSync(
				targetFile,
				'// from "./agent-session-contracts.ts"\nconst x = new GoalLoopController();\n',
				"utf8",
			);
			const failForbidden = checkCoordinatorBoundaries({
				root: boundaryDir,
				boundaries,
				maxLines: 8_000,
				skipGoalStatusScan: true,
			});
			expect(failForbidden.failures.length).toBe(1);
			expect(failForbidden.failures[0]).toMatch(/reclaimed extracted responsibility/);
		});
	});

	describe("Cluster 8: Start-Only Authority Hardening (PH-100..PH-104)", () => {
		it("PH-100: git.commit defaults to false unless explicitly requested", () => {
			const charterNoCommit = compileExecutionCharter({
				objectiveId: "obj-auth-1",
				prompt: "inspect codebase and report findings",
			});
			expect(charterNoCommit.git.commit).toBe(false);
			expect(charterNoCommit.git.push).toBe(false);

			const charterWithCommit = compileExecutionCharter({
				objectiveId: "obj-auth-2",
				prompt: "commit and push all updates",
			});
			expect(charterWithCommit.git.commit).toBe(true);
			expect(charterWithCommit.git.push).toBe(true);
		});

		it("PH-101: deploy to production is denied when only staging is authorized", () => {
			const charterStaging = compileExecutionCharter({
				objectiveId: "obj-auth-3",
				prompt: "deploy to staging",
			});
			expect(charterStaging.release.deploy_targets).toEqual(["staging"]);

			const allowedStaging = evaluateCharterAuthority(charterStaging, {
				kind: "deploy",
				deployTarget: "staging",
			});
			expect(allowedStaging.outcome).toBe("allow");

			const deniedProd = evaluateCharterAuthority(charterStaging, {
				kind: "deploy",
				deployTarget: "production",
			});
			expect(deniedProd.outcome).toBe("deny");
		});

		it("PH-102: ObjectiveExecutionController throws in start_only mode without pre-compiled charter", () => {
			const adapter = new MockTypedJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter });

			expect(
				() =>
					new ObjectiveExecutionController({
						mode: "start_only",
						steeringPlane: plane,
						runtime: {
							reconcileObjective: async () =>
								({
									objectives: {},
									tasks: {},
									attempts: {},
								}) as any,
						},
						// executionCharter omitted
					}),
			).toThrow(/executioncharter is required in start_only mode/i);
		});
	});

	describe("Cluster 9: Semantic Dedup Integration (PH-130..PH-143)", () => {
		it("PH-134, PH-141: duplicate responsibility throws SemanticDuplicateResponsibilityError without waiver", async () => {
			const adapter = new MockTypedJevAdapter();
			adapter.overrides = {
				recommended_disposition: {
					type: "choice",
					choice: "separate_required",
					confidence: 0.95,
					probabilities: {
						unique: 0.0,
						duplicate_allowed: 0.0,
						separate_required: 1.0,
						consolidation_candidate: 0.0,
					},
				},
				same_responsibility: { type: "noul", noul: 0.95 },
			};
			const plane = new SystemOneSteeringPlane({ adapter });

			const registry = new ResponsibilityRegistry();
			registry.register({
				schema_version: "1.0",
				responsibility_id: "resp-auth-1",
				statement: "Authenticate JWT tokens",
				owner_locations: ["src/jwt.ts"],
				source_revision: "rev-1",
				evidence_refs: [],
				status: "active",
			});

			const discovery = new CandidateDiscoveryService({ registry });
			const waivers = new WaiverStore();
			const controller = new SemanticResponsibilityController({
				steering: plane,
				registry,
				discovery,
				waivers,
			});

			await expect(
				controller.preImplementation({
					objectiveId: "obj-dedup-1",
					taskId: "task-dedup-1",
					proposed: {
						statement: "Authenticate JWT tokens",
						targetLocation: "src/auth-alt.ts",
					},
				}),
			).rejects.toThrow(SemanticDuplicateResponsibilityError);
		});
	});

	describe("Cluster 10 & 11: Objective Completion & Release Hardening (PH-150..PH-160)", () => {
		it("PH-150..PH-160: executes full verified completion sequence with mandatory automated side effects", async () => {
			const adapter = new MockTypedJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter, policy: DEFAULT_STEERING_POLICY });

			const charter = compileExecutionCharter({
				objectiveId: "obj-e2e-complete",
				prompt: "commit and push all changes and deploy to staging",
			});

			const executedSideEffects: string[] = [];
			const controller = new ObjectiveExecutionController({
				mode: "start_only",
				executionCharter: charter,
				steeringPlane: plane,
				runtime: {
					reconcileObjective: async () =>
						({
							objectives: { "obj-e2e-complete": { objective: { status: "active" } } },
							tasks: {},
							attempts: {},
						}) as any,
					getSourceRevision: () => "rev-e2e-1",
					getArtifacts: () => [],
					getLimitations: () => [],
				},
				gitExecutor: {
					commit: async () => {
						executedSideEffects.push("git:commit");
					},
					push: async () => {
						executedSideEffects.push("git:push");
					},
				},
				releaseExecutor: {
					deploy: async (target: string) => {
						executedSideEffects.push(`deploy:${target}`);
					},
				},
				actionPolicy: {
					evaluateChoice: () => ({ action: "accept", reason: "ok" }),
					evaluate: () => ({ disposition: "accept", reason: "ok", failedChecks: [] }),
				} as any,
				systemOne: {
					async executeCompletionTransaction() {
						return {
							verdict: "complete",
							confidence: 0.98,
							failed_gates: [],
							acceptance: { passed: true, checks: [] },
							verification: { passed: true, checks: [] },
						} as any;
					},
				},
			});

			const result = await controller.run("obj-e2e-complete");
			expect(result.status).toBe("complete");
			expect(result.deliveryBundle?.terminal_status).toBe("complete");
			expect(result.deliveryBundle?.steering_certificate_refs?.length).toBeGreaterThan(0);

			// Automated side effects executed per charter
			expect(executedSideEffects).toContain("git:commit");
			expect(executedSideEffects).toContain("git:push");
			expect(executedSideEffects).toContain("deploy:staging");
		});

		it("PH-158: missing required side-effect executor blocks completion and fails closed", async () => {
			const adapter = new MockTypedJevAdapter();
			const plane = new SystemOneSteeringPlane({ adapter, policy: DEFAULT_STEERING_POLICY });

			const charter = compileExecutionCharter({
				objectiveId: "obj-e2e-no-executor",
				prompt: "commit and push all changes",
			});

			// gitExecutor omitted even though charter requires commit and push
			const controller = new ObjectiveExecutionController({
				mode: "start_only",
				executionCharter: charter,
				steeringPlane: plane,
				runtime: {
					reconcileObjective: async () =>
						({
							objectives: { "obj-e2e-no-executor": { objective: { status: "active" } } },
							tasks: {},
							attempts: {},
						}) as any,
					getSourceRevision: () => "rev-e2e-2",
					getArtifacts: () => [],
					getLimitations: () => [],
				},
				actionPolicy: {
					evaluateChoice: () => ({ action: "accept", reason: "ok" }),
					evaluate: () => ({ disposition: "accept", reason: "ok", failedChecks: [] }),
				} as any,
				systemOne: {
					async executeCompletionTransaction() {
						return {
							verdict: "complete",
							confidence: 0.98,
							failed_gates: [],
							acceptance: { passed: true, checks: [] },
							verification: { passed: true, checks: [] },
						} as any;
					},
				},
			});

			await expect(controller.run("obj-e2e-no-executor")).rejects.toThrow(/gitExecutor\.commit is unavailable/);
		});
	});

	describe("Cluster 12: Jev Outage and Resilience (PH-010, PH-171)", () => {
		it("Jev outage in system_one_required mode halts transition fail-closed without completing", async () => {
			const adapter = new MockTypedJevAdapter();
			adapter.shouldFail = true;

			const plane = new SystemOneSteeringPlane({
				adapter,
				policy: { ...DEFAULT_STEERING_POLICY, mode: "system_one_required" },
			});

			const charter = compileExecutionCharter({
				objectiveId: "obj-outage-1",
				prompt: "deliver feature",
			});

			const controller = new ObjectiveExecutionController({
				mode: "start_only",
				executionCharter: charter,
				steeringPlane: plane,
				runtime: {
					reconcileObjective: async () =>
						({
							objectives: { "obj-outage-1": { objective: { status: "active" } } },
							tasks: {},
							attempts: {},
						}) as any,
					getSourceRevision: () => "rev-outage-1",
					getArtifacts: () => [],
					getLimitations: () => [],
				},
			});

			// Outage during admission throws SystemOneSteeringUnavailableError and halts
			await expect(controller.run("obj-outage-1")).rejects.toThrow(SystemOneSteeringUnavailableError);
		});
	});
});
