import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./suite/harness.ts";

describe("tree navigation cancellation at extension completion", () => {
	it.each([false, true])("retains the current branch after cancellation: summarize=%s", async (summarize) => {
		const entered = Promise.withResolvers<AbortSignal>();
		const completed = Promise.withResolvers<void>();
		const navigated = vi.fn();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async (event) => {
						entered.resolve(event.signal);
						await completed.promise;
						return summarize ? { summary: { summary: "Late extension summary" } } : undefined;
					});
					pi.on("session_tree", navigated);
				},
			],
		});
		try {
			const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
			harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const entries = structuredClone(harness.sessionManager.getEntries());
			const messages = harness.session.agent.state.messages;
			const leaf = harness.sessionManager.getLeafId();
			const reset = vi.spyOn(harness.session.agent, "resetSanitizerPrefixHorizon");
			const pending = harness.session.navigateTree(target, { summarize, label: "must not persist" });
			const signal = await entered.promise;
			harness.session.abortBranchSummary();
			expect(signal.aborted).toBe(true);
			completed.resolve();
			expect(await pending).toEqual({ cancelled: true, aborted: true });
			expect(harness.sessionManager.getEntries()).toEqual(entries);
			expect(harness.sessionManager.getLeafId()).toBe(leaf);
			expect(harness.session.agent.state.messages).toBe(messages);
			expect(reset).not.toHaveBeenCalled();
			expect(navigated).not.toHaveBeenCalled();
			expect(harness.session.isCompacting).toBe(false);
		} finally {
			completed.resolve();
			await harness.cleanup();
		}
	});

	it.each([false, true])("accepts the same extension result without cancellation: summarize=%s", async (summarize) => {
		const navigated = vi.fn();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () =>
						summarize ? { summary: { summary: "Accepted extension summary" } } : undefined,
					);
					pi.on("session_tree", navigated);
				},
			],
		});
		try {
			const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
			harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
			const result = await harness.session.navigateTree(target, { summarize });
			expect(result.cancelled).toBe(false);
			expect(result.editorText).toBe("First");
			expect(result.summaryEntry?.summary).toBe(summarize ? "Accepted extension summary" : undefined);
			expect(harness.sessionManager.getLeafId()).toBe(result.summaryEntry?.id ?? null);
			expect(navigated).toHaveBeenCalledOnce();
			expect(harness.session.isCompacting).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});
});

describe("tree navigation cancellation during authentication", () => {
	it.each([
		{ cancel: true, hasContent: false },
		{ cancel: true, hasContent: true },
		{ cancel: false, hasContent: false },
		{ cancel: false, hasContent: true },
	])("preserves cancellation before summarization: %j", async ({ cancel, hasContent }) => {
		const entered = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const navigated = vi.fn();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_headers", async () => {
						entered.resolve();
						await completed.promise;
					});
					pi.on("session_tree", navigated);
				},
			],
		});
		try {
			const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
			if (hasContent) {
				harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
			} else {
				// This branch has an entry but no summarizable messages. The native summarizer
				// returns synchronously without entering an abort-aware provider transport.
				harness.sessionManager.appendCustomEntry("navigation-fixture", {});
			}
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const entries = structuredClone(harness.sessionManager.getEntries());
			const messages = harness.session.agent.state.messages;
			const leaf = harness.sessionManager.getLeafId();
			const stream = vi.fn(harness.session.agent.streamFn);
			harness.session.agent.streamFn = stream;
			harness.setResponses([fauxAssistantMessage("Generated branch summary")]);
			const pending = harness.session.navigateTree(target, { summarize: true, label: "navigation label" });
			await entered.promise;
			if (cancel) harness.session.abortBranchSummary();
			completed.resolve();
			const result = await pending;
			if (cancel) {
				expect(result).toEqual({ cancelled: true, aborted: true });
				expect(harness.sessionManager.getEntries()).toEqual(entries);
				expect(harness.sessionManager.getLeafId()).toBe(leaf);
				expect(harness.session.agent.state.messages).toBe(messages);
				expect(navigated).not.toHaveBeenCalled();
			} else {
				expect(result.cancelled).toBe(false);
				expect(result.summaryEntry?.summary).toContain(
					hasContent ? "Generated branch summary" : "No content to summarize",
				);
				expect(harness.sessionManager.getLeafEntry()).toMatchObject({
					type: "label",
					parentId: result.summaryEntry?.id,
					targetId: result.summaryEntry?.id,
					label: "navigation label",
				});
				expect(navigated).toHaveBeenCalledOnce();
			}
			expect(stream).toHaveBeenCalledTimes(!cancel && hasContent ? 1 : 0);
			expect(harness.getPendingResponseCount()).toBe(!cancel && hasContent ? 0 : 1);
			expect(harness.session.isCompacting).toBe(false);
		} finally {
			completed.resolve();
			await harness.cleanup();
		}
	});
});

