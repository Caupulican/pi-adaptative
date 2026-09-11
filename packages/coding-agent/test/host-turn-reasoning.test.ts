import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ModelThinkingLevel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	HostTurnReasoningController,
	hostTurnCustomType,
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
			const controller = new HostTurnReasoningController(() => undefined);
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
