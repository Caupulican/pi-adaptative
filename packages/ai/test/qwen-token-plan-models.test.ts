import { afterEach, describe, expect, it, vi } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import { getModels } from "../src/models.ts";

const TEXT_MODELS = [
	"MiniMax-M2.5",
	"deepseek-v3.2",
	"deepseek-v4-flash",
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"glm-5",
	"glm-5.1",
	"glm-5.2",
	"kimi-k2.5",
	"kimi-k2.6",
	"kimi-k2.7-code",
	"qwen3.6-flash",
	"qwen3.6-plus",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-max",
	"qwen3.8-max-preview",
] as const;

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Qwen Token Plan", () => {
	it.each([
		["qwen-token-plan", "QWEN_TOKEN_PLAN_API_KEY"],
		["qwen-token-plan-cn", "QWEN_TOKEN_PLAN_CN_API_KEY"],
	] as const)("exposes the bounded text catalog and environment auth for %s", (provider, envName) => {
		vi.stubEnv(envName, "token-plan-key");
		const models = getModels(provider);

		expect(models.map((model) => model.id)).toEqual(expect.arrayContaining([...TEXT_MODELS]));
		expect(models).toHaveLength(TEXT_MODELS.length);
		expect(models.every((model) => model.compat?.thinkingFormat === "qwen")).toBe(true);
		expect(getEnvApiKey(provider)).toBe("token-plan-key");
	});
});
