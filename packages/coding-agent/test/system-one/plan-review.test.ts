import { describe, expect, it } from "vitest";
import { createRetentionDecisionEngine } from "../../src/core/compaction/retention-decision-engine.ts";
import type { SemanticDecisionEngine } from "../../src/core/decision/engine.ts";
import type { OperationEffectEngine } from "../../src/core/system-one/operation-classifier.ts";
import { changesPlan, PLAN_REVIEW_PROGRAM, reviewPlan } from "../../src/core/system-one/plan-review.ts";
import { ToolGateController } from "../../src/core/tool-gate-controller.ts";

function engine(answers: Record<string, number>): OperationEffectEngine {
	return {
		evaluate: async () => ({
			answers: Object.fromEntries(Object.entries(answers).map(([id, noul]) => [id, { noul }])),
		}),
	};
}

const steps = ["Reproduce the flaky login test", "Fix the race", "Run the login tests"];
const SOUND = { misses_request_part: 0.18, needs_later_step: 0.14, checks_result: 0.97 };

describe("plan review", () => {
	it("reviews a plan only when it is published or changed", () => {
		for (const action of ["set", "intake", "add"]) expect(changesPlan("task_steps", { action }), action).toBe(true);
		for (const action of ["update", "list", "advance", "clear"])
			expect(changesPlan("task_steps", { action })).toBe(false);
		expect(changesPlan("bash", { action: "set" })).toBe(false);
	});

	it("says nothing about a sound plan", async () => {
		expect(await reviewPlan(engine(SOUND), { request: "Fix the flaky login test.", steps })).toEqual({});
	});

	it("steers the model on a decisive defect and shows a likely one as a doubt", async () => {
		expect(
			await reviewPlan(engine({ ...SOUND, misses_request_part: 0.92, checks_result: 0.04 }), {
				request: "r",
				steps,
			}),
		).toEqual({
			steer: "System One checked the plan: the plan does not cover everything the request asks for; add the missing steps; no step checks the result; add one that runs the tests, the build or the program.",
		});
		expect(await reviewPlan(engine({ ...SOUND, needs_later_step: 0.62 }), { request: "r", steps })).toEqual({
			doubt: "System One doubts whether the plan's order works",
		});
	});

	it("never blocks: a failing System One is a doubt, and no System One is silence", async () => {
		const failing: OperationEffectEngine = {
			evaluate: async () => {
				throw new Error("engine down");
			},
		};
		expect(await reviewPlan(failing, { request: "r", steps })).toEqual({
			doubt: "System One could not check the plan (engine down)",
		});
		expect(await reviewPlan(undefined, { request: "r", steps })).toEqual({});
	});

	it("reaches the engine with each question's criteria", async () => {
		let sent: unknown;
		const semantic = {
			evaluate: async (program: unknown) => {
				sent = program;
				return { results: {} };
			},
		} as unknown as SemanticDecisionEngine;
		await createRetentionDecisionEngine(semantic).evaluate(PLAN_REVIEW_PROGRAM, {}, {});
		const decisions = (sent as { decisions: { id: string; criteria?: unknown }[] }).decisions;
		expect(decisions.find((decision) => decision.id === "misses_request_part")?.criteria).toEqual(
			PLAN_REVIEW_PROGRAM.decisions[0].criteria,
		);
	});
});

describe("plan review on the tool path", () => {
	it("appends System One's steer to the task_steps result that published the plan", async () => {
		const seen: unknown[] = [];
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => "/tmp/pi-plan-review",
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => {},
			getExtensionRunner: () => ({ hasHandlers: () => false }) as never,
			reviewPlan: async (input) => {
				seen.push(input);
				return "System One checked the plan: no step checks the result.";
			},
		});
		const result = await gate.afterToolCall({
			assistantMessage: { role: "assistant", content: [], stopReason: "toolUse", timestamp: 0 } as never,
			toolCall: { type: "toolCall", id: "t1", name: "task_steps", arguments: {} },
			args: { action: "set", steps: [{ content: "Refactor the parser" }] },
			result: { content: [{ type: "text", text: "Plan set." }], details: undefined },
			isError: false,
			context: { systemPrompt: "", messages: [], tools: [] },
		});
		expect(seen).toEqual([
			{ toolName: "task_steps", args: { action: "set", steps: [{ content: "Refactor the parser" }] } },
		]);
		expect(result?.content?.at(-1)).toEqual({
			type: "text",
			text: "System One checked the plan: no step checks the result.",
		});
	});
});
