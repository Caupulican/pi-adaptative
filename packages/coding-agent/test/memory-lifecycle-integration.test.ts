import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryProvider } from "../src/core/memory/memory-provider.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function seedCompactableSession(harness: Harness): void {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "older compactable work" }],
		timestamp: now - 1_000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("older result", { timestamp: now - 500 }),
		usage: {
			input: 190_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 190_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("session-owned memory lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.session.disposeAndWait();
		vi.unstubAllEnvs();
	});

	it("keeps managed workers read-only across memory lifecycle hooks", async () => {
		vi.stubEnv("PI_SESSION_ROLE", "worker");
		const calls: string[] = [];
		const provider: MemoryProvider = {
			name: "worker-lifecycle-probe",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {
				calls.push("initialize");
			},
			syncTurn: async () => {
				calls.push("sync");
			},
			onSessionEnd: async () => {
				calls.push("session-end");
			},
			shutdown: async () => {
				calls.push("shutdown");
			},
		};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => pi.registerMemoryProvider(provider));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("worker reply")]);

		await harness.session.prompt("worker turn");
		await harness.session.disposeAndWait();

		expect(calls).toContain("initialize");
		expect(calls).toContain("shutdown");
		expect(calls).not.toContain("sync");
		expect(calls).not.toContain("session-end");
	});

	it("syncs completed turns, delivers one bounded pre-compression handoff, and flushes before shutdown", async () => {
		const calls: string[] = [];
		let compactInstructions = "";
		const provider: MemoryProvider = {
			name: "lifecycle-probe",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {
				calls.push("initialize");
			},
			syncTurn: async (userText, assistantText) => {
				calls.push(`sync:${userText}:${assistantText}`);
			},
			onPreCompress: async () => {
				calls.push("pre-compress");
				return `PRESERVE_MEMORY_HANDOFF ${"m".repeat(20_000)}`;
			},
			onSessionEnd: async () => {
				calls.push("session-end");
			},
			shutdown: async () => {
				calls.push("shutdown");
			},
		};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => pi.registerMemoryProvider(provider));
					pi.on("session_before_compact", async (event) => {
						compactInstructions = event.customInstructions ?? "";
						return {
							compaction: {
								summary: "memory lifecycle compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("ordinary assistant reply")]);

		await harness.session.prompt("ordinary user turn");
		await vi.waitFor(() => expect(calls).toContain("sync:ordinary user turn:ordinary assistant reply"));

		seedCompactableSession(harness);
		await harness.session.compact("keep caller instruction");

		expect(calls.filter((call) => call === "pre-compress")).toHaveLength(1);
		expect(compactInstructions).toContain("keep caller instruction");
		expect(compactInstructions).toContain("PRESERVE_MEMORY_HANDOFF");
		expect(compactInstructions.length).toBeLessThanOrEqual(5_000);

		await harness.session.disposeAndWait();
		expect(calls.indexOf("session-end")).toBeGreaterThan(calls.indexOf("pre-compress"));
		expect(calls.indexOf("shutdown")).toBeGreaterThan(calls.indexOf("session-end"));
	});

	it("collects the memory handoff once across the summarizer retry ladder", async () => {
		let preCompressCalls = 0;
		const provider: MemoryProvider = {
			name: "retry-handoff-probe",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			onPreCompress: async () => {
				preCompressCalls += 1;
				return "retry-stable handoff";
			},
			shutdown: async () => {},
		};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => pi.registerMemoryProvider(provider));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		seedCompactableSession(harness);
		harness.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("not a valid checkpoint")));

		const result = await harness.session.compact();

		expect(result.summary).toContain("Deterministic checkpoint");
		expect(preCompressCalls).toBe(1);
	});
});
