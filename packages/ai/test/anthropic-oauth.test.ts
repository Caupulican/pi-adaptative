import { get } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import {
	ANTHROPIC_OAUTH_PROTOCOL,
	PACKAGED_ANTHROPIC_IDENTITY,
	REVIEWED_CLAUDE_INSTALLATIONS,
} from "../src/providers/anthropic-compatibility-profile.ts";
import { resolveAnthropicOAuthAuthentication } from "../src/providers/anthropic-oauth-headers.ts";
import type { Model } from "../src/types.ts";
import { anthropicOAuthProvider, loginAnthropic } from "../src/utils/oauth/anthropic.ts";
import { startAnthropicCallback } from "../src/utils/oauth/anthropic-callback.ts";

vi.mock("../src/providers/anthropic-identity.ts", () => ({
	resolveAnthropicCompatibility: async () => ({
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
		identity: PACKAGED_ANTHROPIC_IDENTITY,
	}),
}));
beforeEach(() => {
	vi.stubEnv("PI_OAUTH_CALLBACK_HOST", "127.0.0.1");
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function browserRequest(redirect: string, params: Record<string, string>) {
	const url = new URL(redirect);
	url.search = new URLSearchParams(params).toString();
	return new Promise<{ status: number | undefined; page: string }>((resolve, reject) => {
		get(url, { family: 4 }, (response) => {
			let page = "";
			response.setEncoding("utf8").on("data", (chunk) => {
				page += chunk;
			});
			response.once("error", reject);
			response.once("end", () => resolve({ status: response.statusCode, page }));
		}).once("error", reject);
	});
}

const tokens = () => Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });

describe("Claude refresh scope migration", () => {
	const stored = {
		access: "old-access",
		refresh: "old-refresh",
		expires: 0,
		scopes: [
			"user:inference",
			"user:design:read",
			"user:projects:write",
			"user:design:write",
			"user:privacy_consents:write",
		],
	};
	const migrated = [...ANTHROPIC_OAUTH_PROTOCOL.inferenceScopes, "user:projects:write", "user:privacy_consents:write"];

	it("requests and records the migrated scopes when the response omits scope", async () => {
		const post = vi.fn<typeof fetch>().mockResolvedValue(tokens());
		vi.stubGlobal("fetch", post);
		const credentials = await anthropicOAuthProvider.refreshToken(stored);
		expect(JSON.parse(String(post.mock.calls[0]![1]?.body)).scope).toBe(migrated.join(" "));
		expect(credentials.scopes).toEqual(migrated);
		expect(post).toHaveBeenCalledTimes(1);
	});

	it("uses the original grants when retrying a rejected migration", async () => {
		const post = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ error: "invalid_scope" }, { status: 400 }))
			.mockResolvedValueOnce(tokens());
		vi.stubGlobal("fetch", post);
		const credentials = await anthropicOAuthProvider.refreshToken(stored);
		expect(post.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).scope)).toEqual([
			migrated.join(" "),
			stored.scopes.join(" "),
		]);
		expect(credentials.scopes).toEqual(stored.scopes);
	});

	it("preserves the stored Design grants for an explicit client", async () => {
		const post = vi.fn<typeof fetch>().mockResolvedValue(tokens());
		vi.stubGlobal("fetch", post);
		const credentials = await anthropicOAuthProvider.refreshToken({ ...stored, clientId: "custom-client" });
		expect(JSON.parse(String(post.mock.calls[0]![1]?.body))).toMatchObject({
			client_id: "custom-client",
			scope: stored.scopes.join(" "),
		});
		expect(credentials.scopes).toEqual(stored.scopes);
	});
});

