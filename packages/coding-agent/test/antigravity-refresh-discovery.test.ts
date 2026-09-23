import { promises as fsPromises, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthRefreshCompletedError, registerOAuthProvider, unregisterOAuthProvider } from "@caupulican/pi-ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, expect, it, vi } from "vitest";
import { ANTIGRAVITY_CATALOG_VERSION } from "../../ai/src/utils/antigravity.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";

const directories: string[] = [];
const modelCatalog = { "gemini-fixture": { maxTokens: 10000, maxOutputTokens: 1000 } };

afterEach(() => {
	vi.restoreAllMocks();
	unregisterOAuthProvider("completed-refresh-fixture");
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([
	{ trigger: "expiry", failure: "project" },
	{ trigger: "expiry", failure: "catalog" },
	{ trigger: "rejection", failure: "project" },
	{ trigger: "rejection", failure: "catalog" },
])("persists the completed $trigger rotation when $failure discovery fails", async ({ trigger, failure }) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-agy-discovery-"));
	directories.push(directory);
	const path = join(directory, "auth.json");
	const storage = AuthStorage.create(path);
	storage.set("google-antigravity", {
		type: "oauth",
		access: "old-access",
		refresh: "old-refresh",
		expires: trigger === "expiry" ? 0 : Date.now() + 60_000,
		projectId: "previous-project",
		modelCatalog,
		// A current-format catalog: this test is about rotation, not the stale-catalog upgrade.
		catalogVersion: ANTIGRAVITY_CATALOG_VERSION,
	});
	const requests: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input);
		requests.push(url);
		if (url === "https://oauth2.googleapis.com/token") {
			expect(String(init?.body)).toContain("refresh_token=old-refresh");
			return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
		}
		expect(init?.headers).toMatchObject({ Authorization: "Bearer new-access" });
		if (url.endsWith(":loadCodeAssist") && failure !== "project") {
			return Response.json({ cloudaicompanionProject: "new-project" });
		}
		if (url.endsWith(":loadCodeAssist") || url.endsWith(":fetchAvailableModels")) {
			return new Response("discovery unavailable", { status: 503 });
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	const result = await (trigger === "expiry"
		? storage.getOAuthApiKey("google-antigravity")
		: storage.recoverRejectedOAuthApiKey("google-antigravity", "old-access")
	).then(
		(value) => ({ value, error: undefined }),
		(error: unknown) => ({ value: undefined, error }),
	);
	expect(JSON.parse(readFileSync(path, "utf8"))["google-antigravity"]).toMatchObject({
		access: "new-access",
		refresh: "new-refresh",
		projectId: "previous-project",
		modelCatalog,
	});
	// Persistence and error visibility are both required. The auth error queue has
	// no production consumer, so merely queuing the discovery failure is insufficient.
	expect(result.error).toMatchObject({
		name: "OAuthRefreshCompletedError",
		message: "OAuth refresh for google-antigravity completed, but account discovery failed",
	});
	expect(result.value).toBeUndefined();
	expect(storage.drainErrors().map((error) => error.message)).toEqual([
		"OAuth refresh for google-antigravity completed, but account discovery failed",
	]);
	expect(await AuthStorage.create(path).getOAuthApiKey("google-antigravity")).toBe("new-access");
	expect(requests.filter((url) => url === "https://oauth2.googleapis.com/token")).toHaveLength(1);
	expect(requests).toHaveLength(failure === "project" ? 2 : 3);
});

it("still persists a successful discovery and reports no warning", async () => {
	const storage = AuthStorage.inMemory({
		"google-antigravity": { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 },
	});
	const request = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(
			Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		)
		.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "new-project" }))
		.mockResolvedValueOnce(
			Response.json({ models: modelCatalog, agentModelSorts: [{ groups: [{ modelIds: ["gemini-fixture"] }] }] }),
		);
	expect(await storage.getOAuthApiKey("google-antigravity")).toBe("new-access");
	expect(storage.get("google-antigravity")).toMatchObject({ projectId: "new-project", modelCatalog });
	expect(storage.drainErrors()).toEqual([]);
	expect(request).toHaveBeenCalledTimes(3);
});

