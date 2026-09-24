import { OAuthRefreshRejectedError, registerOAuthProvider, unregisterOAuthProvider } from "@caupulican/pi-ai/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, OAuthCredentialUnusableError } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const providerId = "oauth-permanent-refresh-test";

afterEach(() => {
	unregisterOAuthProvider(providerId);
	vi.restoreAllMocks();
});

function register(refreshToken: () => Promise<never>) {
	const refresh = vi.fn(refreshToken);
	registerOAuthProvider({
		id: providerId,
		name: "Test",
		login: async () => {
			throw new Error("unused");
		},
		refreshToken: refresh,
		getApiKey: (credentials) => credentials.access,
	});
	return refresh;
}

describe("permanent OAuth refresh failures", () => {
	it("stops refreshing a credential the provider rejected for good, until it is replaced", async () => {
		const storage = AuthStorage.inMemory({
			[providerId]: { type: "oauth", access: "expired", refresh: "dead-refresh", expires: 0 },
		});
		const refresh = register(async () => {
			throw new OAuthRefreshRejectedError(providerId, "rejected", "refresh rejected");
		});
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(storage.getApiKey(providerId)).rejects.toBeInstanceOf(OAuthCredentialUnusableError);
		}
		expect(refresh).toHaveBeenCalledTimes(1);
		storage.set(providerId, { type: "oauth", access: "expired", refresh: "fresh-refresh", expires: 0 });
		await expect(storage.getApiKey(providerId)).rejects.toBeInstanceOf(OAuthCredentialUnusableError);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("keeps retrying a transient refresh failure (control)", async () => {
		const storage = AuthStorage.inMemory({
			[providerId]: { type: "oauth", access: "expired", refresh: "refresh", expires: 0 },
		});
		const refresh = register(async () => {
			throw new Error("network down");
		});
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(storage.getApiKey(providerId)).rejects.toBeInstanceOf(OAuthCredentialUnusableError);
		}
		expect(refresh).toHaveBeenCalledTimes(3);
	});
});

describe("OAuth request headers", () => {
	it("adds a provider's credential-derived headers per request and omits them for credentials without the claim", async () => {
		const storage = AuthStorage.inMemory({
			"openai-codex": {
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				accountId: "acct",
				chatgptAccountIsFedramp: true,
			},
		});
		const registry = ModelRegistry.inMemory(storage);
		const model = registry.getAll().find((candidate) => candidate.provider === "openai-codex");
		expect(model).toBeDefined();
		const fedramp = await registry.getApiKeyAndHeaders(model!);
		expect(fedramp.ok && fedramp.credentialHeaders).toEqual({ "X-OpenAI-Fedramp": "true" });
		storage.set("openai-codex", {
			type: "oauth",
			access: "access",
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
			accountId: "acct",
		});
		const legacy = await registry.getApiKeyAndHeaders(model!);
		expect(legacy.ok && legacy.credentialHeaders).toBeUndefined();
	});

	it("returns the claim apart from configured headers, and never for a runtime override", async () => {
		const credential = {
			type: "oauth" as const,
			access: "access",
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
			accountId: "acct",
			chatgptAccountIsFedramp: true,
		};
		const storage = AuthStorage.inMemory({ "openai-codex": credential });
		const registry = ModelRegistry.inMemory(storage);
		registry.registerProvider("openai-codex", { headers: { "x-openai-fedramp": "false", "X-Other": "kept" } });
		const model = registry.getAll().find((candidate) => candidate.provider === "openai-codex");
		const claimed = await registry.getApiKeyAndHeaders(model!);
		expect(claimed.ok && claimed.credentialHeaders).toEqual({ "X-OpenAI-Fedramp": "true" });
		expect(claimed.ok && claimed.headers?.["X-Other"]).toBe("kept");
		storage.setRuntimeApiKey("openai-codex", "override-token");
		const overridden = await registry.getApiKeyAndHeaders(model!);
		expect(overridden.ok && overridden.credentialHeaders).toBeUndefined();
	});
});
