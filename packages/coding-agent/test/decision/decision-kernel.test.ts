import { describe, expect, it } from "vitest";
import {
	createDefaultAuthorityEnvelope,
	requiresHumanEdge,
	validateProposedAction,
} from "../../src/core/autonomy/index.ts";
import {
	booleanParam,
	choice,
	compileSemanticFunctionsToProgram,
	createDecisionEvaluation,
	createDecisionProgram,
	DecisionEngineRouter,
	defineSemanticFunctions,
	MechanicalDecisionEngine,
	optionalChoice,
	resolveFunctionCall,
	StructuredLlmDecisionEngine,
	supportsProgram,
	TypeSafeSystemOneDecisionEngine,
	weakestCallConfidence,
} from "../../src/core/decision/index.ts";

describe("Decision Kernel IR & Confidence", () => {
	it("ADR-010: Decision IR contains Boolean, Choice, Score, Set", () => {
		const program = createDecisionProgram({
			id: "test-prog-1",
			version: "1.0.0",
			decisions: [
				{ kind: "boolean", id: "bool_1", instruction: "Is condition met?" },
				{
					kind: "choice",
					id: "choice_1",
					instruction: "Select action",
					options: { a: { description: "Option A" }, b: { description: "Option B" } },
				},
				{
					kind: "score",
					id: "score_1",
					instruction: "Rate progress",
					levels: [
						{ value: 0, description: "None" },
						{ value: 1, description: "Full" },
					],
				},
				{
					kind: "set",
					id: "set_1",
					instructionTemplate: "Member of set",
					members: { x: "Item X", y: "Item Y" },
				},
			],
		});

		expect(program.schema_version).toBe("2.0");
		expect(program.decisions).toHaveLength(4);
		expect(program.decisions.map((d) => d.kind)).toEqual(["boolean", "choice", "score", "set"]);
	});

	it("ADR-015: weakest-link function confidence uses minimum confidence among required judgments", () => {
		const conf1 = { value: 0.95, provenance: "native_calibrated" as const, isCalibrated: true };
		const conf2 = { value: 0.82, provenance: "native_calibrated" as const, isCalibrated: true };
		const conf3 = { value: 0.99, provenance: "native_calibrated" as const, isCalibrated: true };

		const result = weakestCallConfidence([conf1, conf2, conf3]);
		expect(result.value).toBe(0.82);
		expect(result.provenance).toBe("native_calibrated");
		expect(result.isCalibrated).toBe(true);
	});

	it("ADR-016: optional semantic parameters support defaults and applicability", () => {
		const registry = defineSemanticFunctions({
			dispatch_worker: {
				description: "Dispatch worker",
				parameters: {
					role: choice(["planner", "verifier"]),
					context: optionalChoice(["reuse", "fresh"], "fresh"),
					independent: booleanParam("Independent worker", false),
				},
			},
		});

		const program = compileSemanticFunctionsToProgram("test-func-prog", registry);
		expect(program.functions[0].name).toBe("dispatch_worker");

		// Simulate evaluation with only root function and required role answered
		const evalResult = createDecisionEvaluation({
			programId: program.id,
			programVersion: program.version,
			engineId: "test-engine",
			model: "test-model",
			confidenceProvenance: "native_calibrated",
			results: {
				__function__: {
					kind: "choice",
					selected: "dispatch_worker",
					distribution: { dispatch_worker: 1.0 },
					margin: 1.0,
					confidence: { value: 0.95, provenance: "native_calibrated", isCalibrated: true },
				},
				dispatch_worker__role: {
					kind: "choice",
					selected: "verifier",
					distribution: { verifier: 0.9 },
					margin: 0.8,
					confidence: { value: 0.9, provenance: "native_calibrated", isCalibrated: true },
				},
			},
		});

		const call = resolveFunctionCall(evalResult, registry);
		expect(call).toBeDefined();
		expect(call?.name).toBe("dispatch_worker");
		expect(call?.arguments.role).toBe("verifier");
		expect(call?.arguments.context).toBe("fresh"); // default applied
		expect(call?.arguments.independent).toBe(false); // default applied
		expect(call?.confidence.value).toBe(0.9); // weakest link between 0.95 and 0.9
	});
});

