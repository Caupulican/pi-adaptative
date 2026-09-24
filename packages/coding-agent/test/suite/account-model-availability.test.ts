/**
 * The router and the session use only models the owner's account offers: the account is asked
 * before anything is sent, and a model the provider refuses mid-session is replaced and the refused
 * turn re-sent on the replacement.
 */

import { type Api, type AssistantMessage, fauxAssistantMessage, type Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountModelCatalog } from "../../src/core/model-router/account-models.ts";
import { createHarness } from "./harness.ts";

const MODELS = [
	{ id: "gpt-5.4", name: "GPT-5.4" },
	{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
].map((model) => ({
	...model,
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
}));

/** The talker first: the session model is gpt-5.6-sol and gpt-5.4 is only the cheap pin. */
const TALKER_FIRST = [MODELS[1], MODELS[0]];

/** A ChatGPT OAuth access token shape: the Codex client reads the account id from it. */
function accessToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
		"utf8",
	).toString("base64url");
	return `header.${payload}.signature`;
}

function codexModels(entries: { slug: string; priority: number }[]): typeof fetch {
	return async () =>
		new Response(
			JSON.stringify({
				models: entries.map((entry) => ({ ...entry, visibility: "list", supported_in_api: true })),
			}),
			{ status: 200 },
		);
}

const REFUSAL =
	"Codex error (status 400): The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.";

