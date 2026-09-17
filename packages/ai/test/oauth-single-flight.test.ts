import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthApiKey, registerOAuthProvider, unregisterOAuthProvider } from "../src/utils/oauth/index.ts";
import type { OAuthCredentials, OAuthProviderInterface } from "../src/utils/oauth/types.ts";

const providerId = "single-flight-test";

afterEach(() => {
	unregisterOAuthProvider(providerId);
});

function registerTestProvider(
	refreshToken: OAuthProviderInterface["refreshToken"],
	getApiKey: OAuthProviderInterface["getApiKey"] = (credentials) => credentials.access,
): void {
	registerOAuthProvider({
		id: providerId,
		name: "Single Flight Test",
		login: async () => ({ access: "login-access", refresh: "login-refresh", expires: Date.now() + 1000 }),
		refreshToken,
		getApiKey,
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
	it("isolates concurrent accounts within the same provider", async () => {
		const release = Promise.withResolvers<void>();
		const refresh = vi.fn(async (credentials: OAuthCredentials) => {
			await release.promise;
			return { ...credentials, access: `new-${credentials.refresh}`, expires: Date.now() + 60_000 };
		});
		registerTestProvider(refresh);
		const accountA = expiredCredentials();
		const accountB = { [providerId]: { ...accountA[providerId], refresh: "other-account-refresh" } };
		const first = getOAuthApiKey(providerId, accountA);
		const second = getOAuthApiKey(providerId, accountB);
		release.resolve();
		const results = await Promise.all([first, second]);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(results.map((result) => result?.apiKey)).toEqual(["new-expired-refresh", "new-other-account-refresh"]);
	});

	it("does not share a retired provider's refresh with its replacement", async () => {
		const retired = Promise.withResolvers<OAuthCredentials>();
		registerTestProvider(() => retired.promise);
		const credentials = expiredCredentials();
		const first = getOAuthApiKey(providerId, credentials);
		const replacementRefresh = vi.fn(async () => ({
			access: "replacement-access",
			refresh: "replacement-refresh",
			expires: Date.now() + 60_000,
		}));
		registerTestProvider(replacementRefresh);
		const second = getOAuthApiKey(providerId, credentials);
		retired.resolve({ access: "retired-access", refresh: "retired-refresh", expires: Date.now() + 60_000 });
		const results = await Promise.all([first, second]);
		expect(results.map((result) => result?.apiKey)).toEqual(["retired-access", "replacement-access"]);
		expect(replacementRefresh).toHaveBeenCalledOnce();
	});

	it.each(["retired-first", "replacement-first"])(
		"keeps each provider's key projection and pending operation through %s settlement",
		async (order) => {
			const retired = Promise.withResolvers<OAuthCredentials>();
			const replacement = Promise.withResolvers<OAuthCredentials>();
			const oldRefresh = vi.fn(() => retired.promise);
			const newRefresh = vi.fn(() => replacement.promise);
			registerTestProvider(oldRefresh, (credentials) => `old:${credentials.access}`);
			const credentials = expiredCredentials();
			const first = getOAuthApiKey(providerId, credentials);
			registerTestProvider(newRefresh, (credentials) => `new:${credentials.access}`);
			const second = getOAuthApiKey(providerId, credentials);
			const rotated = { access: "rotated", refresh: "rotated-refresh", expires: Date.now() + 60_000 };
			let third: ReturnType<typeof getOAuthApiKey> | undefined;
			if (order === "retired-first") {
				retired.resolve(rotated);
				await first;
				third = getOAuthApiKey(providerId, credentials);
				replacement.resolve(rotated);
			} else {
				replacement.resolve(rotated);
				await second;
				retired.resolve(rotated);
			}
			const results = await Promise.all([first, second]);
			const thirdResult = await third;
			expect(results.map((result) => result?.apiKey)).toEqual(["old:rotated", "new:rotated"]);
			if (third) expect(thirdResult?.apiKey).toBe("new:rotated");
			expect(oldRefresh).toHaveBeenCalledOnce();
			expect(newRefresh).toHaveBeenCalledOnce();
		},
	);

	it("shares matching refresh credentials even when callers hold separate snapshots", async () => {
		const release = Promise.withResolvers<void>();
		const refresh = vi.fn(async (credentials: OAuthCredentials) => {
			await release.promise;
			return { ...credentials, access: "shared-access", expires: Date.now() + 60_000 };
		});
		registerTestProvider(refresh);
		const first = getOAuthApiKey(providerId, expiredCredentials());
		const second = getOAuthApiKey(providerId, expiredCredentials());
		release.resolve();
		const results = await Promise.all([first, second]);
		expect(refresh).toHaveBeenCalledOnce();
		expect(results.map((result) => result?.apiKey)).toEqual(["shared-access", "shared-access"]);
	});

	it("does not let another account's rejection poison a successful refresh", async () => {
		const release = Promise.withResolvers<void>();
		registerTestProvider(async (credentials) => {
			await release.promise;
			if (credentials.refresh === "expired-refresh") throw new Error("revoked account");
			return { ...credentials, access: "surviving-account", expires: Date.now() + 60_000 };
		});
		const first = getOAuthApiKey(providerId, expiredCredentials());
		const second = getOAuthApiKey(providerId, {
			[providerId]: { ...expiredCredentials()[providerId], refresh: "valid-account-refresh" },
		});
		const settled = Promise.allSettled([first, second]);
		release.resolve();
		const results = await settled;
		expect(results[0].status).toBe("rejected");
		expect(results[1]).toMatchObject({ status: "fulfilled", value: { apiKey: "surviving-account" } });
	});

	it("keeps a pending account deduplicated when another account finishes", async () => {
		const pending = Promise.withResolvers<OAuthCredentials>();
		const refresh = vi.fn(async (credentials: OAuthCredentials) => {
			if (credentials.refresh === "pending-refresh") return pending.promise;
			return { ...credentials, access: "finished-access", expires: Date.now() + 60_000 };
		});
		registerTestProvider(refresh);
		const pendingCredentials = {
			[providerId]: { ...expiredCredentials()[providerId], refresh: "pending-refresh" },
		};
		const first = getOAuthApiKey(providerId, expiredCredentials());
		const second = getOAuthApiKey(providerId, pendingCredentials);
		await first;
		const third = getOAuthApiKey(providerId, pendingCredentials);
		pending.resolve({ access: "pending-access", refresh: "rotated-refresh", expires: Date.now() + 60_000 });
		const results = await Promise.all([second, third]);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(results.map((result) => result?.apiKey)).toEqual(["pending-access", "pending-access"]);
	});

	it("cleans the original identity when an adapter mutates its credential argument", async () => {
		const refresh = vi.fn(async (credentials: OAuthCredentials) => {
			credentials.refresh = "rotated-in-place";
			return { ...credentials, access: "new-access", expires: Date.now() + 60_000 };
		});
		registerTestProvider(refresh);
		await getOAuthApiKey(providerId, expiredCredentials());
		await getOAuthApiKey(providerId, expiredCredentials());
		expect(refresh).toHaveBeenCalledTimes(2);
	});

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
