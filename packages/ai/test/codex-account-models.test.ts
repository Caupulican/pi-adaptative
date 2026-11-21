import { describe, expect, it } from "vitest";
import { getOpenAICodexUsage, listOpenAICodexAccountModels } from "../src/providers/openai-codex-account.ts";

const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } };
const accessToken = `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
const model = { slug: "fixture-model", visibility: "list", priority: 1, supported_in_api: true };
const catalogLimit = 2 * 1024 * 1024;

function catalogResponse(bytes: number): Response {
	const entry = { ...model, base_instructions: "" };
	const body = { models: [entry] };
	entry.base_instructions = "x".repeat(bytes - JSON.stringify(body).length);
	return Response.json(body);
}

describe("Codex account response limits", () => {
	it.each([893_483, catalogLimit])("reads a %i-byte model listing containing provider instructions", async (bytes) => {
		const models = await listOpenAICodexAccountModels({ accessToken, fetch: async () => catalogResponse(bytes) });
		expect(models).toEqual([
			{ slug: model.slug, displayName: model.slug, visibility: "list", supportedInApi: true, priority: 1 },
		]);
	});

	it("rejects the listing one byte above the catalog limit", async () => {
		await expect(
			listOpenAICodexAccountModels({ accessToken, fetch: async () => catalogResponse(catalogLimit + 1) }),
		).rejects.toThrow("exceeded the 2048 KiB limit");
	});

	it("retains the smaller limit for ordinary account reads", async () => {
		await expect(
			getOpenAICodexUsage({ accessToken, fetch: async () => new Response(" ".repeat(256 * 1024 + 1)) }),
		).rejects.toThrow("exceeded the 256 KiB limit");
	});
});
