import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, type Model } from "@caupulican/pi-ai";
import { streamSimpleAnthropic } from "@caupulican/pi-ai/anthropic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withProviderAdmission } from "../src/core/provider-admission/gate.ts";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";
import {
	observeProviderResult,
	ProviderLimitStore,
	usageWindowLimit,
} from "../src/core/provider-admission/limit-state.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-fixture",
	name: "Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://fixture.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4_000,
};
const now = 1_800_000_000_000;
const account = "anthropic#fixture";
let dir: string;
let ledger: ProviderAdmissionLedger;
let limits: ProviderLimitStore;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	dir = mkdtempSync(join(tmpdir(), "pi-claude-reset-handoff-"));
	ledger = new ProviderAdmissionLedger(dir);
	limits = new ProviderLimitStore(dir);
});
afterEach(() => {
	ledger.releaseAll();
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Claude SDK rejection to shared admission state", () => {
	it.each(["foreground", "worker", "background"] as const)(
		"publishes the reset from a %s terminal error",
		async (lane) => {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(
					Response.json(
						{ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
						{ status: 429, headers: { "anthropic-ratelimit-unified-reset": String((now + 5_000) / 1000) } },
					),
				);
			vi.stubGlobal("fetch", fetch);
			const wrapped = withProviderAdmission(
				(requestModel, context, options) =>
					streamSimpleAnthropic(requestModel as Model<"anthropic-messages">, context, options),
				{
					ledger,
					limits,
					getLane: () => lane,
					getAccountKey: () => account,
					getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 10_000, foregroundLimitWaitMs: 10_000 }),
				},
			);
			const stream = await wrapped(model, { messages: [] }, { apiKey: "sk-ant-oat-fixture", maxRetries: 0 });
			const message = await stream.result();
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toContain("retry after 5s");
			expect(limits.read(account)).toMatchObject({ limitedUntil: now + 5_000, reason: "rate_limit" });
			expect(limits.read("anthropic#other")).toBeUndefined();
			expect(ledger.countInflight(account).total).toBe(0);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["foreground", "worker", "background"] as const)(
		"publishes a long server reset for %s without an early retry",
		async (lane) => {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(
					Response.json(
						{ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
						{ status: 429, headers: { "retry-after": "120" } },
					),
				);
			vi.stubGlobal("fetch", fetch);
			const wrapped = withProviderAdmission(
				(requestModel, context, options) =>
					streamSimpleAnthropic(requestModel as Model<"anthropic-messages">, context, options),
				{
					ledger,
					limits,
					getLane: () => lane,
					getAccountKey: () => account,
					getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 10_000, foregroundLimitWaitMs: 10_000 }),
				},
			);
			const stream = await wrapped(model, { messages: [] }, { apiKey: "sk-ant-oat-fixture", maxRetries: 1 });
			const message = await stream.result();
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toContain("do not retry");
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(limits.read(account)).toMatchObject({ limitedUntil: now + 120_000, reason: "rate_limit" });
			expect(limits.read("anthropic#other")).toBeUndefined();
		},
	);

	it("publishes rate limit immediately when streamFn throws transport 429", async () => {
		const err = Object.assign(new Error("429 Rate limited; retry after 7 seconds"), { status: 429 });
		const wrapped = withProviderAdmission(
			() => {
				throw err;
			},
			{
				ledger,
				limits,
				getAccountKey: () => account,
				getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 10_000, foregroundLimitWaitMs: 10_000 }),
			},
		);
		await expect(wrapped(model, { messages: [] }, {})).rejects.toBe(err);
		expect(limits.read(account)).toMatchObject({ limitedUntil: now + 7_000, reason: "rate_limit" });
		expect(ledger.countInflight(account).total).toBe(0);
	});

	it("publishes rate limit from immediate transport failure with header hints", async () => {
		const err = Object.assign(new Error("Rate limited"), {
			status: 429,
			headers: { "anthropic-ratelimit-unified-reset": String((now + 6_000) / 1000) },
		});
		const wrapped = withProviderAdmission(
			() => {
				throw err;
			},
			{
				ledger,
				limits,
				getAccountKey: () => account,
				getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 10_000, foregroundLimitWaitMs: 10_000 }),
			},
		);
		await expect(wrapped(model, { messages: [] }, {})).rejects.toBe(err);
		expect(limits.read(account)).toMatchObject({ limitedUntil: now + 6_000, reason: "rate_limit" });
		expect(ledger.countInflight(account).total).toBe(0);
	});

	it("publishes rate limit when stream result promise rejects", async () => {
		const rejection = Object.assign(new Error("429 Too Many Requests; retry after 4 seconds"), { status: 429 });
		const stream = {
			result: () => Promise.reject(rejection),
		} as unknown as ReturnType<StreamFn>;
		const wrapped = withProviderAdmission(() => stream, {
			ledger,
			limits,
			getAccountKey: () => account,
			getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 10_000, foregroundLimitWaitMs: 10_000 }),
		});
		const res = await wrapped(model, { messages: [] }, {});
		await expect(res.result()).rejects.toThrow("429 Too Many Requests");
		expect(limits.read(account)).toMatchObject({ limitedUntil: now + 4_000, reason: "rate_limit" });
		expect(ledger.countInflight(account).total).toBe(0);
	});

	it("records rate limit from anthropic_subscription_rate_limits diagnostic", () => {
		observeProviderResult(
			limits,
			{
				...fauxAssistantMessage("ok"),
				provider: "anthropic",
				diagnostics: [
					{
						type: "anthropic_subscription_rate_limits",
						timestamp: now,
						details: {
							status: "rejected",
							reset: (now + 8_000) / 1000,
							resetsAt: (now + 8_000) / 1000,
							"representative-claim": "five_hour",
						},
					},
				],
			},
			now,
			account,
		);
		expect(limits.read(account)).toMatchObject({
			limitedUntil: now + 8_000,
			reason: "rate_limit",
			detail: expect.stringContaining("five_hour"),
		});
	});

	it("attaches anthropic_subscription_rate_limits diagnostic on response with unified headers", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
			new Response(
				'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
				{
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"anthropic-ratelimit-unified-status": "allowed",
						"anthropic-ratelimit-unified-reset": String((now + 10_000) / 1000),
						"anthropic-ratelimit-unified-5h-reset": String((now + 18_000_000) / 1000),
						"anthropic-ratelimit-unified-7d-reset": String((now + 604_800_000) / 1000),
						"anthropic-ratelimit-unified-fallback": "none",
						"anthropic-ratelimit-unified-representative-claim": "primary",
						"anthropic-ratelimit-unified-overage-status": "inactive",
						"anthropic-ratelimit-unified-overage-reset": "0",
						"anthropic-ratelimit-unified-overage-disabled-reason": "none",
					},
				},
			),
		);
		vi.stubGlobal("fetch", fetch);
		const stream = streamSimpleAnthropic(model, { messages: [] }, { apiKey: "sk-ant-oat-fixture" });
		const message = await stream.result();
		expect(message.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "anthropic_subscription_rate_limits",
					details: expect.objectContaining({
						status: "allowed",
						reset: (now + 10_000) / 1000,
						resetsAt: (now + 10_000) / 1000,
						"5h-reset": (now + 18_000_000) / 1000,
						"7d-reset": (now + 604_800_000) / 1000,
						fallback: "none",
						"representative-claim": "primary",
						"overage-status": "inactive",
						"overage-reset": 0,
						"overage-disabled-reason": "none",
					}),
				}),
			]),
		);
	});

	it("hardens usageWindowLimit against non-finite values", () => {
		expect(
			usageWindowLimit([{ primary: { usedPercent: Number.NaN, resetsAt: (now + 5000) / 1000 } }], now),
		).toBeUndefined();
		expect(
			usageWindowLimit([{ primary: { usedPercent: Number.POSITIVE_INFINITY, resetsAt: (now + 5000) / 1000 } }], now),
		).toBeUndefined();
		expect(usageWindowLimit([{ primary: { usedPercent: 100, resetsAt: Number.NaN } }], now)).toBeUndefined();
		expect(usageWindowLimit([{ primary: { usedPercent: 100, resetAfterSeconds: Number.NaN } }], now)).toBeUndefined();
	});
});
