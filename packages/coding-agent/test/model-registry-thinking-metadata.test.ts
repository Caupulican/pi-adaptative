import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	}
});

describe("ModelRegistry thinking metadata", () => {
	it("preserves defaults and Max/Ultra maps from models.json", () => {
		const tempDir = join(tmpdir(), `pi-model-thinking-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		mkdirSync(tempDir, { recursive: true });
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					custom: {
						api: "openai-responses",
						apiKey: "test-key",
						baseUrl: "https://custom.test/v1",
						models: [
							{
								id: "sol",
								name: "Custom Sol",
								reasoning: true,
								defaultThinkingLevel: "low",
								thinkingLevelMap: { max: "max", ultra: "max" },
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 32000,
							},
						],
					},
				},
			}),
		);
		const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsJsonPath);

		expect(registry.find("custom", "sol")).toMatchObject({
			defaultThinkingLevel: "low",
			thinkingLevelMap: { max: "max", ultra: "max" },
		});
	});

	it("preserves thinking metadata for dynamic models and model overrides", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("dynamic", {
			api: "openai-responses",
			apiKey: "test-key",
			baseUrl: "https://dynamic.test/v1",
			models: [
				{
					id: "terra",
					name: "Dynamic Terra",
					reasoning: true,
					defaultThinkingLevel: "medium",
					thinkingLevelMap: { max: "max", ultra: "max" },
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 32000,
				},
			],
		});
		registry.registerProvider("openai", {
			modelOverrides: {
				"gpt-5.6-sol": { defaultThinkingLevel: "ultra" },
			},
		});

		expect(registry.find("dynamic", "terra")).toMatchObject({
			defaultThinkingLevel: "medium",
			thinkingLevelMap: { max: "max", ultra: "max" },
		});
		expect(registry.find("openai", "gpt-5.6-sol")?.defaultThinkingLevel).toBe("ultra");
	});
});