describe("Claude request authentication ownership", () => {
	it("uses stored credential authority and only a prefix check for raw overrides", () => {
		const context = anthropicOAuthProvider.getRequestContext!({
			access: "opaque-access-token",
			refresh: "opaque-refresh-token",
			expires: Date.now() + 60_000,
		});
		expect(resolveAnthropicOAuthAuthentication(context, "opaque-access-token")).toBe(true);
		expect(resolveAnthropicOAuthAuthentication(undefined, "sk-ant-oat01-raw-override")).toBe(true);
		expect(resolveAnthropicOAuthAuthentication(undefined, "api-key-containing-sk-ant-oat-inside")).toBe(false);
		expect(() => resolveAnthropicOAuthAuthentication({ provider: "anthropic" }, "opaque-access-token")).toThrow(
			"Invalid Anthropic account session",
		);
	});

	it("keeps stored OAuth authoritative over a bearer compatibility override", async () => {
		const requests: Request[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init));
			const events = [
				{
					type: "message_start",
					message: { id: "oauth-owner", usage: { input_tokens: 1, output_tokens: 0 } },
				},
				{ type: "message_stop" },
			];
			return new Response(
				events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		});
		const oauthModel: Model<"anthropic-messages"> = {
			id: "oauth-owner",
			name: "OAuth owner",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://unused.invalid",
			reasoning: false,
			input: ["text"],
			contextWindow: 1000,
			maxTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { authFormat: "bearer" },
		};
		await streamAnthropic(
			oauthModel,
			{ messages: [] },
			{
				apiKey: "opaque-access-token",
				providerRequestContext: anthropicOAuthProvider.getRequestContext!({
					access: "opaque-access-token",
					refresh: "opaque-refresh-token",
					expires: Date.now() + 60_000,
				}),
			},
		).result();

		expect(requests).toHaveLength(1);
		expect(requests[0]!.headers.get("authorization")).toBe("Bearer opaque-access-token");
		expect(requests[0]!.headers.get("x-api-key")).toBeNull();
		expect(requests[0]!.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
	});
});

