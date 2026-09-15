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
});
