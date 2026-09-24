import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";

const apiKey = `e30.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
).toString("base64url")}.signature`;

function model(headers?: Record<string, string>): Model<"openai-codex-responses"> {
	return {
		id: "fixture",
		name: "Fixture",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...(headers ? { headers } : {}),
	};
}

async function sentHeaders(
	modelHeaders: Record<string, string> | undefined,
	options: Partial<SimpleStreamOptions>,
): Promise<Headers> {
	let sent: Headers | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: unknown, init?: RequestInit) => {
			sent = new Headers(init?.headers);
			throw new Error("captured");
		}),
	);
	await streamSimpleOpenAICodexResponses(
		model(modelHeaders),
		{ messages: [] },
		{ apiKey, transport: "sse", maxRetries: 0, ...options },
	).result();
	if (!sent) throw new Error("no request was sent");
	return sent;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("OpenAI Codex FedRAMP routing header", () => {
	it("never takes the routing header from request or model headers", async () => {
		const forged = await sentHeaders({ "x-openai-fedramp": "true" }, { headers: { "X-OpenAI-Fedramp": "true" } });
		expect(forged.get("X-OpenAI-Fedramp")).toBeNull();
	});

	it("sends it from the credential's own headers over a configured value, keeping other custom headers", async () => {
		const claimed = await sentHeaders(
			{ "x-openai-fedramp": "false", "X-Model-Custom": "model" },
			{
				headers: { "X-OpenAI-Fedramp": "false", "X-Request-Custom": "request" },
				credentialHeaders: { "X-OpenAI-Fedramp": "true" },
			},
		);
		expect(claimed.get("X-OpenAI-Fedramp")).toBe("true");
		expect(claimed.get("X-Model-Custom")).toBe("model");
		expect(claimed.get("X-Request-Custom")).toBe("request");
	});

	it("replays a rejected request with the recovered credential's headers, never the stale ones", async () => {
		const replayed = async (credentialHeadersFor?: (key: string) => Record<string, string> | undefined) => {
			const sent: Array<string | null> = [];
			const asked: string[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_input: unknown, init?: RequestInit) => {
					sent.push(new Headers(init?.headers).get("X-OpenAI-Fedramp"));
					if (sent.length === 1) return new Response("", { status: 401 });
					throw new Error("captured");
				}),
			);
			await streamSimpleOpenAICodexResponses(
				model(),
				{ messages: [] },
				{
					apiKey,
					transport: "sse",
					maxRetries: 0,
					credentialHeaders: { "X-OpenAI-Fedramp": "true" },
					onAuthRejection: () => replacementKey,
					...(credentialHeadersFor
						? {
								credentialHeadersFor: (key: string) => {
									asked.push(key);
									return credentialHeadersFor(key);
								},
							}
						: {}),
				},
			).result();
			return { sent, asked };
		};
		const replacementKey = `${apiKey}-rotated`;
		const cleared = await replayed(() => undefined);
		expect(cleared.sent).toEqual(["true", null]);
		expect(cleared.asked).toEqual([replacementKey]);
		expect((await replayed(() => ({ "X-OpenAI-Fedramp": "true" }))).sent).toEqual(["true", "true"]);
		expect((await replayed()).sent).toEqual(["true", null]);
	});

	it("keeps ordinary custom headers when no credential header applies (control)", async () => {
		const plain = await sentHeaders({ "X-Model-Custom": "model" }, { headers: { "X-Request-Custom": "request" } });
		expect(plain.get("X-Model-Custom")).toBe("model");
		expect(plain.get("X-Request-Custom")).toBe("request");
		expect(plain.get("X-OpenAI-Fedramp")).toBeNull();
	});
});
