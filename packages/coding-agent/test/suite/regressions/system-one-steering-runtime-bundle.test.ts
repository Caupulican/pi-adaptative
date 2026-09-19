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
		const answers: Record<string, unknown> = {};
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
						answers[id] = { type: "noul", noul: 0.05 };
					} else {
						answers[id] = { type: "noul", noul: 0.96 };
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
					answers[id] = {
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
					answers[id] = {
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
			answers,
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
