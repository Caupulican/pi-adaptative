import { registerOAuthProvider, unregisterOAuthProvider } from "@caupulican/pi-ai/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";

afterEach(() => vi.restoreAllMocks());

describe.each(["expiry", "rejected", "mixed"])("%s refresh entry points", (entry) => {
	it.each(["different", "same"])(
		"keeps %s accounts correctly attributed after AGY discovery fails",
		async (identity) => {
			const accounts = ["account-a", identity === "same" ? "account-a" : "account-b"];
			const stores = accounts.map((account) => {
				const backend = new InMemoryAuthStorageBackend();
				backend.withLock(() => ({
					result: undefined,
					next: JSON.stringify({
						"google-antigravity": {
							type: "oauth",
							access: `expired-${account}`,
							refresh: account,
							expires: entry === "rejected" ? Date.now() + 60_000 : 0,
							projectId: `project-${account}`,
							modelCatalog: { "gemini-fixture": { maxTokens: 10000, maxOutputTokens: 1000 } },
						},
					}),
				}));
				return { backend, storage: AuthStorage.fromStorage(backend) };
			});
			const firstTokenStarted = Promise.withResolvers<void>();
			const secondStoreEntered = Promise.withResolvers<void>();
			const tokenResponses = Promise.withResolvers<void>();
			const originalSecondLock = stores[1].backend.withLockAsync.bind(stores[1].backend);
			vi.spyOn(stores[1].backend, "withLockAsync").mockImplementation((fn) =>
				originalSecondLock(async (current) => {
					secondStoreEntered.resolve();
					return fn(current);
				}),
			);
			const tokenAccounts: string[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				if (String(input) === "https://oauth2.googleapis.com/token") {
					const account = new URLSearchParams(String(init?.body)).get("refresh_token");
					expect(accounts).toContain(account);
					tokenAccounts.push(String(account));
					firstTokenStarted.resolve();
					await tokenResponses.promise;
					return Response.json({
						access_token: `access-${account}`,
						refresh_token: `rotated-${account}`,
						expires_in: 3600,
					});
				}
				expect(String(input)).toMatch(/:loadCodeAssist$/);
				return new Response("discovery unavailable", { status: 503 });
			});
			const first =
				entry === "rejected"
					? stores[0].storage.recoverRejectedOAuthApiKey("google-antigravity", `expired-${accounts[0]}`)
					: stores[0].storage.getOAuthApiKey("google-antigravity");
			await firstTokenStarted.promise;
			const second =
				entry === "expiry"
					? stores[1].storage.getOAuthApiKey("google-antigravity")
					: stores[1].storage.recoverRejectedOAuthApiKey("google-antigravity", `expired-${accounts[1]}`);
			const results = Promise.allSettled([first, second]);
			await secondStoreEntered.promise;
			tokenResponses.resolve();
			for (const result of await results) {
				expect(result).toMatchObject({ status: "rejected", reason: { name: "OAuthRefreshCompletedError" } });
			}
			for (let i = 0; i < stores.length; i++) {
				const reopened = AuthStorage.fromStorage(stores[i].backend);
				expect(reopened.get("google-antigravity")).toMatchObject({
					access: `access-${accounts[i]}`,
					refresh: `rotated-${accounts[i]}`,
					projectId: `project-${accounts[i]}`,
				});
				expect(await reopened.getOAuthApiKey("google-antigravity")).toBe(`access-${accounts[i]}`);
			}
			expect(tokenAccounts.sort()).toEqual(identity === "same" ? ["account-a"] : ["account-a", "account-b"]);
		},
	);
});

it.each(["replace", "unchanged"])(
	"keeps refresh and key projection on one adapter when registry is %s",
	async (action) => {
		const providerId = "storage-adapter-identity-test";
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const oldRefresh = vi.fn(async () => ({ access: "old-access", refresh: "rotated", expires: Date.now() + 60000 }));
		const newRefresh = vi.fn(async () => ({ access: "new-access", refresh: "rotated", expires: Date.now() + 60000 }));
		const oldProvider = {
			id: providerId,
			name: "Old adapter",
			login: oldRefresh,
			refreshToken: oldRefresh,
			getApiKey: (credentials: { access: string }) => `old:${credentials.access}`,
		};
		registerOAuthProvider(oldProvider);
		try {
			const backend = new InMemoryAuthStorageBackend();
			backend.withLock(() => ({
				result: undefined,
				next: JSON.stringify({
					[providerId]: { type: "oauth", access: "expired", refresh: "original", expires: 0 },
				}),
			}));
			const storage = AuthStorage.fromStorage(backend);
			const originalLock = backend.withLockAsync.bind(backend);
			vi.spyOn(backend, "withLockAsync").mockImplementation((fn) =>
				originalLock(async (current) => {
					entered.resolve();
					await release.promise;
					return fn(current);
				}),
			);
			const pending = storage.getOAuthApiKey(providerId);
			await entered.promise;
			if (action === "replace") {
				registerOAuthProvider({
					...oldProvider,
					name: "Replacement adapter",
					refreshToken: newRefresh,
					getApiKey: (credentials) => `new:${credentials.access}`,
				});
			}
			release.resolve();
			expect(await pending).toBe("old:old-access");
			expect(oldRefresh).toHaveBeenCalledOnce();
			expect(newRefresh).not.toHaveBeenCalled();
			expect(AuthStorage.fromStorage(backend).get(providerId)).toMatchObject({ access: "old-access" });
		} finally {
			release.resolve();
			unregisterOAuthProvider(providerId);
		}
	},
);
