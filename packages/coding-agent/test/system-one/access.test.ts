import { describe, expect, it } from "vitest";
import { TypeSafeReviewer } from "../../src/core/review/typesafe-reviewer.ts";
import { type SystemOneProviderChoice, sessionSystemOneAccess } from "../../src/core/system-one/access.ts";

function access(choice: { value: SystemOneProviderChoice }, keys: { typesafe?: string; openrouter?: string }) {
	return sessionSystemOneAccess({
		getChoice: () => choice.value,
		getStoredKey: async (provider) => keys[provider],
		env: {},
	});
}

describe("System One access", () => {
	it("auto prefers the owner's TypeSafe key, then OpenRouter, always at the pinned version", async () => {
		const choice = { value: "auto" as SystemOneProviderChoice };
		const both = await access(choice, { typesafe: "ts-key", openrouter: "or-key" }).resolve();
		expect(both).toMatchObject({ kind: "ready", access: { model: "jev-1.13.0", apiKey: "ts-key" } });
		const onlyOpenRouter = await access(choice, { openrouter: "or-key" }).resolve();
		expect(onlyOpenRouter).toMatchObject({ kind: "ready", access: { model: "typesafe/jev-1.13", apiKey: "or-key" } });
	});

	it("an explicit choice uses only that provider's key, and a switch applies to the next resolution", async () => {
		const choice = { value: "openrouter" as SystemOneProviderChoice };
		const resolver = access(choice, { typesafe: "ts-key" });
		expect(await resolver.resolve()).toMatchObject({ kind: "missing_key", choice: "openrouter" });
		choice.value = "typesafe";
		expect(await resolver.resolve()).toMatchObject({ kind: "ready", access: { apiKey: "ts-key" } });
		expect(await resolver.keys()).toEqual(["ts-key"]);
	});

	it("sends each provider's key only to that provider, and refuses another engine version", async () => {
		const choice = { value: "openrouter" as SystemOneProviderChoice };
		const calls: { url: string; auth: string; model: string }[] = [];
		const reviewer = new TypeSafeReviewer({
			access: access(choice, { typesafe: "ts-key", openrouter: "or-key" }),
			fetch: (async (url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as { model: string };
				calls.push({
					url: String(url),
					auth: new Headers(init?.headers).get("Authorization") ?? "",
					model: body.model,
				});
				return new Response(JSON.stringify({ model: body.model, answers: {} }), { status: 200 });
			}) as typeof fetch,
		});
		const input = { state: "fixture", questions: { q: { type: "noul" as const, instructions: "Present?" } } };
		await reviewer.evaluate(input).catch(() => undefined);
		choice.value = "typesafe";
		await reviewer.evaluate(input).catch(() => undefined);
		expect(calls.map(({ url, auth, model }) => [new URL(url).host, auth, model])).toEqual([
			["openrouter.ai", "Bearer or-key", "typesafe/jev-1.13"],
			["api.typesafe.ai", "Bearer ts-key", "jev-1.13.0"],
		]);
		await expect(reviewer.evaluate({ ...input, model: "jev-latest" })).rejects.toThrow("System One runs jev-1.13.0");
	});
});
