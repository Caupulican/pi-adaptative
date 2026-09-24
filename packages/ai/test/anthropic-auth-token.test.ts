import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ANTHROPIC_API_KEY_ENV,
	ANTHROPIC_AUTH_TOKEN_ENV,
	ANTHROPIC_OAUTH_TOKEN_ENV,
	findEnvKeys,
	getEnvApiKey,
	getEnvAuthHeaders,
} from "../src/env-api-keys.ts";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	constructorOptions: undefined as Record<string, unknown> | undefined,
	createParams: undefined as Record<string, unknown> | undefined,
	createImplementation: undefined as
		| ((params: Record<string, unknown>) => { asResponse: () => Promise<Response> })
		| undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function response(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		constructor(options: Record<string, unknown>) {
			mockState.constructorOptions = options;
		}

		messages = {
			create: (params: Record<string, unknown>) => {
				mockState.createParams = params;
				if (mockState.createImplementation) {
					return mockState.createImplementation(params);
				}
				return { asResponse: async () => response() };
			},
		};
	}

	return { default: FakeAnthropic };
});

const originalEnv = new Map(
	[ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV].map((name) => [
		name,
		process.env[name],
	]),
);

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

const context: Context = {
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
};

beforeEach(() => {
	delete process.env[ANTHROPIC_AUTH_TOKEN_ENV];
	delete process.env[ANTHROPIC_OAUTH_TOKEN_ENV];
	delete process.env[ANTHROPIC_API_KEY_ENV];
	mockState.constructorOptions = undefined;
	mockState.createParams = undefined;
	mockState.createImplementation = undefined;
});

afterEach(() => {
	for (const [name, value] of originalEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("Anthropic bearer-token authentication", () => {
	it.each(["user", "background"] as const)(
		"uses the native CLI identity for %s OAuth requests",
		async (interactionMode) => {
			await streamSimple(model, context, { apiKey: "sk-ant-oat-test", interactionMode }).result();
			expect(mockState.constructorOptions?.apiKey).toBeNull();
			expect(mockState.constructorOptions?.authToken).toBe("sk-ant-oat-test");
			const headers = mockState.constructorOptions?.defaultHeaders as Record<string, string>;
			expect(headers["user-agent"]).toBe("claude-cli/2.1.281 (external, cli)");
			expect(headers["x-app"]).toBe("cli");
			expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
			expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
		},
	);

	it("does not add subscription metadata to API-key requests", async () => {
		await streamSimple(model, context, { apiKey: "sk-ant-api-test" }).result();
		expect(mockState.constructorOptions?.apiKey).toBe("sk-ant-api-test");
		expect(mockState.constructorOptions?.authToken).toBeNull();
		const headers = mockState.constructorOptions?.defaultHeaders as Record<string, string>;
		expect(headers["user-agent"]).toBeUndefined();
		expect(headers["x-app"]).toBeUndefined();
		expect(headers["anthropic-beta"] ?? "").not.toContain("oauth-2025-04-20");
	});

	it("reports the auth token without misclassifying it as an API key", () => {
		process.env[ANTHROPIC_AUTH_TOKEN_ENV] = "auth-token";
		process.env[ANTHROPIC_OAUTH_TOKEN_ENV] = "oauth-token";
		process.env[ANTHROPIC_API_KEY_ENV] = "api-key";

		expect(findEnvKeys("anthropic")).toEqual([
			ANTHROPIC_AUTH_TOKEN_ENV,
			ANTHROPIC_OAUTH_TOKEN_ENV,
			ANTHROPIC_API_KEY_ENV,
		]);
		expect(getEnvApiKey("anthropic")).toBe("oauth-token");
		expect(getEnvAuthHeaders("anthropic")).toEqual({ Authorization: "Bearer auth-token" });
	});

	it("uses ANTHROPIC_AUTH_TOKEN as header-only auth without OAuth request shaping", async () => {
		process.env[ANTHROPIC_AUTH_TOKEN_ENV] = "auth-token";

		await streamSimple(model, context).result();

		expect(mockState.constructorOptions?.apiKey).toBeNull();
		expect(mockState.constructorOptions?.authToken).toBeNull();
		const headers = mockState.constructorOptions?.defaultHeaders as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer auth-token");
		expect(headers["anthropic-beta"] ?? "").not.toContain("oauth-2025-04-20");
		expect(mockState.createParams?.system).toEqual([expect.objectContaining({ text: "System prompt." })]);
	});

	it("lets an explicit Authorization header override the environment token", async () => {
		process.env[ANTHROPIC_AUTH_TOKEN_ENV] = "environment-token";

		await streamSimple(model, context, { headers: { Authorization: "Bearer explicit-token" } }).result();

		const headers = mockState.constructorOptions?.defaultHeaders as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer explicit-token");
	});

	it("uses bearer auth for compatible subscription endpoints", async () => {
		const kimiModel: Model<"anthropic-messages"> = {
			...model,
			provider: "kimi-coding",
			baseUrl: "https://api.kimi.com/coding",
			compat: { authFormat: "bearer" },
		};

		await streamSimple(kimiModel, context, { apiKey: "kimi-token" }).result();

		expect(mockState.constructorOptions?.apiKey).toBeNull();
		expect(mockState.constructorOptions?.authToken).toBe("kimi-token");
	});

	it("recovers from 401 using onAuthRejection and retries once with the replacement key", async () => {
		let callCount = 0;
		mockState.createImplementation = () => {
			callCount++;
			if (callCount === 1) {
				const error = new Error("Unauthorized");
				(error as Error & { status?: number }).status = 401;
				throw error;
			}
			const body = [
				`event: message_start\ndata: ${JSON.stringify({
					type: "message_start",
					message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
				})}\n`,
				`event: message_delta\ndata: ${JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 1 },
				})}\n`,
				`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
			].join("\n");
			return {
				asResponse: async () =>
					new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
			};
		};

		let rejectionNotified = false;
		const result = await streamSimple(model, context, {
			apiKey: "expired-key",
			onAuthRejection: async (event) => {
				rejectionNotified = true;
				expect(event.providerId).toBe("anthropic");
				expect(event.status).toBe(401);
				expect(event.attempt).toBe(1);
				return "refreshed-key";
			},
		}).result();

		expect(rejectionNotified).toBe(true);
		expect(result.stopReason).toBe("stop");
		expect(mockState.constructorOptions?.apiKey).toBe("refreshed-key");
	});
});
