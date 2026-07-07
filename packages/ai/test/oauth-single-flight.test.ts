import { afterEach, describe, expect, it } from "vitest";
import { getOAuthApiKey, registerOAuthProvider, unregisterOAuthProvider } from "../src/utils/oauth/index.ts";
import type { OAuthCredentials, OAuthProviderInterface } from "../src/utils/oauth/types.ts";

const providerId = "single-flight-test";

afterEach(() => {
	unregisterOAuthProvider(providerId);
});

function registerTestProvider(refreshToken: OAuthProviderInterface["refreshToken"]): void {
	registerOAuthProvider({
		id: providerId,
		name: "Single Flight Test",
		login: async () => ({ access: "login-access", refresh: "login-refresh", expires: Date.now() + 1000 }),
		refreshToken,
		getApiKey: (credentials) => credentials.access,
	});
}

function expiredCredentials(): Record<string, OAuthCredentials> {
	return {
		[providerId]: {
			access: "expired-access",
			refresh: "expired-refresh",
			expires: Date.now() - 1,
		},
	};
}

describe("OAuth refresh single-flight", () => {
	it("shares one refresh across concurrent expired-token callers", async () => {
		let refreshes = 0;
		const refreshed = { access: "new-access", refresh: "new-refresh", expires: Date.now() + 60_000 };
		registerTestProvider(async () => {
			refreshes++;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return refreshed;
		});
		const credentials = expiredCredentials();

		const [first, second] = await Promise.all([
			getOAuthApiKey(providerId, credentials),
			getOAuthApiKey(providerId, credentials),
		]);

		expect(refreshes).toBe(1);
		expect(first).toEqual({ newCredentials: refreshed, apiKey: "new-access" });
		expect(second).toEqual({ newCredentials: refreshed, apiKey: "new-access" });
	});

	it("clears failed refreshes so later callers retry", async () => {
		let refreshes = 0;
		registerTestProvider(async () => {
			refreshes++;
			if (refreshes === 1) throw new Error("temporary refresh failure");
			return { access: "retry-access", refresh: "retry-refresh", expires: Date.now() + 60_000 };
		});
		const credentials = expiredCredentials();

		await expect(getOAuthApiKey(providerId, credentials)).rejects.toThrow("Failed to refresh OAuth token");
		await expect(getOAuthApiKey(providerId, credentials)).resolves.toMatchObject({ apiKey: "retry-access" });
		expect(refreshes).toBe(2);
	});
});
