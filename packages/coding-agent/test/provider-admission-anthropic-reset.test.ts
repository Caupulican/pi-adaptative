import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@caupulican/pi-ai";
import { streamSimpleAnthropic } from "@caupulican/pi-ai/anthropic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withProviderAdmission } from "../src/core/provider-admission/gate.ts";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";
import { ProviderLimitStore } from "../src/core/provider-admission/limit-state.ts";

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
});
