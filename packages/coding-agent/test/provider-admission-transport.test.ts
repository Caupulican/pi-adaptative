import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withProviderAdmission } from "../src/core/provider-admission/gate.ts";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";
import { ProviderLimitedError, ProviderLimitStore } from "../src/core/provider-admission/limit-state.ts";

const model = { api: "faux", provider: "anthropic", id: "fixture" } as Model<Api>;
const policy = { enabled: true, limits: { anthropic: 1 }, maxWaitMs: 10_000, foregroundLimitWaitMs: 10_000 };
let dir: string;
let now: number;
let ledger: ProviderAdmissionLedger;
let limits: ProviderLimitStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-admission-transport-"));
	now = 1_000;
	ledger = new ProviderAdmissionLedger(dir, { now: () => now });
	limits = new ProviderLimitStore(dir, { now: () => now });
});
afterEach(() => {
	ledger.releaseAll();
	rmSync(dir, { recursive: true, force: true });
});

describe("admission before transport dispatch", () => {
	for (const lane of ["foreground", "worker", "background"] as const) {
		it.each([false, true])(`dispatches ${lane} only at the current reset (extended=%s)`, async (extended) => {
			limits.record("anthropic", { limitedUntil: 2_000, reason: "rate_limit" });
			let sleepCount = 0;
			const transport = vi.fn(() => {
				expect(now).toBe(extended ? 4_000 : 2_000);
				expect(ledger.countInflight("anthropic").total).toBe(1);
				const result = createAssistantMessageEventStream();
				result.end({ ...fauxAssistantMessage("delivered"), provider: "anthropic" });
				return result;
			});
			const wrapped = withProviderAdmission(transport, {
				ledger,
				limits,
				now: () => now,
				getPolicy: () => policy,
				getLane: () => lane,
				sleep: async (ms) => {
					expect(transport).not.toHaveBeenCalled();
					expect(ledger.countInflight("anthropic").total).toBe(0);
					if (sleepCount++ === 0 && extended)
						limits.record("anthropic", { limitedUntil: 4_000, reason: "rate_limit" });
					now += ms;
				},
			});
			const stream = await wrapped(model, { messages: [] }, {});
			expect((await stream.result()).content).toEqual(fauxAssistantMessage("delivered").content);
			expect(transport).toHaveBeenCalledTimes(1);
			expect(ledger.countInflight("anthropic").total).toBe(0);
		});

		it(`refuses ${lane} transport when extension exceeds the original wait deadline`, async () => {
			limits.record("anthropic", { limitedUntil: 9_000, reason: "rate_limit" });
			const transport = vi.fn(() => createAssistantMessageEventStream());
			const wrapped = withProviderAdmission(transport, {
				ledger,
				limits,
				now: () => now,
				getPolicy: () => policy,
				getLane: () => lane,
				sleep: async (ms) => {
					limits.record("anthropic", { limitedUntil: 15_000, reason: "rate_limit" });
					now += ms;
				},
			});
			await expect(wrapped(model, { messages: [] }, {})).rejects.toBeInstanceOf(ProviderLimitedError);
			expect(now).toBe(9_000);
			expect(transport).not.toHaveBeenCalled();
			expect(ledger.countInflight("anthropic").total).toBe(0);
		});
	}

	it.each(["worker", "background"] as const)(
		"rechecks a new limit published while %s waits for capacity",
		async (lane) => {
			const occupied = ledger.acquire("anthropic", "foreground");
			let sleepCount = 0;
			const transport = vi.fn(() => {
				expect(now).toBe(4_000);
				const stream = createAssistantMessageEventStream();
				stream.end(fauxAssistantMessage("done"));
				return stream;
			});
			const wrapped = withProviderAdmission(transport, {
				ledger,
				limits,
				now: () => now,
				getPolicy: () => policy,
				getLane: () => lane,
				sleep: async (ms) => {
					expect(transport).not.toHaveBeenCalled();
					if (sleepCount++ === 0) {
						limits.record("anthropic", { limitedUntil: 4_000, reason: "rate_limit" });
						occupied.release();
					}
					now += ms;
				},
			});
			await wrapped(model, { messages: [] }, {});
			expect(transport).toHaveBeenCalledTimes(1);
			expect(ledger.countInflight("anthropic").total).toBe(0);
		},
	);
});
