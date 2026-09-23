import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

describe("System One engines in the model registry", () => {
	it("are never listed for a conversation, even with their provider authenticated, and still resolve by id", () => {
		const auth = AuthStorage.inMemory();
		auth.set("typesafe", { type: "api_key", key: "typesafe-key" });
		auth.set("openrouter", { type: "api_key", key: "openrouter-key" });
		const registry = ModelRegistry.inMemory(auth);

		const listed = [...registry.getAll(), ...registry.getAvailable()];
		expect(listed.some((model) => model.provider === "typesafe")).toBe(false);
		expect(listed.some((model) => /^~?typesafe\//.test(model.id))).toBe(false);
		expect(registry.getAvailable().some((model) => model.provider === "openrouter")).toBe(true);

		expect(registry.find("typesafe", "jev-latest")?.kind).toBe("judge");
		expect(registry.find("openrouter", "typesafe/jev-latest")?.kind).toBe("judge");
	});
});
