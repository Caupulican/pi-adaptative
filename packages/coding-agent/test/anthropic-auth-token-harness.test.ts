import { ANTHROPIC_AUTH_TOKEN_ENV } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Anthropic bearer-token harness auth", () => {
	it("makes ANTHROPIC_AUTH_TOKEN available to model selection and request resolution", async () => {
		vi.stubEnv(ANTHROPIC_AUTH_TOKEN_ENV, "harness-auth-token");
		const authStorage = AuthStorage.inMemory();
		const registry = ModelRegistry.inMemory(authStorage);
		const model = registry.getAll().find((candidate) => candidate.provider === "anthropic");

		expect(model).toBeDefined();
		expect(authStorage.hasAuth("anthropic")).toBe(true);
		expect(registry.hasConfiguredAuth(model!)).toBe(true);

		const auth = await registry.getApiKeyAndHeaders(model!);
		expect(auth).toEqual({
			ok: true,
			apiKey: undefined,
			headers: { Authorization: "Bearer harness-auth-token" },
		});
		expect(registry.canUseResolvedRequestAuth(model!, auth)).toBe(true);
	});

	it("lets explicit model authorization override the environment token", async () => {
		vi.stubEnv(ANTHROPIC_AUTH_TOKEN_ENV, "environment-token");
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const builtIn = registry.getAll().find((candidate) => candidate.provider === "anthropic");
		expect(builtIn).toBeDefined();

		const auth = await registry.getApiKeyAndHeaders({
			...builtIn!,
			headers: { ...builtIn!.headers, Authorization: "Bearer explicit-token" },
		});

		expect(auth).toMatchObject({
			ok: true,
			headers: { Authorization: "Bearer explicit-token" },
		});
	});
});
