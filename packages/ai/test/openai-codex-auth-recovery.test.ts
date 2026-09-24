import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";

const apiKey = `e30.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
).toString("base64url")}.signature`;
const replacementKey = `${apiKey}-rotated`;

const model: Model<"openai-codex-responses"> = {
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
};

const unauthorized = () => new Response(JSON.stringify({ error: { message: "Unauthorized token" } }), { status: 401 });
const invalid = () => new Response(JSON.stringify({ error: { message: "Invalid request body" } }), { status: 400 });
const networkDown = (): Response => {
	throw new TypeError("fetch failed");
};
const unavailable = () => new Response(JSON.stringify({ error: { message: "Service unavailable" } }), { status: 503 });

async function run(responses: Array<() => Response>, options: Partial<SimpleStreamOptions>) {
	const sent: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: unknown, init?: RequestInit) => {
			sent.push(new Headers(init?.headers).get("Authorization") ?? "");
			const next = responses[sent.length - 1];
			if (!next) throw new Error("captured");
			return next();
		}),
	);
	const result = await streamSimpleOpenAICodexResponses(
		model,
		{ messages: [] },
		{ apiKey, transport: "sse", maxRetryDelayMs: 1, ...options },
	).result();
	return { sent, errorMessage: result.errorMessage ?? "" };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("OpenAI Codex auth recovery", () => {
	it("replays a rejected request once with the recovered key even when no retries are allowed", async () => {
		const onAuthRejection = vi.fn(() => replacementKey);
		const { sent } = await run([unauthorized], { maxRetries: 0, onAuthRejection });
		expect(sent).toEqual([`Bearer ${apiKey}`, `Bearer ${replacementKey}`]);
		expect(onAuthRejection).toHaveBeenCalledTimes(1);
	});

	it("reports the rejection itself when no replacement key is recovered", async () => {
		const { sent, errorMessage } = await run([unauthorized], { maxRetries: 0, onAuthRejection: () => undefined });
		expect(sent).toHaveLength(1);
		expect(errorMessage).toContain("Unauthorized token");
		expect(errorMessage).not.toContain("Failed after retries");
	});

	it("ends the request when the replay is rejected too, without spending transient retries", async () => {
		const onAuthRejection = vi.fn(() => replacementKey);
		const { sent, errorMessage } = await run([unauthorized, unauthorized, unauthorized], {
			maxRetries: 2,
			onAuthRejection,
		});
		expect(sent).toEqual([`Bearer ${apiKey}`, `Bearer ${replacementKey}`]);
		expect(onAuthRejection).toHaveBeenCalledTimes(1);
		expect(errorMessage).toContain("Unauthorized token");
	});

	it("never retries a final HTTP error", async () => {
		const { sent, errorMessage } = await run([invalid, invalid, invalid], { maxRetries: 2 });
		expect(sent).toHaveLength(1);
		expect(errorMessage).toContain("Invalid request body");
	});

	it("keeps the retry budget for other failures (control)", async () => {
		expect((await run([unavailable, unavailable, unavailable], { maxRetries: 0 })).sent).toHaveLength(1);
		expect((await run([unavailable, unavailable, unavailable], { maxRetries: 2 })).sent).toHaveLength(3);
		expect((await run([networkDown, networkDown, networkDown], { maxRetries: 2 })).sent).toHaveLength(3);
	});
});
