import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider, unregisterOAuthProvider } from "@caupulican/pi-ai/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.ts";

const providerId = "oauth-file-ownership-test";
const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	unregisterOAuthProvider(providerId);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OAuth refresh ownership across actual file commit and unlock", () => {
	it.each([
		["expiry", "logout"],
		["expiry", "replacement"],
		["expiry", "unrelated"],
		["rejection", "logout"],
		["rejection", "replacement"],
		["rejection", "unrelated"],
	])("respects %s completion after a newer %s write", async (trigger, action) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-oauth-file-ownership-"));
		directories.push(directory);
		const path = join(directory, "auth.json");
		const backend = new FileAuthStorageBackend(path);
		const storage = AuthStorage.fromStorage(backend);
		const refreshed = { access: "rotated", refresh: "rotated-refresh", expires: Date.now() + 60_000 };
		const refresh = vi.fn(async () => refreshed);
		registerOAuthProvider({
			id: providerId,
			name: "Test",
			login: async () => refreshed,
			refreshToken: refresh,
			getApiKey: (credentials) => credentials.access,
		});
		storage.set(providerId, {
			type: "oauth",
			access: "stored",
			refresh: "stored-refresh",
			expires: trigger === "expiry" ? 0 : Date.now() + 60_000,
		});
		// Run the real OS lock, write-temp/rename and unlock first. This hook schedules
		// another successful user write before AuthStorage's awaited continuation.
		const withLockAsync = backend.withLockAsync.bind(backend);
		vi.spyOn(backend, "withLockAsync").mockImplementation(async (fn) => {
			const result = await withLockAsync(fn);
			expect(JSON.parse(readFileSync(path, "utf8"))[providerId]).toMatchObject(refreshed);
			if (action === "logout") storage.logout(providerId);
			else storage.set(action === "replacement" ? providerId : "unrelated", { type: "api_key", key: "new-key" });
			return result;
		});

		const result =
			trigger === "expiry"
				? await storage.getOAuthApiKey(providerId)
				: await storage.recoverRejectedOAuthApiKey(providerId, "stored");
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(storage.drainErrors()).toEqual([]);
		const persisted = JSON.parse(readFileSync(path, "utf8"));
		if (action === "unrelated") {
			expect(result).toBe("rotated");
			expect(storage.get(providerId)).toMatchObject(refreshed);
			expect(persisted[providerId]).toMatchObject(refreshed);
			expect(storage.get("unrelated")).toEqual({ type: "api_key", key: "new-key" });
			expect(persisted.unrelated).toEqual({ type: "api_key", key: "new-key" });
		} else {
			expect(result).toBeUndefined();
			const expected = action === "logout" ? undefined : { type: "api_key", key: "new-key" };
			expect(storage.get(providerId)).toEqual(expected);
			expect(persisted[providerId]).toEqual(expected);
		}
	});
});
