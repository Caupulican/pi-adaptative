import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider, unregisterOAuthProvider } from "@caupulican/pi-ai/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend, OAuthCredentialUnusableError } from "../src/core/auth-storage.ts";

const providerId = "oauth-failure-ownership-test";
const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	unregisterOAuthProvider(providerId);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OAuth failed-refresh recovery preserves concurrent local intent", () => {
	it.each(["sibling", "unreadable"])("handles %s storage after the failed transaction releases", async (action) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-oauth-failure-recovery-"));
		directories.push(directory);
		const path = join(directory, "auth.json");
		const backend = new FileAuthStorageBackend(path);
		const storage = AuthStorage.fromStorage(backend);
		storage.set(providerId, { type: "oauth", access: "expired", refresh: "refresh", expires: 0 });
		const failure = new Error("transport offline");
		const readFailure = new Error("recovery read refused");
		const refresh = vi.fn(async () => {
			throw failure;
		});
		registerOAuthProvider({
			id: providerId,
			name: "Test",
			login: async () => {
				throw new Error("unused");
			},
			refreshToken: refresh,
			getApiKey: (credentials) => credentials.access,
		});
		const withLockAsync = backend.withLockAsync.bind(backend);
		let transactions = 0;
		vi.spyOn(backend, "withLockAsync").mockImplementation(async (fn) => {
			if (++transactions > 1 && action === "unreadable") throw readFailure;
			try {
				return await withLockAsync(fn);
			} catch (error) {
				// Another client writes only after the real lock has released. It must not
				// mutate this client's revision or refresh the already rotated credential.
				if (action === "sibling")
					AuthStorage.create(path).set(providerId, {
						type: "oauth",
						access: "sibling",
						refresh: "sibling-refresh",
						expires: Date.now() + 60_000,
					});
				throw error;
			}
		});
		const result = await storage.getOAuthApiKey(providerId).catch((error: unknown) => error);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(transactions).toBe(2);
		if (action === "sibling") {
			expect(result).toBe("sibling");
			expect(storage.get(providerId)).toMatchObject({ access: "sibling", refresh: "sibling-refresh" });
		} else {
			expect(result).toBeInstanceOf(OAuthCredentialUnusableError);
			expect((result as OAuthCredentialUnusableError).reason).toContain("transport offline");
			expect(storage.get(providerId)).toMatchObject({ access: "expired" });
			expect(storage.drainErrors()).toContain(readFailure);
		}
	});

	it.each(["logout", "replacement", "unrelated", "none"])(
		"does not undo %s intent while reloading after a failed refresh",
		async (action) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-oauth-failure-ownership-"));
			directories.push(directory);
			const path = join(directory, "auth.json");
			const storage = AuthStorage.create(path);
			storage.set(providerId, { type: "oauth", access: "expired", refresh: "refresh", expires: 0 });
			const entered = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const failure = new Error("transport offline");
			registerOAuthProvider({
				id: providerId,
				name: "Test",
				login: async () => {
					throw new Error("unused");
				},
				refreshToken: async () => {
					entered.resolve();
					await finish.promise;
					throw failure;
				},
				getApiKey: (credentials) => credentials.access,
			});
			const pending = storage.getOAuthApiKey(providerId).catch((error: unknown) => error);
			await entered.promise;
			try {
				if (action === "logout") storage.logout(providerId);
				else if (action !== "none") {
					// The real file lock is held by the refresh. Explicit set intentionally
					// keeps a session-only value after recording the failed persistence.
					storage.set(action === "replacement" ? providerId : "other", { type: "api_key", key: "new-key" });
					const persisted = JSON.parse(readFileSync(path, "utf8"));
					expect(persisted[providerId]).toMatchObject({ access: "expired" });
					expect(persisted.other).toBeUndefined();
				}
			} finally {
				finish.resolve();
			}
			const result = await pending;
			if (action === "logout") {
				expect(storage.get(providerId)).toBeUndefined();
				expect(result).toBeUndefined();
			} else if (action === "replacement") {
				expect(storage.get(providerId)).toEqual({ type: "api_key", key: "new-key" });
				expect(result).toBeUndefined();
				expect(await storage.getApiKey(providerId)).toBe("new-key");
			} else {
				expect(result).toBeInstanceOf(OAuthCredentialUnusableError);
				expect((result as OAuthCredentialUnusableError).reason).toContain("transport offline");
				if (action === "unrelated") expect(storage.get("other")).toEqual({ type: "api_key", key: "new-key" });
			}
			expect(storage.drainErrors()).not.toHaveLength(0);
		},
	);
});
