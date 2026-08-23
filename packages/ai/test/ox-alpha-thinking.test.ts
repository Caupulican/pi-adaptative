import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "../src/models.ts";
import { streamSimpleOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

describe("Ox Alpha thinking levels", () => {
	it("keeps max thinking selectable for the OpenRouter Ox Alpha catalog entry", () => {
		const model = getModel("openrouter", "stealth/ox-alpha");

		expect(model).toMatchObject({ provider: "openrouter", reasoning: true });
		expect(getSupportedThinkingLevels(model)).toContain("max");
		expect(clampThinkingLevel(model, "max")).toBe("max");
	});

	it("sends max as OpenRouter reasoning effort for an Ox Alpha request", async () => {
		const requestBodies: Array<{ model?: string; reasoning?: { effort?: string } }> = [];
		const server = http.createServer(async (request, response) => {
			if (request.method !== "POST" || request.url !== "/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			requestBodies.push(JSON.parse(body) as { model?: string; reasoning?: { effort?: string } });
			response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-ox-alpha",
					object: "chat.completion.chunk",
					created: 0,
					model: "stealth/ox-alpha",
					choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-ox-alpha",
					object: "chat.completion.chunk",
					created: 0,
					model: "stealth/ox-alpha",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});

		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const { port } = server.address() as AddressInfo;
			const model = {
				...getModel("openrouter", "stealth/ox-alpha"),
				baseUrl: `http://127.0.0.1:${port}`,
			} as Model<"openai-completions">;
			const context = { messages: [{ role: "user", content: "Reply ok", timestamp: 1 }] } as Context;

			for await (const _event of streamSimpleOpenAICompletions(model, context, {
				apiKey: "test-key",
				reasoning: "max",
			})) {
				// Consume the production stream so the request and response complete.
			}

			expect(requestBodies).toEqual([
				expect.objectContaining({ model: "stealth/ox-alpha", reasoning: { effort: "max" } }),
			]);
		} finally {
			server.close();
			await once(server, "close");
		}
	});

	it("does not enable extended levels for unrelated catalog entries without an explicit map", () => {
		const model = getModel("openrouter", "stepfun/step-3.5-flash");

		expect(getSupportedThinkingLevels(model)).not.toContain("max");
		expect(clampThinkingLevel(model, "max")).toBe("high");
	});
});
