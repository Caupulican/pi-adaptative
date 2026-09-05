import { getApiProvider } from "@caupulican/pi-ai/api-registry";
import { registerFauxProvider } from "@caupulican/pi-ai/faux";
import { describe, expect, it, onTestFinished } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

describe("model registry reload ownership", () => {
	it("keeps existing integrations when a provider receives a partial configuration update", () => {
		const external = registerFauxProvider();
		onTestFinished(() => external.unregister());
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		onTestFinished(() => registry.unregisterProvider("partial"));
		registry.registerProvider("partial", {
			api: "partial-api",
			streamSimple: getApiProvider(external.api)!.streamSimple,
		});
		registry.registerProvider("partial", { headers: { "X-Test": "updated" } });
		expect(getApiProvider("partial-api")).toBeDefined();
	});

	it("preserves external transports across refresh and rollback", () => {
		const external = registerFauxProvider();
		onTestFinished(() => external.unregister());
		const transport = getApiProvider(external.api);
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const snapshot = registry.createReloadSnapshot();
		registry.refresh();
		expect(getApiProvider(external.api)).toBe(transport);
		registry.restoreReloadSnapshot(snapshot);
		expect(getApiProvider(external.api)).toBe(transport);
	});

	it("removes only the rejected generation's owned transport", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const snapshot = registry.createReloadSnapshot();
		const external = registerFauxProvider();
		onTestFinished(() => external.unregister());
		const streamSimple = getApiProvider(external.api)!.streamSimple;
		registry.registerProvider("candidate", { api: "candidate-api", streamSimple });
		expect(getApiProvider("candidate-api")).toBeDefined();
		registry.restoreReloadSnapshot(snapshot);
		expect(getApiProvider("candidate-api")).toBeUndefined();
		expect(getApiProvider(external.api)).toBeDefined();
	});
});
