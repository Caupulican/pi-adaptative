import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitProviderRequest, type ProviderAdmissionPolicy } from "../src/core/provider-admission/gate.ts";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";
import { ProviderLimitedError, ProviderLimitStore } from "../src/core/provider-admission/limit-state.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const policy: ProviderAdmissionPolicy = { enabled: true, limits: {}, maxWaitMs: 10_000, foregroundLimitWaitMs: 10_000 };

function harness() {
	const dir = mkdtempSync(join(tmpdir(), "pi-admission-races-"));
	let now = 1_000;
	const ledger = new ProviderAdmissionLedger(dir, { now: () => now, heartbeatMs: 60_000 });
	const limits = new ProviderLimitStore(dir, { now: () => now });
	cleanups.push(
		() => rmSync(dir, { recursive: true, force: true }),
		() => ledger.releaseAll(),
	);
	return {
		ledger,
		limits,
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		getPolicy: () => policy,
	};
}

describe("provider admission concurrency boundaries", () => {
	it.each(["foreground", "worker", "background"] as const)(
		"rechecks a sibling's extended reset in the %s lane",
		async (lane) => {
			const h = harness();
			h.limits.record("anthropic", { limitedUntil: 2_000, reason: "rate_limit" });
			const sleeps: number[] = [];
			const release = await admitProviderRequest("anthropic", {
				...h,
				getLane: () => lane,
				sleep: async (ms) => {
					sleeps.push(ms);
					if (sleeps.length === 1) h.limits.record("anthropic", { limitedUntil: 4_000, reason: "rate_limit" });
					h.advance(ms);
				},
			});
			release();
			expect(sleeps).toEqual([1_000, 2_000]);
			expect(h.now()).toBe(4_000);
		},
	);

	it("refuses an extended reset beyond the original wait budget without sending", async () => {
		const h = harness();
		h.limits.record("anthropic", { limitedUntil: 9_000, reason: "rate_limit" });
		await expect(
			admitProviderRequest("anthropic", {
				...h,
				sleep: async (ms) => {
					h.limits.record("anthropic", { limitedUntil: 15_000, reason: "rate_limit" });
					h.advance(ms);
				},
			}),
		).rejects.toBeInstanceOf(ProviderLimitedError);
		expect(h.now()).toBe(9_000);
		expect(h.ledger.countInflight("anthropic").total).toBe(0);
	});
});
