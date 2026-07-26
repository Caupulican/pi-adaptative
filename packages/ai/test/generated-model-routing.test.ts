import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";

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
	});

	it("marks Kimi Coding's Anthropic-compatible endpoint as bearer authenticated", () => {
		expect(getModel("kimi-coding", "k3").compat?.authFormat).toBe("bearer");
	});
});