it("does not salvage a failed token exchange", async () => {
	const previous = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: 0 };
	const storage = AuthStorage.inMemory({ "google-antigravity": previous });
	const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("invalid grant", { status: 400 }));
	await expect(storage.getOAuthApiKey("google-antigravity")).rejects.toThrow("could not be refreshed");
	expect(storage.get("google-antigravity")).toEqual(previous);
	expect(request).toHaveBeenCalledTimes(1);
});

for (const trigger of ["expiry", "rejection"]) {
	it.each(["compromise", "logout", "replacement", "write-failure"])(
		`${trigger} discovery failure respects %s at the storage boundary`,
		async (action) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-agy-discovery-race-"));
			directories.push(directory);
			const path = join(directory, "auth.json");
			const storage = AuthStorage.create(path);
			const previous = {
				type: "oauth" as const,
				access: "old-access",
				refresh: "old-refresh",
				expires: trigger === "expiry" ? 0 : Date.now() + 60_000,
				projectId: "previous-project",
				modelCatalog,
			};
			storage.set("google-antigravity", previous);
			const originalLock = lockfile.lock.bind(lockfile);
			let compromise: ((error: Error) => void) | undefined;
			const locks = vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
				compromise = options?.onCompromised;
				const release = await originalLock(file, options);
				return async () => {
					await release();
					if (action === "logout") storage.logout("google-antigravity");
					if (action === "replacement") storage.set("google-antigravity", { type: "api_key", key: "manual" });
				};
			});
			if (action === "write-failure") {
				vi.spyOn(fsPromises, "rename").mockRejectedValue(new Error("credential commit failed"));
			}
			const request = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(
					Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
				)
				.mockImplementationOnce(async () => {
					if (action === "compromise") compromise?.(new Error("lost lock during discovery"));
					return new Response("unavailable", { status: 503 });
				});
			const result = await (trigger === "expiry"
				? storage.getOAuthApiKey("google-antigravity")
				: storage.recoverRejectedOAuthApiKey("google-antigravity", "old-access")
			).catch((error: unknown) => error);
			const persisted = JSON.parse(readFileSync(path, "utf8"))["google-antigravity"];
			if (action === "compromise") {
				expect(result).toMatchObject({ name: "OAuthRefreshCompletedError" });
				expect(persisted).toMatchObject({ access: "new-access", refresh: "new-refresh" });
				expect(locks).toHaveBeenCalledTimes(2);
			} else if (action === "write-failure") {
				expect(result).toBeInstanceOf(Error);
				expect(String(result)).toContain("credential commit failed");
				expect(persisted).toEqual(previous);
			} else {
				expect(result).toBeUndefined();
				expect(persisted).toEqual(action === "logout" ? undefined : { type: "api_key", key: "manual" });
			}
			expect(storage.get("google-antigravity")).toEqual(persisted);
			expect(request).toHaveBeenCalledTimes(2);
		},
	);
}

it.each(["wrong-provider", "untyped"])("rejects a %s completion claim without writing credentials", async (kind) => {
	const providerId = "completed-refresh-fixture";
	const previous = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: 0 };
	const rotated = { access: "foreign-access", refresh: "foreign-refresh", expires: Date.now() + 60_000 };
	registerOAuthProvider({
		id: providerId,
		name: "Fixture",
		login: async () => previous,
		refreshToken: async () => {
			if (kind === "wrong-provider")
				throw new OAuthRefreshCompletedError("another-provider", rotated, new Error("failed"));
			throw Object.assign(new Error("untyped"), {
				name: "OAuthRefreshCompletedError",
				providerId,
				credentials: rotated,
			});
		},
		getApiKey: (credentials) => credentials.access,
	});
	const storage = AuthStorage.inMemory({ [providerId]: previous });
	await expect(storage.getOAuthApiKey(providerId)).rejects.toBeInstanceOf(Error);
	expect(storage.get(providerId)).toEqual(previous);
});
