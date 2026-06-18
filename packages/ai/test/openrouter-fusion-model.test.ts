import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";

describe("OpenRouter Fusion model alias", () => {
	it("exposes the synthetic OpenRouter Fusion alias", () => {
		const model = getModel("openrouter", "openrouter/fusion");

		expect(model.id).toBe("openrouter/fusion");
		expect(model.name).toBe("OpenRouter: Fusion");
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("openrouter");
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(30000);
	});
});
