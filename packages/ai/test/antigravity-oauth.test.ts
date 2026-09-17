import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiProvider } from "../src/api-registry.ts";
import { ANTIGRAVITY_ENDPOINT, antigravityHeaders, parseAntigravityModels } from "../src/utils/antigravity.ts";
import "../src/providers/register-builtins.ts";
import { antigravityOAuthProvider as provider } from "../src/utils/oauth/google-antigravity.ts";
import type { OAuthLoginCallbacks } from "../src/utils/oauth/types.ts";

const catalog = {
	"gemini-3-flash": {
		displayName: "Gemini",
		maxTokens: 10000,
		maxOutputTokens: 1000,
		supportsThinking: true,
		quotaInfo: { private: "not-persisted" },
	},
};
function mockDiscovery(
	token: unknown = { access_token: "access-fixture", refresh_token: "refresh-fixture", expires_in: 3600 },
) {
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(Response.json(token))
		.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: { id: "project-fixture" } }))
		.mockResolvedValueOnce(
			Response.json({ models: catalog, agentModelSorts: [{ groups: [{ modelIds: ["gemini-3-flash"] }] }] }),
		);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}
function callbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
	return {
		onAuth: vi.fn(),
		onDeviceCode: vi.fn(),
		onSelect: vi.fn(),
		onPrompt: vi.fn().mockResolvedValue("code-fixture"),
		...overrides,
	};
}
afterEach(() => vi.unstubAllGlobals());

describe("Antigravity subscription login", () => {
	it("owns a separate transport and the CLI service endpoint", () => {
		expect(getApiProvider("google-antigravity")).toBeDefined();
		expect(getApiProvider("google-antigravity")).not.toBe(getApiProvider("anthropic-messages"));
		expect(ANTIGRAVITY_ENDPOINT).toBe("https://daily-cloudcode-pa.googleapis.com");
	});
	it.each([
		["win32", "x64", "windows", "amd64"],
		["linux", "arm64", "linux", "arm64"],
		["darwin", "x64", "darwin", "amd64"],
	])("uses runtime-specific CLI headers on %s/%s", (platform, arch, osType, architecture) => {
		const headers = antigravityHeaders("fixture", { platform, arch });
		expect(headers["User-Agent"]).toContain("antigravity/cli/1.2.4");
		expect(headers["User-Agent"]).toContain(`os_type=${osType}; arch=${architecture}`);
		expect(headers["User-Agent"]).toContain("auth_method=consumer");
	});
	it("uses the hosted redirect and independent PKCE/state, persisting only model capabilities", async () => {
		const fetchMock = mockDiscovery();
		let authorization: URL | undefined;
		const credentials = await provider.login(
			callbacks({
				onAuth: ({ url }) => {
					authorization = new URL(url);
				},
				onPrompt: async () =>
					`https://antigravity.google/oauth-callback?code=code-fixture&state=${authorization?.searchParams.get("state")}`,
			}),
		);
		const params = authorization?.searchParams;
		expect(authorization?.origin).toBe("https://accounts.google.com");
		expect(params?.get("redirect_uri")).toBe("https://antigravity.google/oauth-callback");
		expect(params?.get("scope")?.split(" ")).toContain("openid");
		expect(params?.get("code_challenge_method")).toBe("S256");
		const fields = fetchMock.mock.calls[0][1].body as URLSearchParams;
		expect(fields.get("redirect_uri")).toBe(params?.get("redirect_uri"));
		expect(fields.get("code_verifier")).not.toBe(params?.get("state"));
		expect(params?.get("code_challenge")).not.toBe(params?.get("state"));
		expect(credentials.projectId).toBe("project-fixture");
		expect(JSON.stringify(credentials.modelCatalog)).not.toContain("quotaInfo");
		expect(provider.modifyModels?.([], credentials)).toHaveLength(1);
		expect(provider.getApiKey(credentials)).toBe("access-fixture");
	});

	it("rejects mismatched callback state before token exchange", async () => {
		const fetchMock = mockDiscovery();
		await expect(provider.login(callbacks({ onPrompt: async () => "code=fixture&state=wrong" }))).rejects.toThrow(
			"state",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("preserves an omitted refresh token and refreshes model discovery", async () => {
		mockDiscovery({ access_token: "next-access", expires_in: 3600 });
		const result = await provider.refreshToken({ access: "old", refresh: "retained-refresh", expires: 0 });
		expect(result.refresh).toBe("retained-refresh");
		expect(result.access).toBe("next-access");
		expect(result.expires).toBeGreaterThan(Date.now());
		expect(result.modelCatalog).toBeDefined();
	});
	it("only exposes models advertised for agent use, not every internal runtime", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }))
			.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "project" }))
			.mockResolvedValueOnce(
				Response.json({
					models: { ...catalog, "gemini-hidden": catalog["gemini-3-flash"] },
					agentModelSorts: [{ groups: [{ modelIds: ["gemini-3-flash"] }] }],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const credentials = await provider.login(callbacks());
		expect(provider.modifyModels?.([], credentials).map((model) => model.id)).toEqual(["gemini-3-flash"]);
	});

	it.each([
		{},
		{ access_token: "secret", refresh_token: "refresh", expires_in: -1 },
		{ access_token: "secret", refresh_token: "refresh", expires_in: 1e308 },
	])("rejects malformed token responses without exposing their values: %j", async (token) => {
		const fetchMock = mockDiscovery(token);
		await expect(provider.login(callbacks())).rejects.toThrow("invalid OAuth credentials");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not invent a project or onboard an inaccessible account", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }))
			.mockResolvedValueOnce(Response.json({ ineligibleTiers: [{ reasonCode: "UNSUPPORTED_CLIENT" }] }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(provider.login(callbacks())).rejects.toThrow("accessible project");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("cancels an unresolved prompt without exchanging a late code", async () => {
		const controller = new AbortController();
		const fetchMock = mockDiscovery();
		let resolveInput: (value: string) => void = () => {};
		const input = new Promise<string>((resolve) => {
			resolveInput = resolve;
		});
		const result = provider.login(
			callbacks({
				signal: controller.signal,
				onPrompt: () => {
					controller.abort();
					return input;
				},
			}),
		);
		const settled = await Promise.race([
			result.then(
				() => "resolved",
				() => "aborted",
			),
			new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 25)),
		]);
		resolveInput("late-code");
		await expect(result).rejects.toThrow();
		expect(settled).toBe("aborted");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects an already aborted login before opening authorization", async () => {
		const options = callbacks({ signal: AbortSignal.abort() });
		await expect(provider.login(options)).rejects.toThrow();
		expect(options.onAuth).not.toHaveBeenCalled();
	});

	it("bounds the catalog and excludes unsupported routes and invalid limits", () => {
		expect(
			parseAntigravityModels({
				...catalog,
				"claude-sonnet": catalog["gemini-3-flash"],
				"gemini-image": catalog["gemini-3-flash"],
				"gemini-invalid": { maxTokens: 10, maxOutputTokens: 11 },
			}),
		).toHaveLength(1);
		expect(() =>
			parseAntigravityModels(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`gemini-${i}`, {}]))),
		).toThrow("size limit");
		expect(() => parseAntigravityModels([])).toThrow("Invalid");
	});
});
