import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ModelThinkingLevel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	bookkeepingContinuationTools,
	HostTurnReasoningController,
	hostTurnCustomType,
	resolveBookkeepingRequestReasoning,
	resolveHostTurnRequestReasoning,
	resolveHostTurnThinkingLevel,
} from "../src/core/host-turn-reasoning.ts";

/**
 * A turn the host starts after a background tool or worker finishes is bookkeeping: read the
 * delivered result, cite it, continue. It used to run at the operator's full session thinking level.
 * These pin the arithmetic (one rung down, floored, never upward) and the recognition rule.
 */

const ALL_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function completion(customType: string): AgentMessage {
	return { role: "custom", customType, content: "done", timestamp: 0 } as AgentMessage;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}

function assistantCalls(...names: string[]): AgentMessage {
	return {
		role: "assistant",
		content: names.map((name, index) => ({ type: "toolCall", id: `call-${index}`, name, arguments: {} })),
		timestamp: 0,
	} as AgentMessage;
}

function toolResult(toolName: string, index = 0): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${index}`,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	} as AgentMessage;
}

/** A request answering only bookkeeping results: the assistant called the named tools, all answered. */
function bookkeepingRequest(...names: string[]): AgentMessage[] {
	return [userMessage("go"), assistantCalls(...names), ...names.map((name, index) => toolResult(name, index))];
}

describe("host-turn reasoning", () => {
	describe("recognition", () => {
		it("recognizes only the two host-delivered completions, and only in last position", () => {
			expect(hostTurnCustomType([completion("background-tool-completion")])).toBe("background-tool-completion");
			expect(hostTurnCustomType([completion("background-worker-completion")])).toBe("background-worker-completion");
			expect(hostTurnCustomType([completion("tool-failure-ledger")])).toBeUndefined();
			expect(
				hostTurnCustomType([completion("background-tool-completion"), userMessage("now do X")]),
			).toBeUndefined();
			expect(hostTurnCustomType([])).toBeUndefined();
			expect(hostTurnCustomType([userMessage("ordinary turn")])).toBeUndefined();
		});
	});

	describe("default policy (setting unset)", () => {
		it("drops exactly one rung and never below the low floor", () => {
			const at = (level: ModelThinkingLevel) => resolveHostTurnThinkingLevel(level, undefined, ALL_LEVELS);
			expect(at("ultra")).toBe("max");
			expect(at("max")).toBe("xhigh");
			expect(at("xhigh")).toBe("high");
			expect(at("high")).toBe("medium");
			expect(at("medium")).toBe("low");
			expect(at("low")).toBe("low");
		});

		it("never raises a session that already sits below the floor", () => {
			expect(resolveHostTurnThinkingLevel("minimal", undefined, ALL_LEVELS)).toBe("minimal");
			expect(resolveHostTurnThinkingLevel("off", undefined, ALL_LEVELS)).toBe("off");
		});

		it("skips a rung the model does not offer instead of asking for one it would remap", () => {
			// A model with only off/low/high: one rung below "high" is "low", not the absent "medium".
			expect(resolveHostTurnThinkingLevel("high", undefined, ["off", "low", "high"])).toBe("low");
		});

		it("skips a rung that maps to the same provider effort, so the drop is a real reduction", () => {
			const effortMap = { high: "high", medium: "high", low: "low" } as const;
			expect(resolveHostTurnThinkingLevel("high", undefined, ["off", "low", "medium", "high"], effortMap)).toBe(
				"low",
			);
		});
	});

	describe("explicit settings", () => {
		it("inherit leaves the session level exactly as it is", () => {
			expect(resolveHostTurnThinkingLevel("ultra", "inherit", ALL_LEVELS)).toBe("ultra");
			expect(resolveHostTurnThinkingLevel("low", "inherit", ALL_LEVELS)).toBe("low");
		});

		it("takes an explicit level as written when it is at or below the session level", () => {
			expect(resolveHostTurnThinkingLevel("high", "minimal", ALL_LEVELS)).toBe("minimal");
			expect(resolveHostTurnThinkingLevel("high", "off", ALL_LEVELS)).toBe("off");
		});

		it("clamps an explicit level that would raise effort above the session level", () => {
			expect(resolveHostTurnThinkingLevel("low", "ultra", ALL_LEVELS)).toBe("low");
			expect(resolveHostTurnThinkingLevel("medium", "high", ALL_LEVELS)).toBe("medium");
		});
	});

	describe("request resolution", () => {
		it("declines every request that is not answering a host completion", () => {
			expect(
				resolveHostTurnRequestReasoning({
					sourceMessages: [userMessage("ordinary")],
					sessionLevel: "high",
					setting: undefined,
				}),
			).toBeUndefined();
			expect(
				resolveHostTurnRequestReasoning({
					sourceMessages: [completion("some-other-transient")],
					sessionLevel: "high",
					setting: undefined,
				}),
			).toBeUndefined();
		});

		it("declines when there is no session reasoning to lower", () => {
			expect(
				resolveHostTurnRequestReasoning({
					sourceMessages: [completion("background-tool-completion")],
					sessionLevel: undefined,
					setting: undefined,
				}),
			).toBeUndefined();
		});

		it("reports what it lowered and what it left alone", () => {
			expect(
				resolveHostTurnRequestReasoning({
					sourceMessages: [completion("background-worker-completion")],
					sessionLevel: "xhigh",
					setting: undefined,
					supportedLevels: ALL_LEVELS,
				}),
			).toEqual({
				kind: "host-turn",
				customType: "background-worker-completion",
				sessionLevel: "xhigh",
				resolvedLevel: "high",
				lowered: true,
			});
			expect(
				resolveHostTurnRequestReasoning({
					sourceMessages: [completion("background-tool-completion")],
					sessionLevel: "low",
					setting: undefined,
					supportedLevels: ALL_LEVELS,
				})?.lowered,
			).toBe(false);
		});
	});

	describe("bookkeeping continuation recognition", () => {
		it("matches a request that answers only goal or task_steps results", () => {
			expect(bookkeepingContinuationTools(bookkeepingRequest("task_steps"))).toEqual(["task_steps"]);
			expect(bookkeepingContinuationTools(bookkeepingRequest("goal", "task_steps"))).toEqual(["goal", "task_steps"]);
			expect(bookkeepingContinuationTools(bookkeepingRequest("update_goal"))).toEqual(["update_goal"]);
		});

		it("declines real work, mixed messages, and requests that do not end in tool results", () => {
			expect(bookkeepingContinuationTools(bookkeepingRequest("bash"))).toBeUndefined();
			// A task_steps update emitted together with an edit is real work.
			expect(bookkeepingContinuationTools(bookkeepingRequest("task_steps", "edit"))).toBeUndefined();
			expect(bookkeepingContinuationTools([userMessage("ordinary")])).toBeUndefined();
			expect(bookkeepingContinuationTools([userMessage("go"), assistantCalls("task_steps")])).toBeUndefined();
			// The memory tool is not bookkeeping for this policy (its writes carry the model's own reasoning).
			expect(bookkeepingContinuationTools(bookkeepingRequest("memory"))).toBeUndefined();
		});
	});

	describe("bookkeeping continuation resolution", () => {
		it("resolves to low by default, clamped to the session level, and counts as lowered only when it is", () => {
			const base = {
				sourceMessages: bookkeepingRequest("task_steps"),
				setting: undefined,
				supportedLevels: ALL_LEVELS,
			};
			expect(resolveBookkeepingRequestReasoning({ ...base, sessionLevel: "xhigh" })).toMatchObject({
				kind: "bookkeeping",
				resolvedLevel: "low",
				lowered: true,
			});
			expect(resolveBookkeepingRequestReasoning({ ...base, sessionLevel: "low" })).toMatchObject({
				resolvedLevel: "low",
				lowered: false,
			});
			expect(resolveBookkeepingRequestReasoning({ ...base, sessionLevel: "minimal" })).toMatchObject({
				resolvedLevel: "minimal",
				lowered: false,
			});
		});

		it("inherits the session level when asked, and clamps an explicit level to the session level", () => {
			const base = { sourceMessages: bookkeepingRequest("goal"), supportedLevels: ALL_LEVELS };
			expect(
				resolveBookkeepingRequestReasoning({ ...base, sessionLevel: "high", setting: "inherit" }),
			).toMatchObject({ resolvedLevel: "high", lowered: false });
			expect(resolveBookkeepingRequestReasoning({ ...base, sessionLevel: "high", setting: "medium" })).toMatchObject(
				{ resolvedLevel: "medium", lowered: true },
			);
			expect(resolveBookkeepingRequestReasoning({ ...base, sessionLevel: "low", setting: "high" })).toMatchObject({
				resolvedLevel: "low",
				lowered: false,
			});
		});

		it("declines a request that is not a bookkeeping continuation", () => {
			expect(
				resolveBookkeepingRequestReasoning({
					sourceMessages: bookkeepingRequest("bash"),
					sessionLevel: "high",
					setting: undefined,
				}),
			).toBeUndefined();
		});
	});

	describe("controller", () => {
		const reasoningModel = {
			api: "faux",
			provider: "faux",
			id: "model",
			reasoning: true,
			contextWindow: 100_000,
			maxTokens: 4_096,
		} as unknown as Parameters<HostTurnReasoningController["resolveRequestReasoning"]>[0];

		it("counts the lowered requests and retains the latest decision", () => {
			const controller = new HostTurnReasoningController(() => ({ hostTurn: undefined, bookkeeping: undefined }));
			expect(controller.getLastDecision()).toBeUndefined();
			expect(controller.getLoweredRequestCount()).toBe(0);

			expect(controller.resolveRequestReasoning(reasoningModel, [userMessage("ordinary")], "high")).toBe("high");
			expect(controller.getLastDecision()).toBeUndefined();

			const host = [completion("background-tool-completion")];
			expect(controller.resolveRequestReasoning(reasoningModel, host, "high")).toBe("medium");
			expect(controller.resolveRequestReasoning(reasoningModel, host, "high")).toBe("medium");
			expect(controller.getLoweredRequestCount()).toBe(2);
			expect(controller.getLastDecision()?.customType).toBe("background-tool-completion");

			// An ordinary request afterwards changes neither the count nor the retained decision.
			expect(controller.resolveRequestReasoning(reasoningModel, [userMessage("next")], "high")).toBe("high");
			expect(controller.getLoweredRequestCount()).toBe(2);
			expect(controller.getLastDecision()?.resolvedLevel).toBe("medium");

			// A bookkeeping continuation is the second rule: low by default, counted the same way.
			expect(controller.resolveRequestReasoning(reasoningModel, bookkeepingRequest("task_steps"), "high")).toBe(
				"low",
			);
			expect(controller.getLoweredRequestCount()).toBe(3);
			expect(controller.getLastDecision()).toMatchObject({ kind: "bookkeeping", tools: ["task_steps"] });
		});

		it("passes the request through unchanged when the policy itself fails", () => {
			const controller = new HostTurnReasoningController(() => {
				throw new Error("settings unavailable");
			});
			expect(
				controller.resolveRequestReasoning(reasoningModel, [completion("background-tool-completion")], "high"),
			).toBe("high");
			expect(controller.getLoweredRequestCount()).toBe(0);
		});
	});
});
