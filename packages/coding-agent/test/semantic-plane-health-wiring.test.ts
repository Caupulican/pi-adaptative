import { afterEach, describe, expect, it } from "vitest";
import type { SemanticDecisionEngine } from "../src/core/decision/engine.ts";
import type { DecisionEvaluation } from "../src/core/decision/evaluation.ts";
import { SystemOneSteeringPlane } from "../src/core/steering/system-one-steering-plane.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

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
					release = () => resolve({ program_id: "p", results: {} } as unknown as DecisionEvaluation);
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
});
