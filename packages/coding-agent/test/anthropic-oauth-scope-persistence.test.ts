import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Anthropic scope metadata across durable credential refreshes", () => {
	it.each([
		{ lifetime: 1, elapsed: 250 },
		{ lifetime: 60, elapsed: 10000 },
		{ lifetime: 3600, elapsed: 10000 },
	])("reuses a valid $lifetime-second token before refreshing after expiry", async ({ lifetime, elapsed }) => {
		let now = 2_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const storage = AuthStorage.inMemory({
			anthropic: { type: "oauth", access: "expired", refresh: "refresh", expires: 0 },
		});
		let requests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					access_token: `access-${++requests}`,
					refresh_token: "refresh",
					expires_in: lifetime,
				}),
			),
		);
		expect(await storage.getOAuthApiKey("anthropic")).toBe("access-1");
		now += elapsed;
		expect(await storage.getOAuthApiKey("anthropic")).toBe("access-1");
		expect(requests).toBe(1);
		now = 2_000_000 + lifetime * 1000;
		expect(await storage.getOAuthApiKey("anthropic")).toBe("access-2");
		expect(requests).toBe(2);
	});

	it.each([undefined, "custom-client"])("retains the granted scope and client %s across reload", async (clientId) => {
		const now = Date.now();
		const directory = mkdtempSync(join(tmpdir(), "pi-anthropic-scopes-"));
		directories.push(directory);
		const path = join(directory, "auth.json");
		const first = AuthStorage.create(path);
		first.set("anthropic", {
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			scopes: ["user:inference", "retired:scope"],
			...(clientId ? { clientId } : {}),
		});
		let calls = 0;
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({
				access_token: `access-${++calls}`,
				refresh_token: `refresh-${calls}`,
				expires_in: 3600,
				scope: "user:inference user:projects:read",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		expect(await first.getOAuthApiKey("anthropic")).toBe("access-1");
		expect(JSON.parse(readFileSync(path, "utf8")).anthropic).toMatchObject({
			scopes: ["user:inference", "user:projects:read"],
			refresh: "refresh-1",
			...(clientId ? { clientId } : {}),
		});
		vi.spyOn(Date, "now").mockReturnValue(now + 3_600_000);
		const reloaded = AuthStorage.create(path);
		expect(await reloaded.getOAuthApiKey("anthropic")).toBe("access-2");
		const secondRequest = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
		expect(secondRequest.refresh_token).toBe("refresh-1");
		expect(secondRequest.client_id).toBe(clientId ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
		expect(secondRequest.scope).toContain("user:projects:read");
		expect(secondRequest.scope).not.toContain("retired:scope");
		if (clientId) expect(secondRequest.scope).toBe("user:inference user:projects:read");
		else expect(secondRequest.scope).toContain("user:plugins");
		expect(calls).toBe(2);
	});
});