describe("Decision Engine Router & Portability", () => {
	it("ADR-030 & ADR-031: capability negotiation selects compatible engine", () => {
		const mech = new MechanicalDecisionEngine();
		const structured = new StructuredLlmDecisionEngine("test-llm");
		const router = new DecisionEngineRouter([mech, structured]);

		const program = createDecisionProgram({
			id: "prog",
			decisions: [{ kind: "boolean", id: "b1", instruction: "test" }],
		});

		expect(supportsProgram(mech.capabilities(), program)).toBe(true);
		expect(supportsProgram(structured.capabilities(), program)).toBe(true);

		const selected = router.select(program, "medium");
		expect(selected).toBeDefined();
	});

	it("ADR-032: structured LLM fallback marks synthetic self-report confidence", async () => {
		const structured = new StructuredLlmDecisionEngine("mock-llm");
		const program = createDecisionProgram({
			id: "test-llm-prog",
			decisions: [
				{
					kind: "choice",
					id: "task_kind",
					instruction: "Select kind",
					options: { bug_fix: { description: "Bug fix" } },
				},
			],
		});

		const result = await structured.evaluate(program, {});
		expect(result.engine.confidence_provenance).toBe("synthetic_self_report");
		expect(result.results.task_kind.confidence.provenance).toBe("synthetic_self_report");
		expect(result.results.task_kind.confidence.isCalibrated).toBe(false);
	});

	it("ADR-001 & ADR-002 & ADR-033: MechanicalDecisionEngine works with no credentials", async () => {
		const mech = new MechanicalDecisionEngine();
		expect(mech.capabilities().confidenceProvenance).toBe("none");

		const program = createDecisionProgram({
			id: "mech-prog",
			decisions: [
				{
					kind: "choice",
					id: "__function__",
					instruction: "Select function",
					options: {
						dispatch_worker: { description: "Dispatch" },
						completion_candidate: { description: "Complete" },
					},
				},
				{
					kind: "boolean",
					id: "work_remaining",
					instruction: "Remaining work?",
				},
			],
		});

		const evaluation = await mech.evaluate(program, {
			acceptance: [{ id: "ac1", required: true, satisfied: true }],
		});

		expect(evaluation.engine.id).toBe("mechanical");
		expect(evaluation.engine.confidence_provenance).toBe("none");
		expect(evaluation.results.__function__.kind).toBe("choice");
		expect((evaluation.results.__function__ as any).selected).toBe("completion_candidate");
	});

	it("ADR-012 & ADR-014: TypeSafeSystemOneDecisionEngine preserves native calibrated confidence", async () => {
		const mockAdapter = {
			evaluate: async (_input: any) => ({
				model: "jev-1.13.0",
				answers: {
					q1: { value: true, probability: 0.94, confidence: 0.94 },
					q2: {
						choice: "feature",
						distribution: { feature: 0.92, bug_fix: 0.08 },
						margin: 0.84,
						confidence: 0.92,
					},
				},
				latency_ms: 120,
			}),
		};

		const engine = new TypeSafeSystemOneDecisionEngine(mockAdapter as any, "jev-1.13.0");
		expect(engine.capabilities().confidenceProvenance).toBe("native_calibrated");

		const program = createDecisionProgram({
			id: "ts-prog",
			decisions: [
				{ kind: "boolean", id: "q1", instruction: "Check" },
				{
					kind: "choice",
					id: "q2",
					instruction: "Select",
					options: { feature: { description: "Feature" }, bug_fix: { description: "Bug fix" } },
				},
			],
		});

		const evaluation = await engine.evaluate(program, { test: "state" });
		expect(evaluation.engine.confidence_provenance).toBe("native_calibrated");
		expect(evaluation.results.q1.confidence.isCalibrated).toBe(true);
		expect(evaluation.results.q1.confidence.value).toBe(0.94);
		expect((evaluation.results.q1 as any).probabilityTrue).toBe(0.94);
		expect((evaluation.results.q2 as any).distribution.feature).toBe(0.92);
	});
});

describe("Authority Envelope & Human Edge", () => {
	it("ADR-040 & ADR-041: in-envelope actions are allowed without asking", () => {
		const env = createDefaultAuthorityEnvelope("/repo");
		const action = { kind: "edit_source", targetPath: "/repo/src/core/main.ts" };

		const validation = validateProposedAction(action, env);
		expect(validation.allowed).toBe(true);

		const edge = requiresHumanEdge("obj-1", action, env);
		expect(edge).toBeUndefined();
	});

	it("ADR-042 & ADR-043: out-of-envelope action creates structured HumanEdgeRequest", () => {
		const env = createDefaultAuthorityEnvelope("/repo");
		const deniedAction = { kind: "push_remote", pushRequested: true };

		const validation = validateProposedAction(deniedAction, env);
		expect(validation.allowed).toBe(false);

		const edge = requiresHumanEdge("obj-1", deniedAction, env);
		expect(edge).toBeDefined();
		expect(edge?.schema_version).toBe("2.0");
		expect(edge?.edge_type).toBe("irreversible_external");
		expect(edge?.request).toBe("external:push");
		expect(edge?.alternatives_exhausted.length).toBeGreaterThan(0);
	});
});