describe("reported summary usage across cancellation", () => {
	it.each([false, true])("retains an extension's received charge exactly once: cancel=%s", async (cancel) => {
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
					pi.on("session_before_tree", async () => {
						entered.resolve();
						await completed.promise;
						return { summary: { summary: "Billed extension summary", usage } };
					});
				},
			],
		});
		try {
			const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
			harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const messages = harness.session.agent.state.messages;
			const pending = harness.session.navigateTree(target, { summarize: true });
			await entered.promise;
			if (cancel) harness.session.abortBranchSummary();
			completed.resolve();
			const result = await pending;
			expect(result.cancelled).toBe(cancel);
			if (cancel) expect(harness.session.agent.state.messages).toBe(messages);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "branch_summary")).toHaveLength(
				cancel ? 0 : 1,
			);
			expect(harness.session.getCumulativeUsage()).toEqual(usage);
			expect(harness.session.isCompacting).toBe(false);
		} finally {
			completed.resolve();
			await harness.cleanup();
		}
	});
});

describe("native summary usage handoff", () => {
	const usage = {
		input: 3,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 4,
		cost: { input: 0.003, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.004 },
	};

	it.each(["stop", "aborted", "error", "length"] as const)(
		"records the actual provider charge once for terminal %s",
		async (stopReason) => {
			const harness = await createHarness();
			try {
				const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
				harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
				harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
				const messages = harness.session.agent.state.messages;
				const stream = vi.fn(harness.session.agent.streamFn);
				harness.session.agent.streamFn = stream;
				harness.setResponses([
					fauxAssistantMessage("Provider summary", { stopReason, errorMessage: "401 Unauthorized" }),
				]);
				const pending = harness.session.navigateTree(target, { summarize: true });
				if (stopReason === "error" || stopReason === "length") {
					await expect(pending).rejects.toThrow(
						stopReason === "error" ? "401 Unauthorized" : "branch summary hit its output cap",
					);
				} else {
					expect((await pending).cancelled).toBe(stopReason === "aborted");
				}
				expect(stream).toHaveBeenCalledOnce();
				// The faux provider computes usage from the actual request; its queued message's
				// usage is not authoritative. Observe the native terminal result instead.
				const response = await (await stream.mock.results[0].value).result();
				expect(response.usage.totalTokens).toBeGreaterThan(0);
				expect(harness.session.getCumulativeUsage()).toEqual(response.usage);
				expect(harness.session.getSpawnedUsage().reports).toBe(stopReason === "stop" ? 0 : 1);
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "branch_summary")).toHaveLength(
					stopReason === "stop" ? 1 : 0,
				);
				if (stopReason !== "stop") expect(harness.session.agent.state.messages).toBe(messages);
				expect(harness.getPendingResponseCount()).toBe(0);
				expect(harness.session.isCompacting).toBe(false);
			} finally {
				await harness.cleanup();
			}
		},
	);

	it.each([false, true])("surfaces receipt failure and clears busy state: cancel=%s", async (cancel) => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => ({ cancel, summary: { summary: "Discarded", usage } }));
				},
			],
		});
		try {
			const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
			harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
			const failure = new Error("usage storage unavailable");
			const append = vi.spyOn(harness.sessionManager, "appendCustomEntry").mockImplementationOnce(() => {
				throw failure;
			});
			// summarize=false also discards an unsolicited, billed extension summary.
			await expect(harness.session.navigateTree(target, { summarize: false })).rejects.toBe(failure);
			expect(append).toHaveBeenCalledOnce();
			expect(harness.session.getCumulativeUsage().totalTokens).toBe(0);
			expect(harness.session.isCompacting).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it.each([new Error("summary write failed"), undefined])(
		"retains both failures, including a falsy thrown value: %s",
		async (primaryFailure) => {
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_tree", async () => ({ summary: { summary: "Billed", usage } }));
					},
				],
			});
			try {
				const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
				harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
				const receiptFailure = new Error("receipt write failed");
				vi.spyOn(harness.sessionManager, "branchWithSummary").mockImplementationOnce(() => {
					throw primaryFailure;
				});
				vi.spyOn(harness.sessionManager, "appendCustomEntry").mockImplementationOnce(() => {
					throw receiptFailure;
				});
				await expect(harness.session.navigateTree(target, { summarize: true })).rejects.toMatchObject({
					name: "AggregateError",
					errors: [primaryFailure, receiptFailure],
				});
				expect(harness.session.isCompacting).toBe(false);
			} finally {
				await harness.cleanup();
			}
		},
	);

	it("does not duplicate a committed summary charge when its label fails", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => ({ summary: { summary: "Billed", usage } }));
				},
			],
		});
		try {
			const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
			harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
			const labelFailure = new Error("label write failed");
			vi.spyOn(harness.sessionManager, "appendLabelChange").mockImplementationOnce(() => {
				throw labelFailure;
			});
			await expect(harness.session.navigateTree(target, { summarize: true, label: "Summary" })).rejects.toBe(
				labelFailure,
			);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "branch_summary")).toHaveLength(1);
			expect(harness.session.getSpawnedUsage().reports).toBe(0);
			expect(harness.session.getCumulativeUsage()).toEqual(usage);
			expect(harness.session.isCompacting).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});
});
