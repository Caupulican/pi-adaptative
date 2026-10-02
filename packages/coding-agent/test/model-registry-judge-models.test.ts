import { getModels } from "@caupulican/pi-ai";
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
		expect(listed.some((model) => model.kind === "judge")).toBe(false);
		expect(registry.getAvailable().some((model) => model.provider === "openrouter")).toBe(true);
		expect(registry.find("typesafe", "jev-latest")?.kind).toBe("judge");
		expect(registry.find("openrouter", "typesafe/jev-latest")?.kind).toBe("judge");

		const judges = [...getModels("typesafe"), ...getModels("openrouter")].filter((model) => model.kind === "judge");
		expect(judges.length).toBeGreaterThan(0);
		for (const judge of judges) {
			expect(registry.find(judge.provider, judge.id)?.kind).toBe("judge");
			expect(listed.some((model) => model.provider === judge.provider && model.id === judge.id)).toBe(false);
		}
	});

	it("lists TypeSafe text routers as conversation models and requires provider auth for availability", () => {
		const auth = AuthStorage.inMemory();
		const registry = ModelRegistry.inMemory(auth);
		const router = registry.find("openrouter", "typesafe/jev-router");
		expect(router).toBeDefined();
		expect(router?.kind).toBeUndefined();
		expect(registry.getAll()).toContainEqual(router);
		expect(registry.getAvailable()).not.toContainEqual(router);

		auth.set("openrouter", { type: "api_key", key: "openrouter-key" });
		expect(registry.getAvailable()).toContainEqual(router);
	});
});
