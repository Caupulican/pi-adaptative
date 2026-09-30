import { copyFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SemanticDecisionEngine } from "../src/core/decision/engine.ts";
import { createDecisionEvaluation, type DecisionEvaluation } from "../src/core/decision/evaluation.ts";
import { noulBand } from "../src/core/decision/noul.ts";
import { compileDecisionProgramForCheckpoint } from "../src/core/steering/programs.ts";
import { SystemOneSteeringPlane } from "../src/core/steering/system-one-steering-plane.ts";
import { WORKER_SUPERVISION_DECISION_IDS } from "../src/core/supervision/worker-semantic-supervisor.ts";
import { semanticWorkerTaskScope } from "../src/core/system-one/semantic-evaluation-ledger.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { tempDir } from "./temp-dir.ts";

function supervisionEvaluation(uncertainDecision?: string): DecisionEvaluation {
	const results = Object.fromEntries(
		WORKER_SUPERVISION_DECISION_IDS.map((id) => {
			const progressing = id === "meaningful_progress";
			const probabilityTrue = id === uncertainDecision ? 0.5 : progressing ? 0.9 : 0.1;
			return [
				id,
				{
					kind: "boolean" as const,
					probabilityTrue,
					direction: "required_true" as const,
					band: noulBand(probabilityTrue, "required_true"),
					confidence: {
						value: 0.9,
						provenance: "native_calibrated" as const,
						isCalibrated: true,
						noulProbabilityTrue: probabilityTrue,
					},
				},
			];
		}),
	);
	return createDecisionEvaluation({
		programId: "pi:steering:program:JEV-WORKER-SUPERVISION:1.0",
		programVersion: "1.0.0",
		engineId: "faux-plane",
		model: "faux/jev",
		confidenceProvenance: "native_calibrated",
		results,
	});
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

let harness: Harness | undefined;

afterEach(async () => {
	await harness?.cleanup();
	harness = undefined;
});

/** A plane engine whose evaluation stays in flight until the test releases it. */
function deferredEngine(): {
	engine: SemanticDecisionEngine;
	calls: number;
	release: () => void;
	fail: (error: Error) => void;
} {
	let release: (() => void) | undefined;
	let fail: ((error: Error) => void) | undefined;
	const state = {
		engine: {
			id: "faux-plane",
			model: "faux/jev",
			capabilities: () => ({
				boolean: true,
				choice: true,
				score: true,
				set: true,
				fullDistributions: false,
				parallelIndependentDecisions: true,
				confidenceProvenance: "native_calibrated" as const,
			}),
			evaluate: (): Promise<DecisionEvaluation> => {
				state.calls += 1;
				return new Promise<DecisionEvaluation>((resolve, reject) => {
					release = () => resolve(supervisionEvaluation());
					fail = reject;
				});
			},
		} satisfies SemanticDecisionEngine,
		calls: 0,
		release: () => release?.(),
		fail: (error: Error) => fail?.(error),
	};
	return state;
}

describe("Semantic plane health wiring", () => {
	it.each([false, true])("tracks every question beyond bounded previews with long IDs=%s", async (longIds) => {
		harness = await createHarness();
		const questions = Array.from(
			{ length: 8 },
			(_, index) => `${longIds ? "shared-prefix-".repeat(12) : "question-"}${index}`,
		);
		const plane = deferredEngine();
		let uncertain = true;
		plane.engine.evaluate = async () => {
			const base = supervisionEvaluation().results.meaningful_progress;
			if (base.kind !== "boolean") throw new Error("Expected a boolean fixture");
			const probabilityTrue = uncertain ? 0.5 : 0.99;
			return createDecisionEvaluation({
				programId: "complete-question-state",
				programVersion: "1.0.0",
				engineId: plane.engine.id,
				model: plane.engine.model,
				confidenceProvenance: "native_calibrated",
				results: Object.fromEntries(
					questions.map((question) => [
						question,
						{
							...base,
							probabilityTrue,
							band: noulBand(probabilityTrue, "required_true"),
						},
					]),
				),
			});
		};
		harness.session.attachAdaptiveRuntime({
			steeringPlane: new SystemOneSteeringPlane({ decisionEngine: plane.engine }),
		});
		const recorder = harness.session as unknown as {
			_recordingSemanticEngine(): SemanticDecisionEngine | undefined;
		};
		const engine = recorder._recordingSemanticEngine();
		if (!engine) throw new Error("Expected the recorded test engine");
		const program = compileDecisionProgramForCheckpoint("JEV-WORKER-SUPERVISION", {});
		await engine.evaluate(program, {});
		expect(
			harness.session
				.getSemanticUncertainties()
				.listOwnSession()
				.map((doubt) => doubt.question),
		).toEqual(questions);
		expect(harness.session.getSemanticEvaluations()[0].reasons?.length).toBeLessThanOrEqual(6);
		uncertain = false;
		await engine.evaluate(program, {});
		expect(harness.session.getSemanticUncertainties().listOwnSession()).toEqual([]);
		expect(harness.session.getDecisionLedger()?.semanticEvaluations(harness.session.sessionId).at(-1)).toMatchObject({
			questionStates: questions.map((question) => ({ question, uncertain: false })),
		});
	});

	it("FC-058: worker supervision runs through the recording engine, so the plane reports eval then ok", async () => {
		harness = await createHarness();
		const plane = deferredEngine();
		harness.session.attachAdaptiveRuntime({
			steeringPlane: new SystemOneSteeringPlane({ decisionEngine: plane.engine }),
		});
		expect(harness.session.getSemanticPlaneHealth().state).toBe("unknown");

		const observed = harness.session.workerSupervision.observe({
			agentId: "agent-1",
			objectiveId: "obj-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			role: "worker",
			mission: "Implement the control projection",
			toolCalls: 40,
			elapsedMs: 600_000,
			recentToolNames: ["edit", "read"],
		});
		await Promise.resolve();
		expect(plane.calls).toBe(1);
		expect(harness.session.getSemanticPlaneHealth().state).toBe("evaluating");

		plane.release();
		await observed;
		expect(harness.session.getSemanticPlaneHealth().state).toBe("ok");
	});

	it("FC-058: the project-rules controller receives the same recording engine instance", async () => {
		harness = await createHarness();
		const plane = deferredEngine();
		harness.session.attachAdaptiveRuntime({
			steeringPlane: new SystemOneSteeringPlane({ decisionEngine: plane.engine }),
		});

		// Every in-session consumer resolves the engine through the one recording accessor, so each
		// resolution is the same wrapper object and none of them is the raw plane engine.
		const session = harness.session as unknown as { _recordingSemanticEngine(): SemanticDecisionEngine | undefined };
		const first = session._recordingSemanticEngine();
		const second = session._recordingSemanticEngine();
		expect(first).toBeDefined();
		expect(first).toBe(second);
		expect(first).not.toBe(plane.engine);
		expect(first?.id).toBe(plane.engine.id);
	});

	it("persists provider scope and restores the same worker doubt for the reopened session", async () => {
		const agentDir = tempDir("pi-semantic-health-reopen-");
		harness = await createHarness({ agentDir, persistSession: true });
		const sessionId = harness.session.sessionId;
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "semantic scope persistence" }],
			api: "messages",
			provider: "anthropic",
			model: "faux/jev",
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		} satisfies AssistantMessage);
		const sessionFile = harness.session.sessionFile;
		if (!sessionFile) throw new Error("Persistent harness did not create a session file");
		const plane = {
			...deferredEngine(),
		};
		plane.engine.evaluate = async () => supervisionEvaluation("worker_stuck");
		harness.session.attachAdaptiveRuntime({
			steeringPlane: new SystemOneSteeringPlane({ decisionEngine: plane.engine }),
		});

		const recorder = harness.session as unknown as {
			_recordingSemanticEngine(): SemanticDecisionEngine | undefined;
		};
		const engine = recorder._recordingSemanticEngine();
		expect(engine).toBeDefined();
		const taskScope = semanticWorkerTaskScope("objective:durable", "task:worker");
		await engine!.evaluate(
			compileDecisionProgramForCheckpoint("JEV-WORKER-SUPERVISION", {}),
			{},
			{ evaluationScope: taskScope },
		);

		const stored = harness.session.getDecisionLedger()?.semanticEvaluations(sessionId);
		expect(stored).toHaveLength(1);
		expect(stored?.[0]).toMatchObject({
			evaluationScope: taskScope,
			questionNamespace: "pi:steering:program:JEV-WORKER-SUPERVISION:1.0",
			outcome: "ok",
		});
		expect(harness.session.getSemanticPlaneHealth().unresolvedDoubts).toMatchObject([
			{ question: "worker_stuck", evaluationScope: taskScope },
		]);

		const reopenedSessionFile = join(agentDir, "reopened-session.jsonl");
		copyFileSync(sessionFile, reopenedSessionFile);
		await harness.cleanup();
		harness = undefined;
		harness = await createHarness({ agentDir, sessionFile: reopenedSessionFile });
		harness.session.attachAdaptiveRuntime({
			steeringPlane: new SystemOneSteeringPlane({ decisionEngine: plane.engine }),
		});
		expect(harness.session.sessionId).toBe(sessionId);
		expect(harness.session.getSemanticPlaneHealth().unresolvedDoubts).toMatchObject([
			{ question: "worker_stuck", evaluationScope: taskScope },
		]);
	});

	it("resolves a root-session uncertainty through the session port and replays its advisory decision", async () => {
		const agentDir = tempDir("pi-semantic-uncertainty-resolution-");
		harness = await createHarness({ agentDir, persistSession: true });
		const sessionId = harness.session.sessionId;
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "semantic uncertainty decision" }],
			api: "messages",
			provider: "anthropic",
			model: "faux/jev",
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		} satisfies AssistantMessage);
		const sessionFile = harness.session.sessionFile;
		if (!sessionFile) throw new Error("Persistent harness did not create a session file");
		const plane = deferredEngine();
		plane.engine.evaluate = async () => supervisionEvaluation("worker_stuck");
		harness.session.attachAdaptiveRuntime({
			steeringPlane: new SystemOneSteeringPlane({ decisionEngine: plane.engine }),
		});

		const recorder = harness.session as unknown as {
			_recordingSemanticEngine(): SemanticDecisionEngine | undefined;
		};
		const engine = recorder._recordingSemanticEngine();
		if (!engine) throw new Error("The test steering plane was not recorded");
		await engine.evaluate(compileDecisionProgramForCheckpoint("JEV-WORKER-SUPERVISION", {}), {});

		let port = harness.session.getSemanticUncertainties();
		const [doubt] = port.listOwnSession();
		expect(doubt).toMatchObject({
			question: "worker_stuck",
			evaluationScope: { kind: "session", id: sessionId },
		});
		if (!doubt) throw new Error("Expected an active root-session semantic doubt");
		const decision = {
			evaluationId: doubt.evaluationId,
			question: doubt.question,
			disposition: "evidence_based_decision" as const,
			reason: "The operator chose the documented conservative route.",
			evidence: "The bounded worker trace shows the current task remains active.",
		};
		expect(port.resolveOwnSession(decision)).toEqual({ resolved: true });
		expect(port.listOwnSession()).toEqual([]);
		expect(harness.session.getSemanticEvaluations()).toHaveLength(1);
		expect(harness.session.getDecisionLedger()?.semanticDoubtDecisions(sessionId)).toHaveLength(1);

		const reopenedSessionFile = join(agentDir, "resolved-session.jsonl");
		copyFileSync(sessionFile, reopenedSessionFile);
		await harness.cleanup();
		harness = undefined;
		harness = await createHarness({ agentDir, sessionFile: reopenedSessionFile });
		port = harness.session.getSemanticUncertainties();
		expect(harness.session.sessionId).toBe(sessionId);
		expect(port.listOwnSession()).toEqual([]);
		const restoredEvaluations = harness.session.getDecisionLedger()?.semanticEvaluations(sessionId);
		expect(restoredEvaluations).toHaveLength(1);
		expect(restoredEvaluations?.[0]).toMatchObject({
			outcome: "ok",
			reasons: expect.arrayContaining([expect.stringContaining("unsure: worker_stuck")]),
		});
		expect(harness.session.getDecisionLedger()?.semanticDoubtDecisions(sessionId)).toMatchObject([decision]);
	});
});
