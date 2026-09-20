import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	AdaptationCycleError,
	AdaptationGraph,
	type AdaptationNode,
	AdaptiveCapabilityController,
	AdaptiveResolutionController,
	CandidateDiscoveryService,
	CapabilityCatalog,
	CapabilityProofRunner,
	CapabilityResolver,
	type CapabilitySpec,
	compileExecutionCharter,
	DEFAULT_STEERING_POLICY,
	evaluateCharterAuthority,
	ResponsibilityRegistry,
	type ResponsibilityStatement,
	RuntimeAdaptationCoordinator,
	SemanticDuplicateResponsibilityError,
	SemanticResponsibilityController,
	SpecialistCatalog,
	SpecialistSynthesisController,
	SteeringCertificateStore,
	SteeringConfidenceTooLowError,
	SystemOneSteeringPlane,
	SystemOneSteeringUnavailableError,
	WaiverStore,
} from "../src/core/index.ts";
import type { JevAdapter, JevEvaluationRequest, JevEvaluationResponse } from "../src/core/system-one/adapter.ts";

class MockJevAdapter implements JevAdapter {
	evaluateResponse: Partial<JevEvaluationResponse> = {};
	evaluateCalls: JevEvaluationRequest[] = [];

	async evaluate(request: JevEvaluationRequest): Promise<JevEvaluationResponse> {
		this.evaluateCalls.push(request);
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
						defaultAnswers[id] = { type: "noul", noul: 0.95 };
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
						confidence: 0.95,
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
						confidence: 0.95,
						probabilities: probs,
					};
				}
			}
		}

		return {
			model: request.model ?? "jev-1.13.0",
			latency_ms: 10,
			...this.evaluateResponse,
			answers: {
				...defaultAnswers,
				...this.evaluateResponse.answers,
			},
		};
	}
}

