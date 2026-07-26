import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

const EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS = [
	"anthropic/claude-opus-4-8",
	"anthropic/claude-opus-5",
	"opencode/claude-opus-4-8",
	"vercel-ai-gateway/anthropic/claude-opus-4.8",
];

function getAllModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
}

describe("Anthropic adaptive thinking model metadata", () => {
	it("marks built-in Anthropic Messages models that use adaptive thinking", () => {
		const flaggedModels = getAllModels()
			.filter((model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages")
			.filter((model) => model.compat?.forceAdaptiveThinking === true)
			.map((model) => `${model.provider}/${model.id}`)
			.sort();

		expect(flaggedModels).toEqual(expect.arrayContaining([...EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS].sort()));
		expect(flaggedModels).toEqual(
			flaggedModels.filter((modelId) =>
				/(opus[-.](?:4[-.][678]|5)|sonnet[-.](?:4[-.]6|5)|fable[-.]5)/.test(modelId),
			),
		);
	});

	it("marks Anthropic Claude Opus 5 as adaptive and temperature-free", () => {
		const model = getModels("anthropic").find((candidate) => candidate.id === "claude-opus-5");

		expect(model?.compat).toMatchObject({ forceAdaptiveThinking: true, supportsTemperature: false });
	});
});
