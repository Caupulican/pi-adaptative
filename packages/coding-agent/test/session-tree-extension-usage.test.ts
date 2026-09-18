import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./suite/harness.ts";

describe("usage from multiple tree-summary extensions", () => {
	it.each(["cancel", "cancel-getter", "cancel-usage-getter", "replace", "instructions", "throw", "mutate"] as const)(
		"preserves the first handler's charge when the next handler chooses %s",
		async (action) => {
			const firstUsage = {
				input: 10,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11,
				cost: { input: 0.01, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.011 },
			};
			const secondUsage = {
				input: 2,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0.002, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			};
			const laterHandler = vi.fn();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_tree", () => ({ summary: { summary: "First summary", usage: firstUsage } }));
					},
					(pi) => {
						pi.on("session_before_tree", () => {
							if (action === "cancel") return { cancel: true };
							if (action === "cancel-getter")
								return {
									cancel: true,
									get customInstructions(): string {
										throw new Error("Cancelled instructions must not be read");
									},
								};
							if (action === "cancel-usage-getter")
								return {
									cancel: true,
									get summary(): never {
										throw new Error("Usage accessor failed");
									},
								};
							if (action === "replace") return { summary: { summary: "Second summary", usage: secondUsage } };
							if (action === "instructions") return { customInstructions: "Use the default summarizer" };
							if (action === "throw") throw new Error("Second handler failed");
							firstUsage.totalTokens = 0;
							firstUsage.input = 0;
							firstUsage.output = 0;
							firstUsage.cost.total = 0;
							firstUsage.cost.input = 0;
							firstUsage.cost.output = 0;
							return { cancel: true };
						});
					},
					(pi) => {
						pi.on("session_before_tree", laterHandler);
					},
				],
			});
			try {
				const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
				harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
				harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
				const messages = harness.session.agent.state.messages;
				const stream = vi.fn(harness.session.agent.streamFn);
				harness.session.agent.streamFn = stream;
				harness.setResponses([fauxAssistantMessage("Default provider summary")]);
				const result = await harness.session.navigateTree(target, { summarize: true });
				const cancelled =
					action === "cancel" ||
					action === "cancel-getter" ||
					action === "cancel-usage-getter" ||
					action === "mutate";
				expect(result.cancelled).toBe(cancelled);
				expect(laterHandler).toHaveBeenCalledTimes(cancelled ? 0 : 1);
				expect(stream).toHaveBeenCalledTimes(action === "instructions" ? 1 : 0);
				const providerUsage =
					action === "instructions" ? (await (await stream.mock.results[0].value).result()).usage : undefined;
				const usage = harness.session.getCumulativeUsage();
				expect(usage.totalTokens).toBe(11 + (action === "replace" ? 3 : 0) + (providerUsage?.totalTokens ?? 0));
				expect(usage.input).toBe(10 + (action === "replace" ? 2 : 0) + (providerUsage?.input ?? 0));
				expect(usage.output).toBe(1 + (action === "replace" ? 1 : 0) + (providerUsage?.output ?? 0));
				expect(usage.cost.total).toBeCloseTo(0.011 + (action === "replace" ? 0.003 : 0), 10);
				expect(harness.session.getSpawnedUsage().reports).toBe(cancelled ? 1 : 0);
				if (cancelled) {
					expect(result.summaryEntry).toBeUndefined();
					expect(harness.session.agent.state.messages).toBe(messages);
				} else {
					expect(result.summaryEntry?.summary).toContain(
						action === "replace"
							? "Second summary"
							: action === "instructions"
								? "Default provider summary"
								: "First summary",
					);
					expect(result.summaryEntry?.usage).toEqual(usage);
				}
				expect(harness.session.isCompacting).toBe(false);
			} finally {
				await harness.cleanup();
			}
		},
	);

	it("retains an overwritten extension charge when default authentication is cancelled", async () => {
		const entered = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const usage = {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0.01, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.011 },
		};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({ summary: { summary: "First summary", usage } }));
				},
				(pi) => {
					pi.on("session_before_tree", () => ({ customInstructions: "Default summary instead" }));
					pi.on("before_provider_headers", async () => {
						entered.resolve();
						await completed.promise;
					});
				},
			],
		});
		try {
			const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
			harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const messages = harness.session.agent.state.messages;
			const stream = vi.fn(harness.session.agent.streamFn);
			harness.session.agent.streamFn = stream;
			const pending = harness.session.navigateTree(target, { summarize: true });
			await entered.promise;
			harness.session.abortBranchSummary();
			completed.resolve();
			expect(await pending).toEqual({ cancelled: true, aborted: true });
			expect(stream).not.toHaveBeenCalled();
			expect(harness.session.agent.state.messages).toBe(messages);
			expect(harness.session.getCumulativeUsage()).toEqual(usage);
			expect(harness.session.getSpawnedUsage().reports).toBe(1);
			expect(harness.session.isCompacting).toBe(false);
		} finally {
			completed.resolve();
			await harness.cleanup();
		}
	});
});
