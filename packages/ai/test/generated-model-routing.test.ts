import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/models.ts";

describe("generated model routing", () => {
	it("routes GitHub Copilot MAI-Code models through Responses", () => {
		expect(getModel("github-copilot", "mai-code-1-flash-picker").api).toBe("openai-responses");
	});

	it("routes GitHub Copilot Claude 5 models through Anthropic Messages", () => {
		expect(getModel("github-copilot", "claude-fable-5").api).toBe("anthropic-messages");
		expect(getModel("github-copilot", "claude-opus-5").api).toBe("anthropic-messages");
		expect(getModel("github-copilot", "claude-sonnet-5").api).toBe("anthropic-messages");
	});

	it("omits the unsupported session_id header for OpenCode Responses models", () => {
		expect(getModel("opencode", "gpt-5.4").compat?.sessionAffinityFormat).toBe("openai-nosession");
	});

	it("routes xAI Grok 4.5 through Responses with supported effort levels", () => {
		const model = getModel("xai", "grok-4.5");
		expect(model.api).toBe("openai-responses");
		expect(model.compat?.supportsLongCacheRetention).toBe(false);
		expect(model.thinkingLevelMap).toMatchObject({ off: null, minimal: null });
		expect(model.thinkingLevelMap).not.toHaveProperty("xhigh");
		expect(model.defaultThinkingLevel).toBe("high");
	});

	it("routes xAI Grok 4.6 through Responses with xhigh effort", () => {
		const model = getModel("xai", "grok-4.6");
		expect(model.api).toBe("openai-responses");
		expect(model.compat?.supportsLongCacheRetention).toBe(false);
		expect(model.thinkingLevelMap).toMatchObject({ off: null, minimal: null, xhigh: "xhigh" });
		expect(model.defaultThinkingLevel).toBe("high");
	});

	it("excludes retired native xAI models from the built-in catalog", () => {
		const ids = getModels("xai").map((model) => model.id);
		expect(ids.sort()).toEqual(["grok-4.5", "grok-4.6"]);
		for (const modelId of [
			"grok-3",
			"grok-3-fast",
			"grok-4.20-0309-non-reasoning",
			"grok-4.20-0309-reasoning",
			"grok-code-fast-1",
			"grok-4.3",
			"grok-build-0.1",
		]) {
			expect(ids).not.toContain(modelId);
		}
	});

	it("marks Kimi Coding's Anthropic-compatible endpoint as bearer authenticated", () => {
		expect(getModel("kimi-coding", "k3").compat?.authFormat).toBe("bearer");
	});
});