describe("System One Steering, Adaptive Runtime, and Dedup (S1A-001..240)", () => {
	describe("System One Steering Plane (S1A-001..028)", () => {
		it("fails closed in system_one_required mode when adapter is missing", async () => {
			const plane = new SystemOneSteeringPlane({
				policy: {
					...DEFAULT_STEERING_POLICY,
					mode: "system_one_required",
				},
			});

			await expect(
				plane.requireCertificate("JEV-001", { state: "start" }, { objectiveId: "obj-1" }),
			).rejects.toThrow(SystemOneSteeringUnavailableError);
		});

		it("evaluates checkpoints and issues valid cryptographic certificates", async () => {
			const mockAdapter = new MockJevAdapter();
			const certStore = new SteeringCertificateStore();
			const plane = new SystemOneSteeringPlane({
				adapter: mockAdapter,
				policy: DEFAULT_STEERING_POLICY,
				certificates: certStore,
			});

			const cert = await plane.requireCertificate(
				"JEV-001",
				{ phase: "intake", query: "implement feature X" },
				{ objectiveId: "obj-100" },
			);

			expect(cert).toBeDefined();
			expect(cert.checkpoint_id).toBe("JEV-001");
			expect(cert.objective_id).toBe("obj-100");
			expect(cert.directive).toBe("continue_current_work");
			expect(cert.action_confidence).toBeGreaterThanOrEqual(0.75);
			expect(cert.question_pack.digest).toBeTruthy();
			expect(cert.state_digest).toBeTruthy();
			expect(cert.policy.digest).toBeTruthy();

			// Verify cached in certificate store
			const fetched = certStore.get(cert.certificate_id);
			expect(fetched).toEqual(cert);
		});

		it("throws SteeringConfidenceTooLowError when confidence is below required threshold (S1A-010)", async () => {
			const mockAdapter = new MockJevAdapter();
			// Default consequence for medium is 0.75, so probability 0.50 yields confidence 0.50 (low confidence error)
			mockAdapter.evaluateResponse = {
				answers: {
					objective_coherent: { type: "noul", noul: 0.5 },
				},
			};

			const plane = new SystemOneSteeringPlane({
				adapter: mockAdapter,
				policy: DEFAULT_STEERING_POLICY,
			});

			await expect(
				plane.requireCertificate("JEV-001", { phase: "intake" }, { objectiveId: "obj-101" }),
			).rejects.toThrow(SteeringConfidenceTooLowError);
		});
	});

	describe("Adaptive Resolution DAG and Minimality (S1A-040)", () => {
		it("detects and rejects cycles in adaptation graph (S1A-141)", () => {
			const graph = new AdaptationGraph();
			const node1: AdaptationNode = {
				schema_version: "1.0",
				node_id: "node-1",
				kind: "strategy_change",
				fingerprint: "fp-1",
				certificate_refs: ["cert-1"],
				status: "active",
			};
			const node2: AdaptationNode = {
				schema_version: "1.0",
				node_id: "node-2",
				kind: "expert_reroute",
				fingerprint: "fp-2",
				certificate_refs: ["cert-2"],
				status: "active",
			};

			graph.addNode(node1);
			graph.addNode(node2);
			graph.addDependency(node2.node_id, node1.node_id);

			// Adding dependency node1 -> node2 creates a cycle and must throw
			expect(() => graph.addDependency(node1.node_id, node2.node_id)).toThrow(AdaptationCycleError);
		});

		it("evaluates adaptation dimension order strictly by minimality", async () => {
			const mockAdapter = new MockJevAdapter();
			mockAdapter.evaluateResponse = {
				answers: {
					lowest_adequate_adaptation: {
						type: "choice",
						choice: "expert_reroute",
						confidence: 0.99,
						probabilities: {
							strategy_change: 0.0,
							context_refresh: 0.0,
							expert_reroute: 1.0,
							new_specialist: 0.0,
							capability_resolution: 0.0,
							runtime_patch: 0.0,
						},
					},
				},
			};

			const plane = new SystemOneSteeringPlane({
				adapter: mockAdapter,
				policy: DEFAULT_STEERING_POLICY,
			});

			const controller = new AdaptiveResolutionController({ steering: plane });
			const resolution = await controller.resolve({
				objectiveId: "obj-201",
				taskId: "task-reroute",
				currentExpert: "expert-default",
			});

			expect(resolution).toBeDefined();
			expect(resolution.dimension).toBe("expert_reroute");
			expect(resolution.node).toBeDefined();
		});
	});

	describe("Specialist Synthesis (S1A-031..039)", () => {
		it("synthesizes specialist, records certificate, and materializes specialist record", async () => {
			const mockAdapter = new MockJevAdapter();

			const plane = new SystemOneSteeringPlane({
				adapter: mockAdapter,
				policy: DEFAULT_STEERING_POLICY,
			});

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
					createTaskProfile: () => ({ created: true, profileId: "profile-ui-craft" }),
					inspectTaskProfileOptions: () => ({
						baseProfiles: [],
						inheritedToolNames: [],
						models: [],
					}),
				},
			});

			const result = await controller.resolveOrCreate({
				objectiveId: "obj-300",
				taskId: "task-ui-craft",
				need: {
					specialty: "ui_craft_specialist",
					purpose: "High-end design engineering interface implementation",
					requiredSkills: ["design-taste-frontend", "emil-design-engineering"],
				},
			});

			expect(result.spec).toBeDefined();
			expect(result.spec.specialties).toContain("ui_craft_specialist");
			expect(result.profileId).toBeTruthy();
			expect(result.executionContract.authorityRole).toBe("implementer");
			expect(result.isExisting).toBe(false);
		});
	});

	describe("Capability Resolution and Synthesis (S1A-007..016)", () => {
		it("resolves existing capability via wide ranking and deep fit", async () => {
			const mockAdapter = new MockJevAdapter();

			const plane = new SystemOneSteeringPlane({
				adapter: mockAdapter,
				policy: DEFAULT_STEERING_POLICY,
			});

			const catalog = new CapabilityCatalog();
			const spec: CapabilitySpec = {
				schema_version: "1.0",
				capability_id: "cap-git-diff",
				version: "1.0.0",
				kind: "tool",
				purpose: "Inspect repository diffs accurately",
				lifetime: "global",
				interface: {
					inputs: { path: "string" },
					outputs: { diff: "string" },
				},
				side_effects: ["read_only"],
				denied_behavior: [],
				proof: {
					deterministic_tests: ["test/git-diff.test.ts"],
					task_specific_test: "test/diff.test.ts",
				},
				activation: {},
				rollback: {},
			};
			catalog.registerCapability(spec);

			const resolver = new CapabilityResolver(catalog, plane);
			const need = {
				requiredOutcome: "inspect git diffs",
				requiredInputs: ["path"],
				requiredOutputs: ["diff"],
			};

			const wide = await resolver.rankWide(need, {
				objectiveId: "obj-400",
				taskId: "task-inspect",
			});

			expect(wide).toBeDefined();
			expect(wide.need.requiredOutcome).toBe("inspect git diffs");
		});

		it("synthesizes capability and passes through gap specification, verification, and smoke (JEV-009..015)", async () => {
			const mockAdapter = new MockJevAdapter();

			const plane = new SystemOneSteeringPlane({
				adapter: mockAdapter,
				policy: DEFAULT_STEERING_POLICY,
			});

			const catalog = new CapabilityCatalog();
			const controller = new AdaptiveCapabilityController({
				steering: plane,
				catalog,
				// The builder's model binding must be an actual H-MoE selection; this test's subject is
				// the synthesis pipeline, so the selection is a fixed one rather than absent.
				experts: {
					select: async () => ({
						primary: { provider: "anthropic", model_id: "claude-3-7-sonnet", thinking_level: "medium" },
						bindings: [{ provider: "anthropic", model_id: "claude-3-7-sonnet", thinking_level: "medium" }],
					}),
				} as never,
				builder: {
					// Activation smokes the artifact by running it, so the builder produces a real one.
					build: async (_spec) => {
						const directory = mkdtempSync(join(tmpdir(), "pi-s1a-capability-"));
						const artifactPath = join(directory, `${_spec.capability_id}.mjs`);
						const code = "export default async function run() { return true; }\n";
						writeFileSync(artifactPath, code, "utf-8");
						return {
							capabilityId: _spec.capability_id,
							kind: _spec.kind,
							code,
							digest: createHash("sha256").update(code).digest("hex"),
							artifactUri: pathToFileURL(artifactPath).href,
						};
					},
				},
				proofRunner: new CapabilityProofRunner(),
				mechanicalVerifier: {
					verifyCandidate: async (_candidate, _spec) => ({
						passed: true,
						testCount: 3,
						failures: [],
						evidence: { testCount: 3, passed: 3 },
					}),
					verifyActivation: async (_actRes, _spec) => true,
					runTaskSpecificProof: async (_spec) => "task_specific_proof_verified",
				},
				activator: {
					activate: async (_candidate, _spec) => ({
						active: true,
						projection: { active: true },
					}),
				},
			});

			const established = await controller.resolveOrBuild({
				objectiveId: "obj-401",
				taskId: "task-new-tool",
				need: {
					requiredOutcome: "Parse untrusted payload securely",
				},
			});

			expect(established).toBeDefined();
			expect(established.capabilityId).toBeTruthy();
			expect(established.record.state).toBe("active_ephemeral");
			expect(established.isExisting).toBe(false);
		});
	});

	describe("Semantic Responsibility Deduplication (S1A-041..045, S1A-201..240)", () => {
		it("limits candidate discovery to at most 12 candidates", async () => {
			const registry = new ResponsibilityRegistry();
			for (let i = 0; i < 20; i++) {
				registry.register({
					schema_version: "1.0",
					responsibility_id: `resp-${i}`,
					statement: `Read and write file records ${i}`,
					owner_locations: ["src/io.ts"],
					source_revision: "rev-1",
					evidence_refs: [],
					status: "active",
				});
			}

			const discovery = new CandidateDiscoveryService({ registry });
			const proposed: ResponsibilityStatement = {
				statement: "Read and write file records",
				targetLocation: "src/io.ts",
			};
			const candidates = await discovery.findCandidates(proposed);

			expect(candidates.length).toBeLessThanOrEqual(12);
		});

		it("throws SemanticDuplicateResponsibilityError on duplicate without waiver", async () => {
			const mockAdapter = new MockJevAdapter();
			mockAdapter.evaluateResponse = {
				answers: {
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
				},
			};

			const plane = new SystemOneSteeringPlane({
				adapter: mockAdapter,
				policy: DEFAULT_STEERING_POLICY,
			});

			const registry = new ResponsibilityRegistry();
			registry.register({
				schema_version: "1.0",
				responsibility_id: "resp-auth-verify",
				statement: "Verify Auth Bearer Token",
				owner_locations: ["src/auth.ts"],
				source_revision: "rev-1",
				evidence_refs: [],
				status: "active",
			});

			const discovery = new CandidateDiscoveryService({ registry });
			const waivers = new WaiverStore();
			const dedupController = new SemanticResponsibilityController({
				steering: plane,
				registry,
				discovery,
				waivers,
			});

			await expect(
				dedupController.preImplementation({
					objectiveId: "obj-500",
					taskId: "task-auth-dup",
					proposed: {
						statement: "Verify Auth Bearer Token",
						targetLocation: "src/auth.ts",
					},
				}),
			).rejects.toThrow(SemanticDuplicateResponsibilityError);
		});

		it("allows implementation when explicit intentional waiver is recorded (S1A-206)", async () => {
			const mockAdapter = new MockJevAdapter();
			mockAdapter.evaluateResponse = {
				answers: {
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
					waiver_valid: { type: "noul", noul: 0.98 },
				},
			};

			const plane = new SystemOneSteeringPlane({
				adapter: mockAdapter,
				policy: DEFAULT_STEERING_POLICY,
			});

			const registry = new ResponsibilityRegistry();
			registry.register({
				schema_version: "1.0",
				responsibility_id: "resp-auth-verify-2",
				statement: "Verify Auth Bearer Token",
				owner_locations: ["src/auth.ts"],
				source_revision: "rev-1",
				evidence_refs: [],
				status: "active",
			});

			const discovery = new CandidateDiscoveryService({ registry });
			const waivers = new WaiverStore();
			waivers.registerWaiver({
				schema_version: "1.0",
				waiver_id: "waiver-auth-1",
				objective_id: "obj-501",
				responsibility_scope: "*",
				source: "owner_policy",
				reason: "Isolated sandbox test fixture required",
				expires_with_objective: true,
			});

			const dedupController = new SemanticResponsibilityController({
				steering: plane,
				registry,
				discovery,
				waivers,
			});

			const disposition = await dedupController.preImplementation({
				objectiveId: "obj-501",
				taskId: "task-auth-waived",
				proposed: {
					statement: "Verify Auth Bearer Token",
					targetLocation: "src/auth.ts",
				},
			});

			expect(disposition.outcome).toBe("separate_required");
			expect(disposition.waiver_id).toBe("waiver-auth-1");
		});
	});

	describe("Execution Charter in start_only mode (S1A-101..130)", () => {
		it("compiles charter with automated git and deploy side effects from prompt", () => {
			const charter = compileExecutionCharter({
				objectiveId: "obj-600",
				prompt: "commit and push all changes and deploy to staging",
			});

			expect(charter.git.commit).toBe(true);
			expect(charter.git.push).toBe(true);
			expect(charter.release.deploy_targets).toContain("staging");
		});

		it("enforces start_only authority envelope and rejects ungranted permissions", () => {
			const charter = compileExecutionCharter({
				objectiveId: "obj-601",
				prompt: "commit changes", // no push, no publish
			});

			const allowed = evaluateCharterAuthority(charter, { kind: "commit" });
			expect(allowed.outcome).toBe("allow");

			const blocked = evaluateCharterAuthority(charter, { kind: "push" });
			expect(blocked.outcome).toBe("deny");
		});
	});

	describe("Runtime Adaptation Rollback and Crash Recovery (S1A-180)", () => {
		it("rolls back candidate mutation when verification fails", async () => {
			const mockAdapter = new MockJevAdapter();

			const plane = new SystemOneSteeringPlane({
				adapter: mockAdapter,
				policy: DEFAULT_STEERING_POLICY,
			});

			let rolledBack = false;
			const updater = {
				createSnapshot: async () => ({
					snapshotId: "snap-1",
					baselineRevision: "rev-1",
					backupState: {},
					timestamp: new Date().toISOString(),
				}),
				applyUpdate: async () => ({ applied: true, restartRequired: false }),
				verifyRuntime: async () => ({ healthy: false, reason: "Smoke check failed" }),
				rollback: async () => {
					rolledBack = true;
				},
				commit: async () => {},
			};

			const coordinator = new RuntimeAdaptationCoordinator(plane, updater);
			const spec: CapabilitySpec = {
				schema_version: "1.0",
				capability_id: "patch-1",
				version: "1.0.0",
				kind: "runtime_patch",
				purpose: "Runtime hotfix",
				lifetime: "session",
				interface: {},
				side_effects: [],
				denied_behavior: [],
				proof: { deterministic_tests: [], task_specific_test: "" },
				activation: {},
				rollback: {},
			};

			const res = await coordinator.executeRuntimeModification({
				objectiveId: "obj-700",
				taskId: "task-patch",
				spec,
				diff: "+ patch line",
			});

			expect(res.success).toBe(false);
			expect(res.rolledBack).toBe(true);
			expect(rolledBack).toBe(true);
		});
	});
});