describe("Claude authorization", () => {
	it("keeps two active callback listeners on independent OS-assigned ports", async () => {
		const one = await startAnthropicCallback("first");
		try {
			const two = await startAnthropicCallback("second");
			try {
				expect(new URL(one.redirectUri).port).not.toBe(new URL(two.redirectUri).port);
			} finally {
				two.finish(false);
			}
		} finally {
			one.finish(false);
		}
	});

	it.each([true, false])("holds the browser response through token exchange (success %s)", async (success) => {
		const started = Promise.withResolvers<void>();
		const exchange = Promise.withResolvers<Response>();
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
			started.resolve();
			return exchange.promise;
		});
		vi.stubGlobal("fetch", fetchMock);
		let browser!: Promise<{ status: number | undefined; page: string }>;
		let received = false;
		let redirect = "";
		let state = "";
		const login = loginAnthropic({
			onAuth: ({ url }) => {
				const params = new URL(url).searchParams;
				redirect = params.get("redirect_uri")!;
				state = params.get("state")!;
				browser = browserRequest(redirect, { state, code: "first" }).then((result) => {
					received = true;
					return result;
				});
			},
			onPrompt: vi.fn(),
		});
		await started.promise;
		const duplicate = await browserRequest(redirect, { state, code: "second" });
		expect(duplicate.page).toContain("already finishing");
		expect(received).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
			code: "first",
			state,
			redirect_uri: redirect,
		});
		exchange.resolve(success ? tokens() : new Response(null, { status: 400 }));
		if (success) await expect(login).resolves.toMatchObject({ access: "access" });
		else await expect(login).rejects.toThrow("HTTP 400");
		const response = await browser;
		expect(response.status).toBe(success ? 200 : 400);
		expect(response.page).toContain(success ? "Authentication successful" : "Authentication failed");
	});

	it.each(["", "incomplete", "https://example.org/sign-in"])(
		"can correct a bad paste (%j) while the listener is available",
		async (first) => {
			const fetchMock = vi.fn().mockResolvedValue(tokens());
			vi.stubGlobal("fetch", fetchMock);
			let state = "";
			const prompt = vi.fn(async () => `manual#${state}`);
			const credentials = await loginAnthropic({
				onAuth: ({ url, manualUrl }) => {
					const automatic = new URL(url).searchParams;
					const manual = new URL(manualUrl!).searchParams;
					state = manual.get("state")!;
					expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
					expect(automatic.get("state")).toBe(state);
					expect(manual.get("code_challenge")).toBe(automatic.get("code_challenge"));
					expect(manual.get("redirect_uri")).toBe(ANTHROPIC_OAUTH_PROTOCOL.manualRedirectUri);
					expect(automatic.get("redirect_uri")).not.toBe(manual.get("redirect_uri"));
				},
				onManualCodeInput: async () => first,
				onPrompt: prompt,
			});
			expect(prompt).toHaveBeenCalledTimes(1);
			expect(credentials.access).toBe("access");
			expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({
				code: "manual",
				state,
				redirect_uri: ANTHROPIC_OAUTH_PROTOCOL.manualRedirectUri,
			});
		},
	);

	it("cancels a claimed browser callback without accepting a late paste", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const pasted = Promise.withResolvers<string>();
		const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
			started.resolve();
			return new Promise((_resolve, reject) =>
				init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		let browser!: ReturnType<typeof browserRequest>;
		let state = "";
		const prompt = vi.fn();
		const login = loginAnthropic({
			signal: controller.signal,
			onAuth: ({ url }) => {
				const params = new URL(url).searchParams;
				state = params.get("state")!;
				browser = browserRequest(params.get("redirect_uri")!, { state, code: "callback" });
			},
			onManualCodeInput: () => pasted.promise,
			onPrompt: prompt,
		});
		await started.promise;
		controller.abort(new Error("cancelled by user"));
		pasted.resolve(`late#${state}`);
		await expect(login).rejects.toThrow("cancelled by user");
		expect((await browser).page).toContain("Authentication failed");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("rejects a manual code belonging to another sign-in", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			loginAnthropic({ onAuth: vi.fn(), onPrompt: vi.fn(), onManualCodeInput: async () => "code#wrong" }),
		).rejects.toThrow("state mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses a digest-reviewed OAuth protocol independently of the packaged request identity", async () => {
		const { AnthropicCompatibilityResolver } = await vi.importActual<
			typeof import("../src/providers/anthropic-identity.ts")
		>("../src/providers/anthropic-identity.ts");
		const current = REVIEWED_CLAUDE_INSTALLATIONS.find((row) => row.version === "2.1.329")!;
		const resolver = new AnthropicCompatibilityResolver({
			inspect: async () => ({ status: "inspected", version: current.version, sha256: current.sha256 }),
		});
		const result = await resolver.resolve("local");
		expect(result.inspection).toBe("reviewed");
		expect(result.oauth).toBe(current.oauth);
		expect(result.identity).toBe(PACKAGED_ANTHROPIC_IDENTITY);
		expect(result.source).toBe("packaged");
	});

	it("requests the privacy grant only for profiles whose interactive login enables it", () => {
		const profiles = new Map(REVIEWED_CLAUDE_INSTALLATIONS.map((review) => [review.version, review.oauth]));
		expect(profiles.get("2.1.323")?.loginScopes).not.toContain("user:privacy_consents:write");
		expect(profiles.get("2.1.326")?.loginScopes).toContain("user:privacy_consents:write");
		expect(profiles.get("2.1.328")).toBe(ANTHROPIC_OAUTH_PROTOCOL);
		expect(profiles.get("2.1.329")).toBe(ANTHROPIC_OAUTH_PROTOCOL);
		expect(profiles.get("2.1.331")).toBe(ANTHROPIC_OAUTH_PROTOCOL);
		expect(ANTHROPIC_OAUTH_PROTOCOL.inferenceScopes).not.toContain("user:privacy_consents:write");
	});
});
