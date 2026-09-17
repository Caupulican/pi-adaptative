import type { OAuthCredentials, OAuthProviderInterface } from "@caupulican/pi-ai/oauth";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const providerId = "oauth-refresh-lifecycle-test";

function createStore(): AuthStorage {
	return AuthStorage.inMemory({
		[providerId]: { type: "oauth", access: "expired", refresh: "same-refresh", expires: 0 },
	});
}

function adapter(
	name: string,
	refreshToken: OAuthProviderInterface["refreshToken"],
): Omit<OAuthProviderInterface, "id"> {
	return {
		name,
		login: async () => {
			throw new Error("Login is not used by this regression");
		},
		refreshToken,
		getApiKey: (credentials) => `${name}:${credentials.access}`,
	};
}

describe("OAuth refresh through real provider registration lifecycle", () => {
	it.each(["retired-first", "replacement-first"])(
		"preserves credential and projection ownership through %s settlement",
		async (order) => {
			const retired = Promise.withResolvers<OAuthCredentials>();
			const replacement = Promise.withResolvers<OAuthCredentials>();
			const entered = Promise.withResolvers<void>();
			const firstStore = createStore();
			const secondStore = createStore();
			const registry = ModelRegistry.inMemory(firstStore);
			const oldRefresh = vi.fn(() => {
				entered.resolve();
				return retired.promise;
			});
			const newRefresh = vi.fn(() => replacement.promise);
			try {
				registry.registerProvider(providerId, { oauth: adapter("old", oldRefresh) });
				const first = registry.getApiKeyForProvider(providerId);
				await entered.promise;
				registry.registerProvider(providerId, { oauth: adapter("new", newRefresh) });
				const second = secondStore.getOAuthApiKey(providerId);
				const oldCredentials = { access: "old-access", refresh: "old-refresh", expires: Date.now() + 60_000 };
				const newCredentials = { access: "new-access", refresh: "new-refresh", expires: Date.now() + 60_000 };
				if (order === "retired-first") {
					retired.resolve(oldCredentials);
					await first;
					replacement.resolve(newCredentials);
				} else {
					replacement.resolve(newCredentials);
					// Resolve both without depending on a potentially broken deduplicator to settle.
					await Promise.resolve();
					retired.resolve(oldCredentials);
				}
				const results = await Promise.all([first, second]);
				expect(results).toEqual(["old:old-access", "new:new-access"]);
				expect(firstStore.get(providerId)).toMatchObject(oldCredentials);
				expect(secondStore.get(providerId)).toMatchObject(newCredentials);
				expect(oldRefresh).toHaveBeenCalledOnce();
				expect(newRefresh).toHaveBeenCalledOnce();
			} finally {
				registry.unregisterProvider(providerId);
			}
		},
	);

	it("retiring one registry does not remove another registry's pending OAuth adapter", async () => {
		const retired = Promise.withResolvers<OAuthCredentials>();
		const replacement = Promise.withResolvers<OAuthCredentials>();
		const entered = Promise.withResolvers<void>();
		const first = ModelRegistry.inMemory(createStore());
		const second = ModelRegistry.inMemory(createStore());
		const replacementRefresh = vi.fn(() => replacement.promise);
		try {
			first.registerProvider(providerId, {
				oauth: adapter("old", () => {
					entered.resolve();
					return retired.promise;
				}),
			});
			const oldResult = first.getApiKeyForProvider(providerId);
			await entered.promise;
			second.registerProvider(providerId, { oauth: adapter("new", replacementRefresh) });
			const newResult = second.getApiKeyForProvider(providerId);
			first.unregisterProvider(providerId);
			const thirdResult = createStore().getOAuthApiKey(providerId);
			retired.resolve({ access: "old", refresh: "old-refresh", expires: Date.now() + 60_000 });
			replacement.resolve({ access: "new", refresh: "new-refresh", expires: Date.now() + 60_000 });
			expect(await Promise.all([oldResult, newResult, thirdResult])).toEqual(["old:old", "new:new", "new:new"]);
			expect(replacementRefresh).toHaveBeenCalledOnce();
		} finally {
			first.unregisterProvider(providerId);
			second.unregisterProvider(providerId);
		}
	});
});
