import { type OAuthCredentials, registerOAuthProvider, unregisterOAuthProvider } from "@caupulican/pi-ai/oauth";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage, type AuthStorageBackend } from "../src/core/auth-storage.ts";

const providerId = "oauth-refresh-publication-test";

class ControlledCommitBackend implements AuthStorageBackend {
	value: string;
	readonly proposed = Promise.withResolvers<void>();
	readonly commit = Promise.withResolvers<void>();
	afterCommit?: () => void | Promise<void>;
	constructor(expires: number) {
		this.value = JSON.stringify({
			[providerId]: { type: "oauth", access: "stored", refresh: "stored-refresh", expires },
		});
	}
	withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) this.value = next;
		return result;
	}
	async withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> {
		const { result, next } = await fn(this.value);
		this.proposed.resolve();
		await this.commit.promise;
		if (next !== undefined) this.value = next;
		await this.afterCommit?.();
		return result;
	}
}

afterEach(() => unregisterOAuthProvider(providerId));

describe("OAuth refresh publication follows backend commit", () => {
	it.each([
		["expiry", "logout"],
		["expiry", "replacement"],
		["expiry", "reload"],
		["rejection", "logout"],
		["rejection", "replacement"],
		["rejection", "reload"],
	])("does not return superseded %s credentials after %s during release", async (trigger, action) => {
		const refreshed = { access: "rotated", refresh: "rotated-refresh", expires: Date.now() + 60_000 };
		registerOAuthProvider({
			id: providerId,
			name: "Test",
			login: async () => refreshed,
			refreshToken: async () => refreshed,
			getApiKey: (credentials) => credentials.access,
		});
		const backend = new ControlledCommitBackend(trigger === "expiry" ? 0 : Date.now() + 60_000);
		const storage = AuthStorage.fromStorage(backend);
		backend.afterCommit = () => {
			if (action === "logout") storage.logout(providerId);
			else if (action === "reload") {
				backend.withLock(() => ({
					result: undefined,
					next: JSON.stringify({ [providerId]: { type: "api_key", key: "replacement-key" } }),
				}));
				storage.reload();
			} else storage.set(providerId, { type: "api_key", key: "replacement-key" });
		};
		const pending =
			trigger === "expiry"
				? storage.getOAuthApiKey(providerId)
				: storage.recoverRejectedOAuthApiKey(providerId, "stored");
		await backend.proposed.promise;
		backend.commit.resolve();
		expect(await pending).toBeUndefined();
		if (action === "logout") expect(storage.get(providerId)).toBeUndefined();
		else expect(storage.get(providerId)).toEqual({ type: "api_key", key: "replacement-key" });
	});

	it("publishes a committed rotation while preserving an unrelated provider replacement", async () => {
		const refreshed = { access: "rotated", refresh: "rotated-refresh", expires: Date.now() + 60_000 };
		registerOAuthProvider({
			id: providerId,
			name: "Test",
			login: async () => refreshed,
			refreshToken: async () => refreshed,
			getApiKey: (credentials) => credentials.access,
		});
		const backend = new ControlledCommitBackend(0);
		const storage = AuthStorage.fromStorage(backend);
		backend.afterCommit = () => {
			storage.set("unrelated", { type: "api_key", key: "other-key" });
		};
		const pending = storage.getOAuthApiKey(providerId);
		await backend.proposed.promise;
		backend.commit.resolve();
		expect(await pending).toBe("rotated");
		expect(storage.get(providerId)).toMatchObject(refreshed);
		expect(storage.get("unrelated")).toEqual({ type: "api_key", key: "other-key" });
	});

	it.each(["expiry", "rejection"])("preserves a later published rotation during %s release", async (trigger) => {
		let rotations = 0;
		const latest = { access: "rotation-2", refresh: "refresh-2", expires: Date.now() + 60_000 };
		registerOAuthProvider({
			id: providerId,
			name: "Test",
			login: async () => latest,
			refreshToken: async () => ({ ...latest, access: `rotation-${++rotations}` }),
			getApiKey: (credentials) => credentials.access,
		});
		const backend = new ControlledCommitBackend(trigger === "expiry" ? 0 : Date.now() + 60_000);
		const storage = AuthStorage.fromStorage(backend);
		backend.afterCommit = async () => {
			backend.afterCommit = undefined;
			expect(await storage.recoverRejectedOAuthApiKey(providerId, "rotation-1")).toBe("rotation-2");
		};
		const pending =
			trigger === "expiry"
				? storage.getOAuthApiKey(providerId)
				: storage.recoverRejectedOAuthApiKey(providerId, "stored");
		await backend.proposed.promise;
		backend.commit.resolve();
		expect(await pending).toBe(trigger === "expiry" ? "rotation-2" : undefined);
		expect(rotations).toBe(2);
		expect(storage.get(providerId)).toMatchObject(latest);
		expect(JSON.parse(backend.value)[providerId]).toMatchObject(latest);
	});

	it.each(["expiry", "rejection"])("does not expose a pending %s rotation before commit", async (trigger) => {
		const refreshed: OAuthCredentials = {
			access: "rotated",
			refresh: "rotated-refresh",
			expires: Date.now() + 60_000,
		};
		registerOAuthProvider({
			id: providerId,
			name: "Test",
			login: async () => refreshed,
			refreshToken: async () => refreshed,
			getApiKey: (credentials) => credentials.access,
		});
		const backend = new ControlledCommitBackend(trigger === "expiry" ? 0 : Date.now() + 60_000);
		const storage = AuthStorage.fromStorage(backend);
		const pending =
			trigger === "expiry"
				? storage.getOAuthApiKey(providerId)
				: storage.recoverRejectedOAuthApiKey(providerId, "stored");
		await backend.proposed.promise;
		const beforeCommit = storage.get(providerId);
		backend.commit.resolve();
		expect(await pending).toBe("rotated");
		expect(beforeCommit).toMatchObject({ access: "stored", refresh: "stored-refresh" });
		expect(storage.get(providerId)).toMatchObject(refreshed);
		expect(JSON.parse(backend.value)[providerId]).toMatchObject(refreshed);
	});

	it("does not retain a rejected rotation when its backend write fails", async () => {
		const refreshed: OAuthCredentials = {
			access: "uncommitted",
			refresh: "uncommitted-refresh",
			expires: Date.now() + 60_000,
		};
		registerOAuthProvider({
			id: providerId,
			name: "Test",
			login: async () => refreshed,
			refreshToken: async () => refreshed,
			getApiKey: (credentials) => credentials.access,
		});
		const backend = new ControlledCommitBackend(Date.now() + 60_000);
		const storage = AuthStorage.fromStorage(backend);
		const pending = storage.recoverRejectedOAuthApiKey(providerId, "stored");
		const observed = pending.catch((error: unknown) => error);
		await backend.proposed.promise;
		backend.commit.reject(new Error("commit refused"));
		expect(await observed).toBeInstanceOf(Error);
		expect(storage.get(providerId)).toMatchObject({ access: "stored", refresh: "stored-refresh" });
		expect(await storage.getOAuthApiKey(providerId)).toBe("stored");
	});
});
