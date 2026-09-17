import { promises as fsPromises, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider, unregisterOAuthProvider } from "@caupulican/pi-ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend, OAuthCredentialUnusableError } from "../src/core/auth-storage.ts";

const providerId = "oauth-lock-recovery-test";
const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	unregisterOAuthProvider(providerId);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OAuth rotation survives loss of the refresh lock", () => {
	it.each(["expiry", "rejection"])("saves rotated %s credentials after reacquiring ownership", async (trigger) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-oauth-lock-recovery-"));
		directories.push(directory);
		const path = join(directory, "auth.json");
		const backend = new FileAuthStorageBackend(path);
		const storage = AuthStorage.fromStorage(backend);
		storage.set(providerId, {
			type: "oauth",
			access: "original",
			refresh: "original-refresh",
			expires: trigger === "expiry" ? 0 : Date.now() + 60_000,
		});
		const rotated = { access: "rotated", refresh: "rotated-refresh", expires: Date.now() + 60_000 };
		const originalLock = lockfile.lock.bind(lockfile);
		let compromise: ((error: Error) => void) | undefined;
		const acquired = vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
			compromise = options?.onCompromised;
			return originalLock(file, options);
		});
		const refresh = vi.fn(async () => {
			// The server has rotated the single-use refresh token. Local ownership is
			// lost before FileAuthStorageBackend can commit the successful response.
			compromise?.(new Error("simulated lost ownership"));
			return rotated;
		});
		registerOAuthProvider({
			id: providerId,
			name: "Test",
			login: async () => rotated,
			refreshToken: refresh,
			getApiKey: (credentials) => credentials.access,
		});
		const result =
			trigger === "expiry"
				? await storage.getOAuthApiKey(providerId)
				: await storage.recoverRejectedOAuthApiKey(providerId, "original");
		expect(result).toBe("rotated");
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(acquired).toHaveBeenCalledTimes(2);
		expect(JSON.parse(readFileSync(path, "utf8"))[providerId]).toMatchObject(rotated);
		expect(storage.get(providerId)).toMatchObject(rotated);
	});

	it("keeps ordinary successful refresh to one transaction", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-oauth-lock-control-"));
		directories.push(directory);
		const storage = AuthStorage.create(join(directory, "auth.json"));
		storage.set(providerId, { type: "oauth", access: "expired", refresh: "original-refresh", expires: 0 });
		const rotated = { access: "rotated", refresh: "rotated-refresh", expires: Date.now() + 60_000 };
		const refresh = vi.fn(async () => rotated);
		registerOAuthProvider({
			id: providerId,
			name: "Test",
			login: async () => rotated,
			refreshToken: refresh,
			getApiKey: (credentials) => credentials.access,
		});
		const acquired = vi.spyOn(lockfile, "lock");
		expect(await storage.getOAuthApiKey(providerId)).toBe("rotated");
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(acquired).toHaveBeenCalledTimes(1);
		expect(storage.drainErrors()).toEqual([]);
	});

	for (const trigger of ["expiry", "rejection"]) {
		it.each([
			"sibling",
			"logout",
			"replacement",
			"same-token-metadata",
			"metadata-only-expired",
			"metadata-only-valid",
			"expired-sibling",
			"expires-on-salvage-release",
			"unrelated",
			"local-logout",
			"local-replacement",
			"local-unrelated",
			"salvage-logout",
			"salvage-replacement",
			"salvage-unrelated",
			"second-compromise",
			"already-committed",
			"provider-failure",
		])(`${trigger} recovery respects %s without another provider call`, async (action) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-oauth-lock-races-"));
			directories.push(directory);
			const path = join(directory, "auth.json");
			const storage = AuthStorage.create(path);
			const original = {
				type: "oauth" as const,
				access: "original",
				refresh: "original-refresh",
				expires: trigger === "expiry" ? 0 : Date.now() + 60_000,
				clientId: "client-a",
			};
			storage.set(providerId, original);
			const rotated = {
				access: "rotated",
				refresh: "rotated-refresh",
				expires: Date.now() + 60_000,
				clientId: "client-a",
			};
			const sibling = { ...original, access: "sibling", refresh: "sibling-refresh", expires: Date.now() + 60_000 };
			const originalLock = lockfile.lock.bind(lockfile);
			let compromise: ((error: Error) => void) | undefined;
			let transactions = 0;
			vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
				const ordinal = ++transactions;
				compromise = options?.onCompromised;
				const release = await originalLock(file, options);
				if (ordinal === 2 && action === "second-compromise") compromise?.(new Error("second ownership loss"));
				return async () => {
					await release();
					if (ordinal === 2 && action === "expires-on-salvage-release")
						vi.spyOn(Date, "now").mockReturnValue(sibling.expires);
					if (ordinal !== (action.startsWith("salvage-") ? 2 : 1)) return;
					const writer =
						action.startsWith("local-") || action.startsWith("salvage-") ? storage : AuthStorage.create(path);
					if (action.endsWith("logout")) writer.logout(providerId);
					else if (action.endsWith("replacement")) writer.set(providerId, { type: "api_key", key: "manual" });
					else if (action.endsWith("unrelated")) writer.set("other", { type: "api_key", key: "other-key" });
					else if (action === "sibling" || action === "expires-on-salvage-release")
						writer.set(providerId, sibling);
					else if (action === "same-token-metadata")
						writer.set(providerId, { ...sibling, refresh: original.refresh, clientId: "client-b" });
					else if (action === "expired-sibling") writer.set(providerId, { ...sibling, expires: 0 });
					else if (action === "metadata-only-expired")
						writer.set(providerId, { ...original, expires: 0, clientId: "client-b" });
					else if (action === "metadata-only-valid")
						writer.set(providerId, { ...original, expires: Date.now() + 60_000, clientId: "client-b" });
				};
			});
			if (action === "already-committed") {
				const rename = fsPromises.rename.bind(fsPromises);
				vi.spyOn(fsPromises, "rename").mockImplementation(async (...args) => {
					await rename(...args);
					compromise?.(new Error("ownership lost after rename"));
				});
			}
			const refresh = vi.fn(async () => {
				if (action === "provider-failure") throw new Error("token request failed");
				if (action !== "already-committed") compromise?.(new Error("first ownership loss"));
				return rotated;
			});
			registerOAuthProvider({
				id: providerId,
				name: "Test",
				login: async () => rotated,
				refreshToken: refresh,
				getApiKey: (credentials) => credentials.access,
			});
			const pending =
				trigger === "expiry"
					? storage.getOAuthApiKey(providerId)
					: storage.recoverRejectedOAuthApiKey(providerId, "original");
			const result = await pending.catch((error: unknown) => error);
			expect(refresh).toHaveBeenCalledTimes(1);
			const persisted = JSON.parse(readFileSync(path, "utf8"));
			if (action.endsWith("logout")) {
				expect(result).toBeUndefined();
				expect(persisted[providerId]).toBeUndefined();
			} else if (action.endsWith("replacement")) {
				expect(result).toBeUndefined();
				expect(persisted[providerId]).toEqual({ type: "api_key", key: "manual" });
			} else if (action === "metadata-only-valid") {
				expect(result).toBe(trigger === "expiry" ? "original" : undefined);
				expect(persisted[providerId]).toMatchObject({
					access: "original",
					refresh: "original-refresh",
					clientId: "client-b",
				});
			} else if (action === "sibling" || action === "same-token-metadata") {
				expect(result).toBe("sibling");
				expect(persisted[providerId].access).toBe("sibling");
				if (action === "same-token-metadata") expect(persisted[providerId].clientId).toBe("client-b");
			} else if (
				action === "expired-sibling" ||
				action === "provider-failure" ||
				action === "metadata-only-expired" ||
				action === "expires-on-salvage-release"
			) {
				if (trigger === "expiry") expect(result).toBeInstanceOf(OAuthCredentialUnusableError);
				else expect(result).toBeUndefined();
				expect(persisted[providerId].refresh).toBe(
					action === "expired-sibling" || action === "expires-on-salvage-release"
						? "sibling-refresh"
						: "original-refresh",
				);
				if (action === "metadata-only-expired") expect(persisted[providerId].clientId).toBe("client-b");
			} else if (action === "second-compromise") {
				expect(result).toBeInstanceOf(Error);
				expect(persisted[providerId]).toEqual(original);
			} else {
				expect(result).toBe("rotated");
				expect(persisted[providerId]).toMatchObject(rotated);
				if (action.endsWith("unrelated")) {
					expect(persisted.other).toEqual({ type: "api_key", key: "other-key" });
					expect(storage.get("other")).toEqual(persisted.other);
				}
			}
			expect(storage.get(providerId)).toEqual(persisted[providerId]);
			expect(transactions).toBeLessThanOrEqual(3);
		});
	}
});
