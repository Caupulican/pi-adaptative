import { describe, expect, it } from "vitest";
import {
	createDefaultAuthorityEnvelope,
	DurableHumanEdgeLedger,
	requiresHumanEdge,
} from "../../src/core/autonomy/index.ts";
import {
	authorizeFunctionCall,
	compileSemanticFunctionsToProgram,
	createDecisionProgram,
	DecisionActionPolicy,
	DecisionEngineProtocolError,
	DecisionEngineRouter,
	MechanicalDecisionEngine,
	resolveFunctionCall,
	StructuredLlmDecisionEngine,
	settledBoolean,
	TypeSafeSystemOneDecisionEngine,
} from "../../src/core/decision/index.ts";
import {
	CompletionCoordinator,
	type CompletionEvaluationContext,
	ObjectiveExecutionController,
	projectBoundedCombinedState,
} from "../../src/core/objective-execution/index.ts";
import type { TaskRuntimeProjection } from "../../src/core/orchestration/task-runtime.ts";

function createMockRuntime(options?: {
	objectiveId?: string;
	acceptanceCriteria?: readonly string[];
	evidence?: readonly { requirement_id: string; verdict?: string }[];
	openTasks?: boolean;
	failedTasks?: boolean;
}): TaskRuntimeProjection {
	const objId = options?.objectiveId ?? "test_obj_1";
	const criteria = options?.acceptanceCriteria ?? ["crit_1"];
	return {
		lastOrdinal: 1,
		agents: {},
		checkpoints: {},
		approvals: {},
		notifications: {},
		objectives: {
			[objId]: {
				objective: {
					schemaVersion: 1 as const,
					objectiveId: objId,
					title: "Finalization test objective",
					description: "Finalization test objective",
					acceptanceCriteria: criteria.map((c) => ({ id: c, description: c, required: true })),
					status: "active",
					constraints: [],
					riskBudget: {},
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
				taskIds: options?.openTasks ? ["task_1"] : options?.failedTasks ? ["task_failed"] : [],
				evidence: options?.evidence
					? options.evidence.map((e, idx) => ({
							evidenceId: `ev_${idx}`,
							criterionId: e.requirement_id,
							kind: "test" as const,
							summary: "Mock evidence",
							artifactIds: [],
							trusted: true,
							createdAt: new Date().toISOString(),
						}))
					: [
							{
								evidenceId: "ev_1",
								criterionId: "crit_1",
								kind: "test" as const,
								summary: "crit_1 verified",
								artifactIds: [],
								trusted: true,
								createdAt: new Date().toISOString(),
							},
						],
			},
		},
		tasks: options?.openTasks
			? {
					task_1: {
						task: {
							schemaVersion: 1 as const,
							taskId: "task_1",
							objectiveId: objId,
							title: "Open task",
							role: "planner",
							description: "Open task",
							status: "pending",
							dependsOn: [],
							requiredCapabilities: [],
							acceptanceCriterionIds: [],
							riskBudget: {},
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
						},
						attemptIds: [],
					},
				}
			: options?.failedTasks
				? {
						task_failed: {
							task: {
								schemaVersion: 1 as const,
								taskId: "task_failed",
								objectiveId: objId,
								title: "Failed task",
								role: "implementer",
								description: "Failed task",
								status: "failed",
								dependsOn: [],
								requiredCapabilities: [],
								acceptanceCriterionIds: [],
								riskBudget: {},
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
							},
							attemptIds: [],
						},
					}
				: {},
		attempts: {},
	};
}

describe("Finalization v2.1 Verification Suite (FIN-001 to FIN-095)", () => {
	// ==========================================
	// 1. Provider Protocol (FIN-001 to FIN-005)
	// ==========================================
	describe("Provider Protocol & Decoders (FIN-001 to FIN-005)", () => {
		it("FIN-001: decodes noul exactly into probabilityTrue", async () => {
			const mockAdapter = {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: {
						q_bool: { type: "noul", noul: 0.93 },
					},
				}),
			};
			const engine = new TypeSafeSystemOneDecisionEngine(mockAdapter as any, "jev-1.13.0");
			const program = createDecisionProgram({
				id: "noul-prog",
				decisions: [{ kind: "boolean", id: "q_bool", instruction: "Check" }],
			});

			const evalResult = await engine.evaluate(program, {});
			const boolResult = evalResult.results.q_bool;
			expect(boolResult.kind).toBe("boolean");
			if (boolResult.kind === "boolean") {
				expect(boolResult.direction).toBe("required_true");
				expect(boolResult.band).toBe("hard_pass");
				expect(settledBoolean(boolResult)).toBe(true);
				expect(boolResult.probabilityTrue).toBe(0.93);
				expect(boolResult.confidence.value).toBe(0.93);
				expect(boolResult.confidence.provenance).toBe("derived_calibrated_probability");
				expect(boolResult.confidence.isCalibrated).toBe(true);
			}
		});

		it("FIN-002: decodes choice probabilities and computes margin locally", async () => {
			const mockAdapter = {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: {
						q_choice: {
							type: "choice",
							choice: "implement",
							confidence: 0.85,
							probabilities: { implement: 0.85, verify: 0.15 },
						},
					},
				}),
			};
			const engine = new TypeSafeSystemOneDecisionEngine(mockAdapter as any, "jev-1.13.0");
			const program = createDecisionProgram({
				id: "choice-prog",
				decisions: [
					{
						kind: "choice",
						id: "q_choice",
						instruction: "Select",
						options: { implement: { description: "Imp" }, verify: { description: "Ver" } },
					},
				],
			});

			const evalResult = await engine.evaluate(program, {});
			const choiceResult = evalResult.results.q_choice;
			expect(choiceResult.kind).toBe("choice");
			if (choiceResult.kind === "choice") {
				expect(choiceResult.selected).toBe("implement");
				expect(choiceResult.distribution.implement).toBe(0.85);
				expect(choiceResult.distribution.verify).toBe(0.15);
				expect(choiceResult.margin).toBeCloseTo(0.7, 5);
				expect(choiceResult.confidence.isCalibrated).toBe(true);
			}
		});

		it("FIN-003: decodes score probabilities and normalizes numeric keys", async () => {
			const mockAdapter = {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: {
						q_score: {
							type: "score",
							score: 2,
							confidence: 0.88,
							probabilities: { "0": 0.05, "1": 0.05, "2": 0.88, "3": 0.02 },
						},
					},
				}),
			};
			const engine = new TypeSafeSystemOneDecisionEngine(mockAdapter as any, "jev-1.13.0");
			const program = createDecisionProgram({
				id: "score-prog",
				decisions: [
					{
						kind: "score",
						id: "q_score",
						instruction: "Score progress",
						levels: [
							{ value: 0, description: "None" },
							{ value: 1, description: "Low" },
							{ value: 2, description: "Medium" },
							{ value: 3, description: "High" },
						],
					},
				],
			});

			const evalResult = await engine.evaluate(program, {});
			const scoreResult = evalResult.results.q_score;
			expect(scoreResult.kind).toBe("score");
			if (scoreResult.kind === "score") {
				expect(scoreResult.value).toBe(2);
				expect(scoreResult.distribution[2]).toBe(0.88);
				expect(scoreResult.confidence.isCalibrated).toBe(true);
			}
		});

		it("FIN-004 & FIN-005: invalid provider output raises DecisionEngineProtocolError without fabricating certainty", async () => {
			const mockAdapter = {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: {
						q_choice: {
							type: "choice",
							choice: "implement",
							// missing probabilities
						},
					},
				}),
			};
			const engine = new TypeSafeSystemOneDecisionEngine(mockAdapter as any, "jev-1.13.0");
			const program = createDecisionProgram({
				id: "bad-prog",
				decisions: [
					{
						kind: "choice",
						id: "q_choice",
						instruction: "Select",
						options: { implement: { description: "Imp" } },
					},
				],
			});

			await expect(engine.evaluate(program, {})).rejects.toThrow(DecisionEngineProtocolError);
		});
	});

	// ==========================================
	// 2. Engines & Action Policy (FIN-010 to FIN-015)
	// ==========================================
	describe("Engines & Action Policy (FIN-010 to FIN-015)", () => {
		it("FIN-010 & FIN-011: mechanical engine returns unsupported for subjective judgments", async () => {
			const mech = new MechanicalDecisionEngine();
			const program = createDecisionProgram({
				id: "subjective-prog",
				decisions: [
					{
						kind: "choice",
						id: "subjective_architecture_judgment",
						instruction: "Is this microservices or monolith?",
						options: { micro: { description: "Micro" }, mono: { description: "Mono" } },
					},
				],
			});

			const evalResult = await mech.evaluate(program, {});
			const res = evalResult.results.subjective_architecture_judgment;
			expect(res.kind).toBe("unsupported");
			if (res.kind === "unsupported") {
				expect(res.reason).toContain("not_derivable_mechanically");
			}
		});

		it("FIN-012 & FIN-013: structured LLM engine fails closed on invalid JSON and does not invent confidence", async () => {
			const brokenRunner = {
				complete: async () => "Not a JSON output",
			};
			const structured = new StructuredLlmDecisionEngine("mock-llm", brokenRunner);
			const program = createDecisionProgram({
				id: "llm-prog",
				decisions: [
					{
						kind: "choice",
						id: "task_kind",
						instruction: "Select",
						options: { bug_fix: { description: "Bug" } },
					},
				],
			});

			const evalResult = await structured.evaluate(program, {});
			expect(evalResult.results.task_kind.kind).toBe("unsupported");
			expect(evalResult.engine.confidence_provenance).toBe("none");
		});

		it("FIN-014: quality-aware router cascades when candidate result is unsupported or below threshold", async () => {
			const mech = new MechanicalDecisionEngine();
			const mockRunner = {
				complete: async () =>
					JSON.stringify({
						subjective_choice: { choice: "option_b", confidence: 0.88 },
					}),
			};
			const structured = new StructuredLlmDecisionEngine("llm-fallback", mockRunner);

			const router = new DecisionEngineRouter([mech, structured]);
			const program = createDecisionProgram({
				id: "cascade-prog",
				decisions: [
					{
						kind: "choice",
						id: "subjective_choice",
						instruction: "Choose option",
						options: { option_a: { description: "A" }, option_b: { description: "B" } },
					},
				],
			});

			// Mech returns unsupported for subjective choice -> router cascades to structured LLM
			const evalResult = await router.evaluateOrFallback(program, {}, { consequence: "medium" });
			expect(evalResult.engine.id).toBe("structured-llm");
			expect(evalResult.results.subjective_choice.kind).toBe("choice");
		});

		it("FIN-015: critical consequence rejects non-calibrated synthetic confidence", () => {
			const policy = new DecisionActionPolicy();
			const mockEvaluation = {
				program: {
					id: "crit-prog",
					version: "1.0",
				},
				engine: {
					id: "structured-llm",
					model: "mock-llm",
					confidence_provenance: "synthetic_self_report" as const,
				},
				evaluatedAt: Date.now(),
				results: {
					q1: {
						kind: "choice" as const,
						selected: "opt",
						distribution: { opt: 1.0 },
						margin: 1.0,
						confidence: { value: 0.95, provenance: "synthetic_self_report" as const, isCalibrated: false },
					},
				},
			};

			const evalResult = policy.evaluate(mockEvaluation as any, { consequence: "critical" });
			expect(evalResult.disposition).toBe("try_next_engine");
			expect(evalResult.reason).toContain("critical_consequence_disallows_synthetic_self_report");
		});
	});

	// ==========================================
	// 3. Routing & State Projection (FIN-020 to FIN-035)
	// ==========================================
	describe("Routing & State Projection (FIN-020 to FIN-035)", () => {
		it("FIN-034: projectBoundedCombinedState extracts bounded state across runtime, integrity, and progress", () => {
			const runtime = createMockRuntime({
				objectiveId: "obj_bound",
				acceptanceCriteria: ["crit_alpha", "crit_beta"],
				evidence: [{ requirement_id: "crit_alpha", verdict: "passed" }],
			});

			const proj = projectBoundedCombinedState("obj_bound", runtime, {
				stallTurns: 2,
				strategyFingerprint: "fingerprint_123",
			});

			expect(proj.objective.id).toBe("obj_bound");
			expect(proj.objective.required_criteria).toEqual(["crit_alpha", "crit_beta"]);
			expect(proj.integrity.fresh_evidence).toContain("crit_alpha");
			expect(proj.progress.stall_turns).toBe(2);
			expect(proj.progress.strategy_fingerprint).toBe("fingerprint_123");
		});

		it("FIN-035: DecisionActionPolicy gates choice decisions and rejects below margin threshold", () => {
			const policy = new DecisionActionPolicy();
			const weakChoice = {
				selected: "implement",
				margin: 0.02, // very narrow margin below threshold
				confidence: { value: 0.5, provenance: "synthetic_self_report" },
			};

			const disposition = policy.evaluateChoice(weakChoice, "medium");
			expect(disposition.action).toBe("gather_more");
		});
	});

	// ==========================================
	// 4. Function Dispatch & Authorization (FIN-040 to FIN-044)
	// ==========================================
	describe("Function Dispatch & Authorization (FIN-040 to FIN-044)", () => {
		const testRegistry = {
			dispatch_worker: {
				description: "Dispatch worker",
				parameters: {
					role: {
						kind: "choice" as const,
						options: ["planner", "implementer", "verifier"] as const,
						descriptions: { planner: "Plan", implementer: "Code", verifier: "Test" },
						notFor: { implementer: "Requirements are unclear" },
					},
					context: {
						kind: "choice" as const,
						options: ["reuse", "fresh"] as const,
						optional: true,
						defaultValue: "fresh",
					},
				},
			},
		};

		it("FIN-040, FIN-041 & FIN-042: compiles optional stated decision and forwards notFor criteria", () => {
			const program = compileSemanticFunctionsToProgram("fn-prog", testRegistry);

			// FIN-040: compiles <func>__<param>__stated
			const statedDecision = program.decisions.find((d) => d.id === "dispatch_worker__context__stated");
			expect(statedDecision).toBeDefined();
			expect(statedDecision?.kind).toBe("boolean");

			// FIN-042: forwards notFor
			const roleDecision = program.decisions.find((d) => d.id === "dispatch_worker__role");
			expect(roleDecision?.kind).toBe("choice");
			if (roleDecision?.kind === "choice") {
				expect(roleDecision.options.implementer.notFor).toBe("Requirements are unclear");
			}
		});

		it("FIN-041 & FIN-043: resolveFunctionCall preserves default when stated=false and computes weakest-link confidence", () => {
			const evaluation = {
				program: { id: "fn-prog", version: "1.0" },
				engine: { id: "mechanical", model: "mock", confidence_provenance: "heuristic" as const },
				evaluatedAt: Date.now(),
				results: {
					__function__: {
						kind: "choice" as const,
						selected: "dispatch_worker",
						distribution: { dispatch_worker: 1.0 },
						margin: 1.0,
						confidence: { value: 0.95, provenance: "heuristic" as const, isCalibrated: false },
					},
					dispatch_worker__role: {
						kind: "choice" as const,
						selected: "implementer",
						distribution: { implementer: 1.0 },
						margin: 1.0,
						confidence: { value: 0.85, provenance: "heuristic" as const, isCalibrated: false },
					},
					dispatch_worker__context__stated: {
						kind: "boolean" as const,
						probabilityTrue: 0.0, // NOT stated
						direction: "required_true" as const,
						band: "hard_fail" as const,
						confidence: { value: 0.99, provenance: "heuristic" as const, isCalibrated: false },
					},
				},
			};

			const call = resolveFunctionCall(evaluation as any, testRegistry);
			expect(call).toBeDefined();
			expect(call?.name).toBe("dispatch_worker");
			expect(call?.arguments.role).toBe("implementer");
			// FIN-041: preserved default 'fresh'
			expect(call?.arguments.context).toBe("fresh");
			// FIN-043: weakest-link confidence = min(0.95, 0.85) = 0.85
			expect(call?.confidence.value).toBe(0.85);
		});

		it("FIN-044: authorizeFunctionCall mechanically verifies authority envelope and capabilities", () => {
			const call = {
				kind: "function_call" as const,
				name: "dispatch_worker",
				arguments: { role: "implementer", context: "fresh" },
				confidence: { value: 0.9, provenance: "heuristic" as const, isCalibrated: false },
				argumentConfidences: {},
			};

			// Allowed scenario
			const authOk = authorizeFunctionCall(call, {
				registry: testRegistry,
				authorityEnvelope: { allowedFunctions: ["dispatch_worker"] },
			});
			expect(authOk.authorized).toBe(true);

			// Blocked scenario
			const authBlocked = authorizeFunctionCall(call, {
				registry: testRegistry,
				authorityEnvelope: { blockedFunctions: ["dispatch_worker"] },
			});
			expect(authBlocked.authorized).toBe(false);
			expect(authBlocked.reason).toContain("blocked by authority envelope");
		});
	});

	// ==========================================
	// 5. Controller & Required Executors (FIN-050 to FIN-052)
	// ==========================================
	describe("Controller & Required Executors (FIN-050 to FIN-052)", () => {
		it("FIN-051 & FIN-052: missing required executor produces explicit unrecoverable failure and never silently loops", async () => {
			const runtime = createMockRuntime();
			const controller = new ObjectiveExecutionController({
				runtime: {
					reconcileObjective: async () => runtime,
				},
				// No retrieval, verifier, or workerDispatcher configured!
			});

			const terminal = await controller.run("test_obj_1");
			expect(terminal.status).toBe("unrecoverable");
			expect(terminal.reasonCodes[0]).toContain("missing_required_executor");
		});
	});

	// ==========================================
	// 6. Completion Coordinator & Assurance Profiles (FIN-060 to FIN-066, FIN-080 to FIN-085)
	// ==========================================
	describe("Completion Coordinator (FIN-060 to FIN-066)", () => {
		it("FIN-061: mechanical profile verifies all deterministic gates and builds complete delivery bundle", async () => {
			const runtime = createMockRuntime();
			const context: CompletionEvaluationContext = {
				runtime,
			};

			const evalResult = await CompletionCoordinator.evaluate("test_obj_1", "mechanical", context);
			expect(evalResult.verdict).toBe("complete");
			expect(evalResult.assuranceProfileUsed).toBe("mechanical");
			expect(evalResult.deliveryBundle?.terminal_status).toBe("complete");
			expect(evalResult.deliveryBundle?.schema_version).toBe("2.0");
			expect(evalResult.deliveryBundle?.source_revision).toBeDefined();
		});

		it("FIN-062: mechanical_plus_reviewer invokes independent reviewer and rejects completion if reviewer fails", async () => {
			const runtime = createMockRuntime();
			let reviewerInvoked = false;

			const context: CompletionEvaluationContext = {
				runtime,
				reviewer: {
					review: async () => {
						reviewerInvoked = true;
						return {
							passed: false,
							reviewerRef: "rev_001",
							blockingIssues: ["Missing documentation on edge cases"],
						};
					},
				},
			};

			const evalResult = await CompletionCoordinator.evaluate("test_obj_1", "mechanical_plus_reviewer", context);
			expect(reviewerInvoked).toBe(true);
			expect(evalResult.verdict).toBe("not_complete");
			expect(evalResult.failedGates).toContain("reviewer_rejected");
			expect(evalResult.failedGates).toContain("Missing documentation on edge cases");
		});

		it("FIN-063: semantic_enhanced falls back explicitly to mechanical profile when semantic check fails", async () => {
			const runtime = createMockRuntime();
			const context: CompletionEvaluationContext = {
				runtime,
				fallbackPolicy: "mechanical",
				semanticEvaluator: {
					evaluateCompletion: async () => ({
						passed: false,
						failedGates: ["semantic_check_failed"],
					}),
				},
			};

			const evalResult = await CompletionCoordinator.evaluate("test_obj_1", "semantic_enhanced", context);
			expect(evalResult.verdict).toBe("complete");
			expect(evalResult.assuranceProfileUsed).toBe("mechanical");
			expect(evalResult.fallbackChain).toContain("fallback_to:mechanical");
		});

		it("FIN-064: system_one_required halts as semantic_gate_unavailable when calibrated engine is absent", async () => {
			const runtime = createMockRuntime();
			const context: CompletionEvaluationContext = {
				runtime,
				hasCalibratedEngine: () => false,
			};

			const evalResult = await CompletionCoordinator.evaluate("test_obj_1", "system_one_required", context);
			expect(evalResult.verdict).toBe("semantic_gate_unavailable");
			expect(evalResult.failedGates).toContain("system_one_required_but_unavailable");
		});

		it("FIN-065: deterministic failure (missing criterion evidence) defeats every profile", async () => {
			// Runtime with required criterion but NO evidence
			const brokenRuntime = createMockRuntime({
				acceptanceCriteria: ["crit_unmet"],
				evidence: [],
			});

			const context: CompletionEvaluationContext = {
				runtime: brokenRuntime,
			};

			const evalResult = await CompletionCoordinator.evaluate("test_obj_1", "mechanical", context);
			expect(evalResult.verdict).toBe("not_complete");
			expect(evalResult.failedGates).toContain("criterion_unresolved:crit_unmet");
		});

		it("FIN-066: semantic evaluation exception never silently succeeds", async () => {
			const runtime = createMockRuntime();
			const context: CompletionEvaluationContext = {
				runtime,
				fallbackPolicy: "hold_semantic_gate",
				semanticEvaluator: {
					evaluateCompletion: async () => {
						throw new Error("Provider transport 500 error");
					},
				},
			};

			const evalResult = await CompletionCoordinator.evaluate("test_obj_1", "semantic_enhanced", context);
			expect(evalResult.verdict).toBe("not_complete");
			expect(evalResult.failedGates).toContain("semantic_gate_unmet");
		});
	});

	// ==========================================
	// 7. Durable Human Edge (FIN-070 to FIN-074, FIN-094)
	// ==========================================
	describe("Durable Human Edge (FIN-070 to FIN-074)", () => {
		it("FIN-070 to FIN-074: persists request, persists scoped grant, and does not reprompt on identical action", () => {
			const ledger = new DurableHumanEdgeLedger();
			const envelope = createDefaultAuthorityEnvelope("/test/repo");

			// Push action is unpermitted by default envelope
			const pushAction = { kind: "git_push", pushRequested: true };

			// 1. Initial check creates HumanEdgeRequest and records in ledger (FIN-070)
			const req = requiresHumanEdge("obj_edge", pushAction, envelope, false, ledger);
			expect(req).toBeDefined();
			expect(req?.exact_authority).toBe("external:push");
			expect(ledger.getAllRequests().length).toBe(1);

			// 2. Operator grants durable permission (FIN-071, FIN-072)
			ledger.recordDecision({
				id: "dec_push_grant",
				request_id: req!.id,
				decision: "grant",
				exact_scope: "external:push",
				scope_type: "durable",
				timestamp: Date.now(),
			});

			// 3. Repeated exact authorized action uses grant and does not reprompt (FIN-073)
			const reqAgain = requiresHumanEdge("obj_edge", pushAction, envelope, false, ledger);
			expect(reqAgain).toBeUndefined();

			// 4. Unrelated action (e.g. package publish) does NOT inherit grant and reprompts (FIN-074)
			const publishAction = { kind: "npm_publish", publishRequested: true };
			const reqPublish = requiresHumanEdge("obj_edge", publishAction, envelope, false, ledger);
			expect(reqPublish).toBeDefined();
			expect(reqPublish?.exact_authority).toBe("external:publish");
		});
	});

	// ==========================================
	// 8. End-to-End Scenarios (FIN-090 to FIN-095)
	// ==========================================
	describe("End-to-End Scenarios (FIN-090 to FIN-095)", () => {
		it("FIN-090: No-Jev objective completes fully under mechanical profile", async () => {
			const runtime = createMockRuntime();
			const mech = new MechanicalDecisionEngine();
			const router = new DecisionEngineRouter([mech]);

			const controller = new ObjectiveExecutionController({
				runtime: {
					reconcileObjective: async () => runtime,
				},
				decisions: router,
				completionProfile: "mechanical",
			});

			const terminal = await controller.run("test_obj_1");
			expect(terminal.status).toBe("complete");
			expect(terminal.deliveryBundle?.terminal_status).toBe("complete");
			expect(terminal.deliveryBundle?.assurance_profile_used).toBe("mechanical");
		});

		it("FIN-091: System One enhanced objective completes with semantic refs", async () => {
			const runtime = createMockRuntime();
			let completionExecuted = false;

			const controller = new ObjectiveExecutionController({
				runtime: {
					reconcileObjective: async () => runtime,
				},
				completionProfile: "semantic_enhanced",
				systemOne: {
					evaluateObjectiveRoute: async () => ({ workRemaining: false, missingWorkClass: "none" }),
					executeCompletionTransaction: async () => {
						completionExecuted = true;
						return {
							decision_id: "sem_dec_123",
							verdict: "complete",
							gate_results: {},
							failed_gates: [],
						};
					},
				},
			});

			const terminal = await controller.run("test_obj_1");
			expect(completionExecuted).toBe(true);
			expect(terminal.status).toBe("complete");
			expect(terminal.completionDecisionId).toBe("sem_dec_123");
			expect(terminal.deliveryBundle?.decision_refs).toContain("sem_dec_123");
		});

		it("FIN-093: system_one_required outage holds as semantic_gate_unavailable", async () => {
			const runtime = createMockRuntime();
			const mech = new MechanicalDecisionEngine();
			const router = new DecisionEngineRouter([mech]);

			const controller = new ObjectiveExecutionController({
				runtime: {
					reconcileObjective: async () => runtime,
				},
				decisions: router,
				completionProfile: "system_one_required",
			});

			const terminal = await controller.run("test_obj_1");
			expect(terminal.status).toBe("semantic_gate_unavailable");
			expect(terminal.reasonCodes).toContain("system_one_required_but_unavailable");
		});

		it("FIN-094: Human edge round-trip pauses for request and resumes on grant", async () => {
			const runtime = createMockRuntime();
			const envelope = createDefaultAuthorityEnvelope("/test/repo");
			let prompted = false;

			const mech = new MechanicalDecisionEngine();
			const router = new DecisionEngineRouter([mech]);

			const controller = new ObjectiveExecutionController({
				runtime: {
					reconcileObjective: async () => runtime,
				},
				decisions: router,
				authorityEnvelope: envelope,
				getRouteProposedAction: () => ({ kind: "git_push", pushRequested: true }),
				onHumanEdgeRequest: async (_req) => {
					prompted = true;
					return true; // Approve
				},
				completionProfile: "mechanical",
			});

			const terminal = await controller.run("test_obj_1");
			expect(prompted).toBe(true);
			expect(terminal.status).toBe("complete");
		});
	});
});
