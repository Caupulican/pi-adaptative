import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "../src/utils/oauth/anthropic.ts";

// Scope tests observe the authorization URL and real Response bodies. Socket
// behavior remains covered by the adjacent localhost callback regressions.
vi.mock("node:http", () => ({
	createServer: () => ({
		on: vi.fn(),
		listen: (_port: number, _host: string, ready: () => void) => queueMicrotask(ready),
		close: vi.fn(),
	}),
}));

const baseScopes = [
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
	"user:plugins",
];
const originalScopes = [
	"user:inference",
	"user:projects:read",
	"user:projects:write",
	"user:design:read",
	"user:design:write",
	"retired:scope",
];
const credentials = { access: "old-access", refresh: "original-refresh", expires: 0, scopes: originalScopes };
const response = {
	access_token: "new-access",
	refresh_token: "rotated-refresh",
	expires_in: 3600,
	scope: "user:inference user:plugins",
};

afterEach(() => vi.unstubAllGlobals());

describe("Claude OAuth scope workflow", () => {
	it("requests plugin access at login and retains the granted scopes", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
		let authorization = new URL("https://unused.invalid");
		const result = await loginAnthropic({
			onAuth: ({ url }) => {
				authorization = new URL(url);
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => `code#${authorization.searchParams.get("state")}`,
		});
		expect(authorization.searchParams.get("scope")?.split(" ")).toEqual(["org:create_api_key", ...baseScopes]);
		expect(result.scopes).toEqual(["user:inference", "user:plugins"]);
	});

	it("migrates first-party inference scopes while preserving project grants", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json(response));
		vi.stubGlobal("fetch", fetchMock);
		const result = await anthropicOAuthProvider.refreshToken(credentials);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.scope.split(" ")).toEqual([
			...baseScopes,
			"user:projects:read",
			"user:projects:write",
			"user:design:read",
			"user:design:write",
		]);
		expect(body.refresh_token).toBe("original-refresh");
		expect(result.scopes).toEqual(["user:inference", "user:plugins"]);
		expect(result.refresh).toBe("rotated-refresh");
		expect(credentials.scopes).toEqual(originalScopes);
	});

	it("retains custom-client identity and scopes without first-party migration", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json(response));
		vi.stubGlobal("fetch", fetchMock);
		const result = await anthropicOAuthProvider.refreshToken({ ...credentials, clientId: "custom-client" });
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.client_id).toBe("custom-client");
		expect(body.scope).toBe(originalScopes.join(" "));
		expect(result.clientId).toBe("custom-client");
	});

	it.each(["invalid_scope", { type: "invalid_scope", message: "secret-provider-description" }])(
		"retries a rejected migration once with the original grants: %j",
		async (error) => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(Response.json({ error }, { status: 400 }))
				.mockResolvedValueOnce(Response.json(response));
			vi.stubGlobal("fetch", fetchMock);
			const result = await anthropicOAuthProvider.refreshToken(credentials);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			const first = JSON.parse(fetchMock.mock.calls[0][1].body);
			const second = JSON.parse(fetchMock.mock.calls[1][1].body);
			expect(first.scope).toBe(
				[...baseScopes, "user:projects:read", "user:projects:write", "user:design:read", "user:design:write"].join(
					" ",
				),
			);
			expect(second).toEqual({ ...first, scope: originalScopes.join(" ") });
			expect(result.access).toBe("new-access");
		},
	);

	it.each([
		[400, "invalid_grant", undefined],
		[401, "invalid_scope", undefined],
		[500, "invalid_scope", undefined],
		[400, "invalid_scope", "custom-client"],
	])("does not retry status %i/error %s/client %s", async (status, error, clientId) => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => Response.json({ error, error_description: "secret-error" }, { status }));
		vi.stubGlobal("fetch", fetchMock);
		const result = anthropicOAuthProvider.refreshToken({ ...credentials, clientId });
		await expect(result).rejects.toThrow(`HTTP ${status}`);
		await expect(result).rejects.not.toThrow("secret-error");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("stops after the original-scope retry also fails", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => Response.json({ error: "invalid_scope" }, { status: 400 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(anthropicOAuthProvider.refreshToken(credentials)).rejects.toThrow("HTTP 400");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not claim the requested scope set when the server omits scope", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ access_token: "access", expires_in: 3600 })));
		const result = await anthropicOAuthProvider.refreshToken(credentials);
		expect(result.scopes).toEqual([]);
		expect(result.refresh).toBe("original-refresh");
	});

	it("preserves non-inference grants without migration or invalid-scope fallback", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "invalid_scope" }, { status: 400 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(anthropicOAuthProvider.refreshToken({ ...credentials, scopes: ["user:profile"] })).rejects.toThrow(
			"HTTP 400",
		);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).scope).toBe("user:profile");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ scopes: "user:inference" },
		{ scopes: ["user:inference", 3] },
		{ scopes: [" "] },
		{ clientId: 3 },
		{ clientId: " " },
	])("rejects malformed stored scope/client metadata before sending: %j", async (metadata) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(anthropicOAuthProvider.refreshToken({ ...credentials, ...metadata })).rejects.toThrow(
			"stored OAuth",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["pre-request", "after-error-body"])("honors cancellation at %s", async (stage) => {
		const controller = new AbortController();
		const cancelled = new Error("scope refresh cancelled");
		const fetchMock = vi.fn(async () => {
			const rejected = Response.json({ error: "invalid_scope" }, { status: 400 });
			const read = rejected.json.bind(rejected);
			vi.spyOn(rejected, "json").mockImplementation(async () => {
				const result: unknown = await read();
				controller.abort(cancelled);
				return result;
			});
			return rejected;
		});
		vi.stubGlobal("fetch", fetchMock);
		if (stage === "pre-request") controller.abort(cancelled);
		await expect(
			refreshAnthropicToken(credentials.refresh, { ...credentials, signal: controller.signal }),
		).rejects.toBe(cancelled);
		expect(fetchMock).toHaveBeenCalledTimes(stage === "pre-request" ? 0 : 1);
	});

	it.each(["malformed", "throwing"])("does not use %s error-body text to authorize retry", async (kind) => {
		const rejected = new Response("secret-invalid_scope-body", { status: 400 });
		if (kind === "throwing") vi.spyOn(rejected, "json").mockRejectedValue(new Error("secret-invalid_scope-parser"));
		const fetchMock = vi.fn().mockResolvedValue(rejected);
		vi.stubGlobal("fetch", fetchMock);
		const result = anthropicOAuthProvider.refreshToken(credentials);
		await expect(result).rejects.toThrow("HTTP 400");
		await expect(result).rejects.not.toThrow("secret-invalid_scope");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
