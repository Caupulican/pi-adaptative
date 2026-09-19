import { describe, expect, it } from "vitest";
import {
	compileExecutionCharter,
	DEFAULT_STEERING_POLICY,
	ObjectiveExecutionController,
	SystemOneSteeringPlane,
} from "../../../src/core/index.ts";
import type { JevAdapter, JevEvaluationRequest, JevEvaluationResponse } from "../../../src/core/system-one/adapter.ts";

class TestJevAdapter implements JevAdapter {
	async evaluate(request: JevEvaluationRequest): Promise<JevEvaluationResponse> {
		return {
			model: request.model ?? "jev-1.13.0",
			latency_ms: 5,
			answers: {
				_confidence: 0.96,
				approved: true,
				work_remaining: false,
				completion_plausible: { noul: 0.95 },
				acceptance_satisfied: { noul: 0.98 },
				verification_passed: { noul: 0.98 },
				recommended_disposition: { choice: "unique" },
			},
		};
	}
}

describe("regression: system-one-steering-runtime-bundle", () => {
	it("executes completion under start_only mode with automated side effects and certificates", async () => {
		const adapter = new TestJevAdapter();
		const steeringPlane = new SystemOneSteeringPlane({
			adapter,
			policy: DEFAULT_STEERING_POLICY,
		});

		const executedSideEffects: string[] = [];
		const charter = compileExecutionCharter({
			objectiveId: "obj-bundle-test",
			prompt: "commit and push all changes and deploy to production",
		});

		const mockRuntimeProjection = {
			objectives: {
				"obj-bundle-test": {
					objective: { status: "active" },
				},
			},
			tasks: {},
			attempts: {},
		};

		const controller = new ObjectiveExecutionController({
			mode: "start_only",
			executionCharter: charter,
			steeringPlane,
			runtime: {
				reconcileObjective: async () => mockRuntimeProjection as any,
				getSourceRevision: () => "rev-bundle-1",
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
			decisions: {
				evaluateOrFallback: async () =>
					({
						results: {
							work_remaining: { kind: "boolean", value: false },
							missing_work_class: { kind: "choice", selected: "none" },
						},
						confidence: 0.95,
						directive: "completion_candidate",
					}) as any,
			} as any,
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

		expect(controller.getMode()).toBe("start_only");

		// Run execution loop
		const result = await controller.run("obj-bundle-test");

		expect(result).toBeDefined();
		expect(result.status).toBe("complete");
		expect(result.deliveryBundle).toBeDefined();
		expect(result.deliveryBundle?.terminal_status).toBe("complete");
		expect(result.deliveryBundle?.steering_certificate_refs?.length).toBeGreaterThan(0);

		// Side effects ran automatically according to charter
		expect(executedSideEffects).toContain("git:commit");
		expect(executedSideEffects).toContain("deploy:production");
	});
});
