import { type OAuthCredentials, registerOAuthProvider, unregisterOAuthProvider } from "@caupulican/pi-ai/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, OAuthCredentialUnusableError } from "../src/core/auth-storage.ts";

const provider = "imagegen-oauth-test";
afterEach(() => {
	unregisterOAuthProvider(provider);
	vi.unstubAllEnvs();
});

describe("OAuth-only credential resolution", () => {
	it("ignores runtime, stored API-key, environment and fallback credentials", async () => {
		vi.stubEnv("OPENAI_API_KEY", "environment-key");
		const store = AuthStorage.inMemory({ openai: { type: "api_key", key: "stored-key" } });
		store.setRuntimeApiKey("openai", "runtime-key");
		const fallback = vi.fn(() => "fallback-key");
		store.setFallbackResolver(fallback);
		expect(await store.getOAuthApiKey("openai")).toBeUndefined();
		expect(await store.getOAuthApiKey("missing")).toBeUndefined();
		expect(fallback).not.toHaveBeenCalled();
		expect(await store.getApiKey("openai")).toBe("runtime-key");
	});

	it("refreshes through the existing owner and ignores API-key override on the subscription path", async () => {
		const refresh = vi.fn(async (credentials: OAuthCredentials) => ({
			...credentials,
			access: "rotated-token",
			expires: Date.now() + 60_000,
		}));
		registerOAuthProvider({
			id: provider,
			name: "Test",
			login: async () => {
				throw new Error("unused");
			},
			refreshToken: refresh,
			getApiKey: (credentials) => credentials.access,
		});
		const store = AuthStorage.inMemory({
			[provider]: { type: "oauth", access: "expired", refresh: "refresh", expires: 0 },
		});
		store.setRuntimeApiKey(provider, "api-key");
		expect(await store.getOAuthApiKey(provider)).toBe("rotated-token");
		expect(await store.getOAuthApiKey(provider)).toBe("rotated-token");
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(await store.getApiKey(provider)).toBe("api-key");
	});

	it("a failed refresh is reported, never silently replaced by a configured key", async () => {
		registerOAuthProvider({
			id: provider,
			name: "Test",
			login: async () => {
				throw new Error("unused");
			},
			refreshToken: async () => {
				throw new Error("offline");
			},
			getApiKey: (credentials) => credentials.access,
		});
		const store = AuthStorage.inMemory({
			[provider]: { type: "oauth", access: "expired", refresh: "refresh", expires: 0 },
		});
		const fallback = vi.fn(() => "fallback-key");
		store.setFallbackResolver(fallback);

		// The credential is stored and expired: the caller must learn that, not "no API key".
		await expect(store.getOAuthApiKey(provider)).rejects.toBeInstanceOf(OAuthCredentialUnusableError);
		await expect(store.getApiKey(provider)).rejects.toThrow(/expired on .* and could not be refreshed/);
		expect(fallback).not.toHaveBeenCalled();
	});
});