describe("account model availability", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("leaves a session model the account does not offer before the first request", async () => {
		const harness = await createHarness({
			models: MODELS,
			fauxProvider: { provider: "openai-codex" },
			accountModels: { fetch: codexModels([{ slug: "gpt-5.6-sol", priority: 4 }]), apiKey: accessToken() },
		});
		const seen: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model) => {
				seen.push(model.id);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("hello");
		expect(seen).toEqual(["gpt-5.6-sol"]);
		expect(harness.session.model?.id).toBe("gpt-5.6-sol");
		expect(harness.eventsOfType("warning").map((event) => event.message)).toContain(
			"openai-codex/gpt-5.4 is not available on this account (not offered to this openai-codex account); this session continues on openai-codex/gpt-5.6-sol.",
		);
	});

	it("re-sends a turn the provider refused for the account on the account's default", async () => {
		const harness = await createHarness({
			models: MODELS,
			fauxProvider: { provider: "openai-codex" },
			// The listing offers both; the provider refuses gpt-5.4 anyway when it is used.
			accountModels: {
				fetch: codexModels([
					{ slug: "gpt-5.4", priority: 1 },
					{ slug: "gpt-5.6-sol", priority: 4 },
				]),
				apiKey: accessToken(),
			},
		});
		const seen: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model): AssistantMessage => {
				seen.push(model.id);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: REFUSAL });
			},
			(_context, _options, _state, model) => {
				seen.push(model.id);
				return fauxAssistantMessage("done on sol");
			},
		]);
		await harness.session.prompt("hello");
		expect(seen).toEqual(["gpt-5.4", "gpt-5.6-sol"]);
		expect(harness.session.model?.id).toBe("gpt-5.6-sol");
		const retries = harness.eventsOfType("auto_retry_start");
		expect(retries).toHaveLength(1);
		expect(retries[0]).toMatchObject({ delayMs: 0 });
		expect(retries[0]!.errorMessage).toContain("Continuing on openai-codex/gpt-5.6-sol.");
		const last = harness.session.messages.at(-1);
		expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("moves a routed turn the provider refused to the next usable model and restores the root after", async () => {
		const harness = await createHarness({
			// The root runs gpt-5.6-sol; the cheap tier is pinned to gpt-5.4, which the account refuses.
			models: [MODELS[1]!, MODELS[0]!],
			fauxProvider: { provider: "openai-codex" },
			settings: {
				modelRouter: {
					enabled: true,
					cheapModel: "openai-codex/gpt-5.4",
					expensiveModel: "openai-codex/gpt-5.6-sol",
				},
			},
		});
		const seen: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model): AssistantMessage => {
				seen.push(model.id);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: REFUSAL });
			},
			(_context, _options, _state, model) => {
				seen.push(model.id);
				return fauxAssistantMessage("answered on sol");
			},
		]);
		await harness.session.prompt("Explain this read-only value");
		expect(seen).toEqual(["gpt-5.4", "gpt-5.6-sol"]);
		expect(harness.session.model?.id).toBe("gpt-5.6-sol");
		expect(harness.eventsOfType("warning").map((event) => event.message)).toContain(
			"openai-codex/gpt-5.4 is not available on this account; this turn continues on openai-codex/gpt-5.6-sol.",
		);
		// The refused pin is not routed to again, and status says why.
		harness.setResponses([fauxAssistantMessage("second")]);
		await harness.session.prompt("Explain this other read-only value");
		expect(harness.session.getModelRouterStatus()).toContain(
			"cheap model openai-codex/gpt-5.4 is not available on this account (refused by openai-codex:",
		);
	});

	it("names a redeemable reset when Codex's usage limit is reached, and a redeemed reset clears the limit", async () => {
		const harness = await createHarness({ models: MODELS, fauxProvider: { provider: "openai-codex" } });
		harness.authStorage.setRuntimeApiKey("openai-codex", accessToken());
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			// Asked at the refused model's own Codex base URL (the faux server here).
			expect(String(input)).toMatch(/\/rate-limit-reset-credits$/);
			return new Response(
				JSON.stringify({
					credits: [
						{
							id: "credit-1",
							reset_type: "codex_rate_limits",
							status: "available",
							granted_at: "2026-09-01T00:00:00Z",
						},
					],
					available_count: 1,
				}),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "You have hit your ChatGPT usage limit (pro plan). Try again in ~1933 min.",
			}),
		]);
		await harness.session.prompt("hello");
		await vi.waitFor(() =>
			expect(harness.eventsOfType("warning").map((event) => event.message)).toContain(
				"OpenAI Codex usage limit reached. 1 usage reset is available: /usage, then Redeem usage limit reset.",
			),
		);
		expect(harness.session.getModelRouterStatus()).toContain("openai-codex/gpt-5.4");

		harness.session.noteSubscriptionUsageReset("openai-codex");
		expect(harness.session.getModelRouterStatus()).not.toContain("Exhausted models:");
	});

	it("keeps a refused side trip's replacement inside the turn and never moves the session model", async () => {
		// The session (the talker) runs gpt-5.6-sol and the cheap tier is pinned to gpt-5.4: a small message
		// takes its side trip there, Codex refuses it, and the turn continues on the talker without the
		// session model moving.
		const harness = await createHarness({
			models: TALKER_FIRST,
			fauxProvider: { provider: "openai-codex" },
			settings: { modelRouter: { enabled: true, cheapModel: "openai-codex/gpt-5.4" } },
			accountModels: {
				fetch: codexModels([
					{ slug: "gpt-5.4", priority: 1 },
					{ slug: "gpt-5.6-sol", priority: 4 },
				]),
				apiKey: accessToken(),
			},
		});
		const seen: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model): AssistantMessage => {
				seen.push(model.id);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: REFUSAL });
			},
			(_context, _options, _state, model) => {
				seen.push(model.id);
				return fauxAssistantMessage("answered on sol");
			},
		]);
		await harness.session.prompt("Explain this read-only value");
		expect(seen).toEqual(["gpt-5.4", "gpt-5.6-sol"]);
		expect(harness.session.model?.id).toBe("gpt-5.6-sol");
		expect(harness.eventsOfType("warning").map((event) => event.message)).toContain(
			"openai-codex/gpt-5.4 is not available on this account; this turn continues on openai-codex/gpt-5.6-sol.",
		);
	});

	it("never retries a refused side trip's pin, even when the talker it moved to fails too", async () => {
		const harness = await createHarness({
			models: TALKER_FIRST,
			fauxProvider: { provider: "openai-codex" },
			settings: { modelRouter: { enabled: true, cheapModel: "openai-codex/gpt-5.4" } },
		});
		const seen: string[] = [];
		const refuse =
			(text: string) =>
			(_context: unknown, _options: unknown, _state: unknown, model: Model<Api>): AssistantMessage => {
				seen.push(model.id);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: text });
			};
		harness.setResponses([refuse(REFUSAL), refuse(REFUSAL.replace("gpt-5.4", "gpt-5.6-sol")), refuse(REFUSAL)]);
		await harness.session.prompt("Explain this read-only value");
		expect(seen[0]).toBe("gpt-5.4");
		expect(seen.slice(1)).not.toContain("gpt-5.4");
		expect(harness.session.model?.id).not.toBe("gpt-5.4");
	});

	it("checks for Codex resets again after a check that found none", async () => {
		const harness = await createHarness({ models: MODELS, fauxProvider: { provider: "openai-codex" } });
		harness.authStorage.setRuntimeApiKey("openai-codex", accessToken());
		let available = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							credits: Array.from({ length: available }, (_, index) => ({
								id: `credit-${index}`,
								reset_type: "codex_rate_limits",
								status: "available",
								granted_at: "2026-09-01T00:00:00Z",
							})),
							available_count: available,
						}),
						{ status: 200 },
					),
			),
		);
		const limit = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "You have hit your ChatGPT usage limit (pro plan). Try again in ~1933 min.",
		});
		const offers = () =>
			harness
				.eventsOfType("warning")
				.filter((event) => event.message.startsWith("OpenAI Codex usage limit reached. "));
		harness.setResponses([limit]);
		await harness.session.prompt("hello");
		await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
		expect(offers()).toHaveLength(0);

		available = 1;
		harness.setResponses([limit]);
		await harness.session.prompt("hello again");
		await vi.waitFor(() => expect(offers()).toHaveLength(1));
	});

	it("reports what each account offers, a rejected key, and an unanswered check", async () => {
		const models = [
			{ provider: "openai-codex", id: "gpt-5.4", baseUrl: "https://chatgpt.com/backend-api" },
			{ provider: "openai-codex", id: "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api" },
			{ provider: "openrouter", id: "inclusionai/ling-3", baseUrl: "https://openrouter.ai/api/v1" },
		] as unknown as ReturnType<ConstructorParameters<typeof AccountModelCatalog>[0]["getModels"]>;
		const catalog = new AccountModelCatalog({
			getModels: () => models,
			hasConfiguredAuth: () => true,
			getApiKey: async (model) => (model.provider === "openai-codex" ? accessToken() : "sk-or-test"),
			fetch: async (input) =>
				String(input).startsWith("https://openrouter.ai")
					? new Response("{}", { status: 401 })
					: codexModels([{ slug: "gpt-5.6-sol", priority: 4 }])(input),
		});
		await catalog.refresh();
		expect(models.map((model) => catalog.availability(model))).toEqual(["unavailable", "available", "unavailable"]);
		expect(catalog.accountDefault("openai-codex")?.id).toBe("gpt-5.6-sol");
		expect(catalog.describe()).toEqual([
			"openai-codex: gpt-5.6-sol",
			"openrouter: rejected (OpenRouter rejected the key (401))",
		]);

		const offline = new AccountModelCatalog({
			getModels: () => models,
			hasConfiguredAuth: () => true,
			getApiKey: async () => accessToken(),
			fetch: async () => {
				throw new Error("getaddrinfo ENOTFOUND chatgpt.com");
			},
		});
		await offline.refresh();
		expect(offline.availability(models[0]!)).toBe("unknown");
		expect(offline.describe()[0]).toBe("openai-codex: not checked (getaddrinfo ENOTFOUND chatgpt.com)");
		offline.markRefused(models[0]!, REFUSAL);
		expect(offline.availability(models[0]!)).toBe("unavailable");
	});
});
