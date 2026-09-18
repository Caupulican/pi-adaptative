import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

describe("Antigravity registry ownership", () => {
	it("loads subscription-discovered models without Claude credentials or a generated catalog", () => {
		const auth = AuthStorage.inMemory({
			"google-antigravity": {
				type: "oauth",
				access: "fixture",
				refresh: "fixture-refresh",
				expires: Date.now() + 3600000,
				projectId: "fixture-project",
				modelCatalog: {
					"gemini-fixture": { displayName: "Fixture Gemini", maxTokens: 10000, maxOutputTokens: 1000 },
				},
			},
		});
		const registry = ModelRegistry.inMemory(auth);
		expect(registry.find("google-antigravity", "gemini-fixture")?.api).toBe("google-antigravity");
		expect(registry.getAvailable().some((model) => model.provider === "google-antigravity")).toBe(true);
		expect(auth.get("anthropic")).toBeUndefined();
		registry.refresh();
		expect(registry.getAll().filter((model) => model.provider === "google-antigravity")).toHaveLength(1);
	});
	it("does not advertise account models before AGY login", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		expect(registry.getAll().filter((model) => model.provider === "google-antigravity")).toEqual([]);
	});
	it("registers advertised Claude and GPT models under google-antigravity provider", () => {
		const auth = AuthStorage.inMemory({
			"google-antigravity": {
				type: "oauth",
				access: "fixture",
				refresh: "fixture-refresh",
				expires: Date.now() + 3600000,
				projectId: "fixture-project",
				modelCatalog: {
					"claude-sonnet-4-6": {
						displayName: "Claude Sonnet 4.6 (Antigravity)",
						maxTokens: 200000,
						maxOutputTokens: 8192,
						supportsThinking: true,
						supportsImages: true,
					},
					"gpt-4o": {
						displayName: "GPT-4o (Antigravity)",
						maxTokens: 128000,
						maxOutputTokens: 4096,
						supportsThinking: false,
						supportsImages: true,
					},
					"o3-mini": {
						displayName: "o3-mini (Antigravity)",
						maxTokens: 200000,
						maxOutputTokens: 100000,
						supportsThinking: true,
						supportsImages: false,
					},
				},
			},
		});
		const registry = ModelRegistry.inMemory(auth);
		const claude = registry.find("google-antigravity", "claude-sonnet-4-6");
		expect(claude).toBeDefined();
		expect(claude?.provider).toBe("google-antigravity");
		expect(claude?.api).toBe("google-antigravity");
		expect(claude?.reasoning).toBe(true);
		expect(claude?.input).toEqual(["text", "image"]);
		expect(claude?.contextWindow).toBe(200000);
		expect(claude?.maxTokens).toBe(8192);

		const gpt = registry.find("google-antigravity", "gpt-4o");
		expect(gpt).toBeDefined();
		expect(gpt?.provider).toBe("google-antigravity");
		expect(gpt?.api).toBe("google-antigravity");
		expect(gpt?.reasoning).toBe(false);
		expect(gpt?.input).toEqual(["text", "image"]);

		const o3 = registry.find("google-antigravity", "o3-mini");
		expect(o3).toBeDefined();
		expect(o3?.provider).toBe("google-antigravity");
		expect(o3?.reasoning).toBe(true);

		expect(auth.get("anthropic")).toBeUndefined();
		expect(auth.get("openai")).toBeUndefined();
		expect(registry.getAll().filter((model) => model.provider === "google-antigravity")).toHaveLength(3);
	});
});
