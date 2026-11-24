import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAntigravityCredits } from "../src/providers/antigravity-credits.ts";
import { convertMessages } from "../src/providers/google-shared.ts";
import { ANTIGRAVITY_USAGE_ACCOUNTING, mergeGoogleUsage, projectGoogleUsage } from "../src/providers/google-usage.ts";
import type { AssistantMessage } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";
import {
	ANTIGRAVITY_CATALOG_VERSION,
	antigravityThinkingBudget,
	antigravityThinkingLevel,
	discoverAntigravityAccount,
	parseAntigravityModels,
} from "../src/utils/antigravity.ts";
import { antigravityOAuthProvider } from "../src/utils/oauth/google-antigravity.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Antigravity packaged provider", () => {
	it("replays the first parallel call's signature after a Neon effort switch", () => {
		const [model] = parseAntigravityModels({
			"gemini-4-neon-xhigh": {
				maxTokens: 1048576,
				maxOutputTokens: 65536,
				supportsThinking: true,
				thinkingLevel: 100,
			},
		});
		const reply: AssistantMessage = {
			role: "assistant",
			model: "gemini-4-neon-medium",
			api: model!.api,
			provider: model!.provider,
			timestamp: 1,
			usage: createEmptyUsage(),
			stopReason: "toolUse",
			content: [
				{ type: "toolCall", id: "a", name: "bash", arguments: {}, thoughtSignature: "c2ln" },
				{ type: "toolCall", id: "b", name: "lookup", arguments: {} },
			],
		};
		const signatures = (message: AssistantMessage) =>
			convertMessages(model!, { messages: [message] })[0]?.parts?.map((part) => part.thoughtSignature);
		expect(signatures(reply)).toEqual(["c2ln", undefined]);
		expect(signatures({ ...reply, model: "gemini-4-hydrogen-medium" })).toEqual([
			"skip_thought_signature_validator",
			undefined,
		]);
		expect(signatures({ ...reply, provider: "google" })).toEqual(["skip_thought_signature_validator", undefined]);
		const vertex = { ...model!, api: "google-vertex" as const, provider: "google-vertex" };
		expect(convertMessages(vertex, { messages: [reply] })[0]?.parts?.[0]?.thoughtSignature).toBeUndefined();
	});

	it.each(["code", "callback"])(
		"exchanges a pasted %s and discovers the account with the packaged identity",
		async (form) => {
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(
					Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
				)
				.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "project" }))
				.mockResolvedValueOnce(
					Response.json({
						models: { "gemini-chat": { maxTokens: 32000, maxOutputTokens: 1024 } },
						agentModelSorts: [{ groups: [{ modelIds: ["gemini-chat"] }] }],
					}),
				);
			vi.stubGlobal("fetch", fetchMock);
			let authorization!: URLSearchParams;
			const credentials = await antigravityOAuthProvider.login({
				onAuth: ({ url }) => {
					authorization = new URL(url).searchParams;
				},
				onPrompt: async () =>
					form === "code"
						? "manual-code"
						: `${authorization.get("redirect_uri")}?code=manual-code&state=${authorization.get("state")}`,
				onSelect: async () => undefined,
				onDeviceCode: () => {},
			});
			const submitted = fetchMock.mock.calls[0]![1]?.body as URLSearchParams;
			expect(submitted.get("code")).toBe("manual-code");
			const challenge = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(submitted.get("code_verifier")!),
			);
			expect(authorization.get("code_challenge")).toBe(Buffer.from(challenge).toString("base64url"));
			expect(authorization.get("code_challenge_method")).toBe("S256");
			expect(credentials.projectId).toBe("project");
			expect(antigravityOAuthProvider.needsCredentialUpdate!(credentials)).toBe(false);
			expect(antigravityOAuthProvider.needsCredentialUpdate!({ ...credentials, clientVersion: "1.5.12" })).toBe(
				true,
			);
			expect(antigravityOAuthProvider.getRequestContext!(credentials)).toEqual({ projectId: "project" });
			expect(antigravityOAuthProvider.getAccountId!(credentials)).toBe("project");
		},
	);

	it.each([
		"$callback?code=x",
		"$callback?code=x&state=wrong",
		"$callback?code=x&state=$state&state=$state",
		"$callback?code=x&code=y&state=$state",
		"$callback?code=x&error=access_denied&state=$state",
		"https://other.invalid/oauth-callback?code=x&state=$state",
		"//other.invalid/oauth-callback?foo=bar&code=x&state=$state",
		"https://antigravity.google/other?code=x&state=$state",
		"$callback?code=x&state=$state#fragment",
	])("refuses an invalid pasted callback before token exchange (%s)", async (template) => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		let authorization!: URLSearchParams;
		await expect(
			antigravityOAuthProvider.login({
				onAuth: ({ url }) => {
					authorization = new URL(url).searchParams;
				},
				onSelect: async () => undefined,
				onDeviceCode: () => {},
				onPrompt: async () =>
					template
						.replace("$callback", authorization.get("redirect_uri")!)
						.replaceAll("$state", authorization.get("state")!),
			}),
		).rejects.toThrow("Invalid Antigravity authorization code or state");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rotates and retains the account session without coupling refresh to discovery", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }));
		vi.stubGlobal("fetch", fetchMock);
		const old = {
			access: "old",
			refresh: "old-refresh",
			expires: 1,
			clientVersion: "1.5.12",
			projectId: "project",
			modelCatalog: { "gemini-chat": {} },
		};
		await expect(antigravityOAuthProvider.refreshToken(old)).resolves.toMatchObject({
			access: "fresh",
			refresh: "rotated",
			projectId: "project",
			modelCatalog: old.modelCatalog,
		});
		const submitted = fetchMock.mock.calls[0]![1]?.body as URLSearchParams;
		expect(submitted.get("grant_type")).toBe("refresh_token");
		expect(submitted.get("refresh_token")).toBe("old-refresh");
		expect(old.refresh).toBe("old-refresh");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("updates stale account metadata without rotating the valid token", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "current-project" }))
			.mockResolvedValueOnce(
				Response.json({
					models: { "gemini-chat": { maxTokens: 32000, maxOutputTokens: 1024 } },
					agentModelSorts: [{ groups: [{ modelIds: ["gemini-chat"] }] }],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const old = { access: "still-valid", refresh: "refresh", expires: Date.now() + 3600_000 };
		await expect(antigravityOAuthProvider.updateCredentials!(old)).resolves.toMatchObject({
			access: "still-valid",
			refresh: "refresh",
			projectId: "current-project",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("oauth2.googleapis.com/token"))).toBe(true);
	});

	it("rejects a malformed project before it becomes durable session state", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ cloudaicompanionProject: " project " }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(discoverAntigravityAccount("fixture")).rejects.toThrow("accessible project");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("classifies a rejected refresh token without exposing the response description", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(
					Response.json(
						{ error: "invalid_grant", error_description: "sensitive provider detail" },
						{ status: 400 },
					),
				),
		);
		await expect(
			antigravityOAuthProvider.refreshToken({ access: "old", refresh: "rejected", expires: 1 }),
		).rejects.toMatchObject({
			name: "OAuthRefreshRejectedError",
			providerId: "google-antigravity",
			reason: "rejected",
			message: expect.not.stringContaining("sensitive provider detail"),
		});
	});

	it("discovers new advertised presets from a catalog larger than an ordinary account response", async () => {
		const entry = { maxTokens: 1048576, maxOutputTokens: 262144, supportsThinking: true, thinkingLevel: 100 };
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "project" }))
			.mockResolvedValueOnce(
				Response.json({
					description: "x".repeat(320000),
					models: { "gemini-4-neon-xhigh": entry, "gemini-unlisted": entry },
					agentModelSorts: [{ groups: [{ modelIds: ["gemini-4-neon-xhigh"] }] }],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const account = await discoverAntigravityAccount("fixture");
		expect(account.catalogVersion).toBe(ANTIGRAVITY_CATALOG_VERSION);
		expect(Object.keys(account.modelCatalog as object)).toEqual(["gemini-4-neon-xhigh"]);
		expect(parseAntigravityModels(account.modelCatalog)[0]).toMatchObject({
			id: "gemini-4-neon-xhigh",
			defaultThinkingLevel: "xhigh",
			contextWindow: 1048576,
			maxTokens: 262144,
		});
	});

	it("keeps separate response bounds for project and model discovery", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ description: "x".repeat(262144) }))
				.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "project" }))
				.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1))),
		);
		await expect(discoverAntigravityAccount("fixture")).rejects.toThrow("256 KiB");
		await expect(discoverAntigravityAccount("fixture")).rejects.toThrow("1024 KiB");
	});

	it("retains partial Google counts and projects details without double counting", () => {
		const original = mergeGoogleUsage(undefined, {
			promptTokenCount: 100,
			cachedContentTokenCount: 20,
			candidatesTokenCount: 5,
			thoughtsTokenCount: 2,
			toolUsePromptTokenCount: 3,
		});
		const merged = mergeGoogleUsage(original, {
			toolCallStats: [{ functionName: "lookup", toolCallCount: 2, serverExecuted: true }],
		});
		const usage = projectGoogleUsage(
			merged,
			{
				consumedCredits: parseAntigravityCredits([
					{ creditType: "AI", creditAmount: "7", minimumCreditAmountForUsage: 2 },
				]),
			},
			ANTIGRAVITY_USAGE_ACCOUNTING,
		);
		expect([usage.input, usage.output, usage.cacheRead, usage.totalTokens]).toEqual([80, 7, 20, 107]);
		expect(usage.details?.toolCalls?.[0]?.count).toBe(2);
		expect(usage.details?.consumedCredits?.[0]?.amount).toBe(7);
		expect(original.toolCallStats).toBeUndefined();
		const reduced = mergeGoogleUsage(original, { promptTokenCount: 10 });
		expect(reduced.promptTokenCount).toBe(10);
		expect(reduced.cachedContentTokenCount).toBe(20);
		expect(reduced.toolUsePromptTokenCount).toBe(3);
		const reducedUsage = projectGoogleUsage(reduced, {}, ANTIGRAVITY_USAGE_ACCOUNTING);
		expect([reducedUsage.input, reducedUsage.output, reducedUsage.cacheRead, reducedUsage.totalTokens]).toEqual([
			0, 7, 20, 27,
		]);
	});

	it("keeps adaptive presets and GPT-OSS Medium budget mutually exclusive", () => {
		const models = parseAntigravityModels({
			"claude-local-high": {
				maxTokens: 100000,
				maxOutputTokens: 1000,
				supportsThinking: true,
				supportsAdaptiveThinking: true,
				thinkingLevel: 3,
			},
			"gpt-oss-local-medium": {
				maxTokens: 100000,
				maxOutputTokens: 1000,
				supportsThinking: true,
				thinkingBudget: 8192,
			},
		});
		expect(models).toHaveLength(2);
		expect(antigravityThinkingLevel(models[0]!)).toBe(3);
		expect(antigravityThinkingBudget(models[0]!)).toBeUndefined();
		expect(models[1]?.defaultThinkingLevel).toBe("medium");
		expect(antigravityThinkingBudget(models[1]!)).toBe(8192);
		expect(antigravityThinkingLevel(models[1]!)).toBeUndefined();
	});
});
