import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { admitProviderRequest } from "../src/core/provider-admission/gate.ts";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";
import {
	observeProviderResult,
	ProviderLimitStore,
	usageWindowLimit,
} from "../src/core/provider-admission/limit-state.ts";

describe("exhausted subscription window admission", () => {
	it.each([false, true])("waits for every exhausted window regardless of snapshot order (reverse=%s)", (reverse) => {
		const snapshots = [
			{ limitName: "short", primary: { usedPercent: 100, resetsAt: 4 } },
			{ limitName: "long", secondary: { usedPercent: 100, resetsAt: 9 } },
		];
		if (reverse) snapshots.reverse();
		expect(usageWindowLimit(snapshots, 1_000)).toEqual({
			limitedUntil: 9_000,
			detail: "long secondary window 100% used",
		});
	});

	it("does not let primary hide an exhausted longer secondary window in the same snapshot", () => {
		expect(
			usageWindowLimit(
				[{ primary: { usedPercent: 100, resetsAt: 4 }, secondary: { usedPercent: 100, resetAfterSeconds: 8 } }],
				1_000,
			),
		).toMatchObject({ limitedUntil: 9_000 });
	});

	it("does not wait on a later window which still has capacity", () => {
		expect(
			usageWindowLimit(
				[{ primary: { usedPercent: 100, resetsAt: 4 }, secondary: { usedPercent: 99, resetsAt: 9 } }],
				1_000,
			),
		).toMatchObject({ limitedUntil: 4_000 });
	});

	it("ignores expired and reset-less exhausted windows", () => {
		expect(
			usageWindowLimit([{ primary: { usedPercent: 100, resetsAt: 1 }, secondary: { usedPercent: 100 } }], 1_000),
		).toBeUndefined();
	});

	it.each(["foreground", "worker", "background"] as const)(
		"holds the %s lane until both windows reset",
		async (lane) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-usage-admission-"));
			let now = 1_000;
			const ledger = new ProviderAdmissionLedger(dir, { now: () => now });
			try {
				const store = new ProviderLimitStore(dir, { now: () => now });
				const exhausted = usageWindowLimit(
					[{ primary: { usedPercent: 100, resetsAt: 4 }, secondary: { usedPercent: 100, resetsAt: 9 } }],
					now,
				);
				if (!exhausted) throw new Error("Fixture requires an exhausted window");
				store.record("openai-codex", { ...exhausted, reason: "usage_window" });
				const release = await admitProviderRequest("openai-codex", {
					ledger,
					limits: store,
					getLane: () => lane,
					getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 10_000, foregroundLimitWaitMs: 10_000 }),
					now: () => now,
					sleep: async (ms) => {
						expect(ledger.countInflight("openai-codex").total).toBe(0);
						now += ms;
					},
				});
				try {
					expect(now).toBe(9_000);
					expect(ledger.countInflight("openai-codex").total).toBe(1);
				} finally {
					release();
				}
				expect(ledger.countInflight("openai-codex").total).toBe(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("persists the longest exhausted reset for actual admission consumers", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-usage-window-"));
		try {
			const store = new ProviderLimitStore(dir, { now: () => 1_000 });
			observeProviderResult(
				store,
				{
					...fauxAssistantMessage("complete"),
					provider: "openai-codex",
					diagnostics: [
						{
							type: "openai_codex_subscription_rate_limits",
							timestamp: 1_000,
							details: {
								rateLimits: [
									{
										primary: { usedPercent: 100, resetsAt: 4 },
										secondary: { usedPercent: 100, resetsAt: 9 },
									},
								],
							},
						},
					],
				},
				1_000,
			);
			expect(store.read("openai-codex")?.limitedUntil).toBe(9_000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
