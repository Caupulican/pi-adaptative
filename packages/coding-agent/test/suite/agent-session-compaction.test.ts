import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ProviderRequestCompactionDecision,
	ProviderRequestCompactionInput,
} from "../../src/core/compaction-controller.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
	_resolveCompactionModel: (sessionModel: Model<string>) => Model<string>;
	_compaction: {
		admitProviderRequest(input: ProviderRequestCompactionInput): Promise<ProviderRequestCompactionDecision>;
	};
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFn = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage(
		createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: now - 500,
		}),
	);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

		expect(result.summary).toBe("summary from extension");
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const summary = [
			"## Active Task",
			"User: message to compact",
			"",
			"### Mandatory Rules",
			"(none)",
			"",
			"## Working Set",
			"(none)",
			"",
			"## Files",
			"(none)",
			"",
			"## Open Problems",
			"(none)",
			"",
			"## Done",
			"(none)",
			"",
			"## Key Decisions",
			"(none)",
			"",
			"## Constraints & Preferences",
			"(none)",
			"",
			"## Critical Context",
			"(none)",
		].join("\n");
		const getStreamCallCount = useSummaryStreamFn(harness, summary);

		const result = await harness.session.compact();

		expect(result.summary).toBe(summary);
		expect(getStreamCallCount()).toBe(1);
	});

	it("manual compaction falls through the retry ladder to a deterministic checkpoint on gate failure", async () => {
		const harness = await createHarness({ withConfiguredAuth: true });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "not a checkpoint");

		const result = await harness.session.compact();

		expect(result.summary).toContain("Deterministic checkpoint");
		expect(getStreamCallCount()).toBe(6);
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.details).toMatchObject({
			verificationGateFailures: 6,
			verificationGateChecks: {
				"active-task-containment": {
					failures: 6,
					minScore: 0,
					maxScore: 0,
					threshold: 1,
					comparator: "minimum",
				},
			},
		});
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(
			harness,
			"## Active Task\nUser: message to compact\n\n### Mandatory Rules\n(none)\n\n## Files\n(none)\n\n## Done\n(none)\n\n## Constraints & Preferences\n(none)\n\n## Key Decisions\n(none)\n\n## Blocked / Open\n(none)\n\n## Critical Context\nauto summary from custom stream",
		);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(getStreamCallCount()).toBe(1);
	});

	it("overflow auto-compaction applies once even when measured context is below threshold", async () => {
		const harness = await createHarness({
			settings: { compaction: { reserveTokens: 10_000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "overflow-test" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		harness.sessionManager.appendMessage(
			createAssistant(harness, {
				stopReason: "stop",
				totalTokens: 100,
				timestamp: now - 500,
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("overflow", true)).resolves.toBe(true);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.summary).toBe("overflow compacted");
	});

	it("uses the model-router cheap model for default compaction model selection", async () => {
		const harness = await createHarness({
			models: [
				{ id: "frontier", cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 } },
				{ id: "router-cheap", cost: { input: 4, output: 12, cacheRead: 0, cacheWrite: 0 } },
				{ id: "cost-router", cost: { input: -1_000_000, output: -1_000_000, cacheRead: 0, cacheWrite: 0 } },
			],
			settings: { modelRouter: { enabled: true, cheapModel: "faux/router-cheap" } },
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const compactionModel = sessionInternals._resolveCompactionModel(harness.getModel());

		expect(compactionModel.id).toBe("router-cheap");
	});

	it("falls back to the session model for default compaction model selection", async () => {
		const harness = await createHarness({
			models: [
				{ id: "frontier", cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 } },
				{ id: "cost-router", cost: { input: -1_000_000, output: -1_000_000, cacheRead: 0, cacheWrite: 0 } },
			],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const compactionModel = sessionInternals._resolveCompactionModel(harness.getModel());

		expect(compactionModel.id).toBe("frontier");
	});

	it("uses low thinking for default compaction on the session model", async () => {
		const harness = await createHarness({
			models: [{ id: "frontier", reasoning: true }],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.setThinkingLevel("xhigh");
		let observedReasoning: unknown;
		harness.session.agent.streamFn = (model, _context, options) => {
			observedReasoning = options?.reasoning;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					...fauxAssistantMessage("summary with low thinking"),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(10),
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		await harness.session.compact();

		expect(observedReasoning).toBe("low");
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("preserves queued messages when compaction fails", async () => {
		let harness: Harness;
		harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						harness.session.agent.followUp({
							role: "user",
							content: [{ type: "text", text: "queued after compaction failure" }],
							timestamp: Date.now(),
						});
						throw new Error("synthetic compaction failure");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("overflow", false)).resolves.toBe(true);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for usage-less provider when estimated tokens exceed threshold (F13)", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 2000 }],
		});
		harnesses.push(harness);

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		// Large text message that exceeds the threshold (contextWindow 2000 - reserveTokens 1000 = 1000 tokens ≈ 4000 chars)
		const longText = "a".repeat(6000);
		const usageLessAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 0,
			timestamp: Date.now(),
		});
		// usage is completely 0 / omitted
		usageLessAssistant.usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: longText }], timestamp: Date.now() - 100 },
			usageLessAssistant,
		];

		await sessionInternals._checkCompaction(usageLessAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("triggers threshold compaction on error for usage-less provider when estimated tokens exceed threshold (F13)", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 2000 }],
		});
		harnesses.push(harness);

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		const longText = "a".repeat(6000);
		const usageLessErrorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "generic error",
			totalTokens: 0,
			timestamp: Date.now(),
		});
		usageLessErrorAssistant.usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: longText }], timestamp: Date.now() - 100 },
			usageLessErrorAssistant,
		];

		await sessionInternals._checkCompaction(usageLessErrorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not re-trigger threshold compaction from a stale usage-bearing message predating the last compaction (F13 staleness-guard regression)", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 2000 }],
		});
		harnesses.push(harness);

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		const now = Date.now();
		// A large, usage-bearing assistant message from BEFORE the compaction boundary below.
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 1_800,
			timestamp: now - 10_000,
		});
		const staleUserEntryId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old request" }],
			timestamp: now - 10_100,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		// Records a compaction boundary AFTER staleAssistant in the branch.
		harness.sessionManager.appendCompaction("old summary", staleUserEntryId, 1_800);

		// The current (post-compaction) turn errors with no usable usage of its own. F13 makes
		// check() fall back to a size ESTIMATE in that case, but the only usage info the estimator
		// can find anywhere in agent.state.messages is the STALE pre-compaction usage above — the
		// staleness guard must still refuse to trust it rather than re-triggering compaction from it.
		const currentErrorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "generic error",
			totalTokens: 0,
			timestamp: now + 5_000,
		});
		currentErrorAssistant.usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "old request" }], timestamp: now - 10_100 },
			staleAssistant,
			currentErrorAssistant,
		];

		await sessionInternals._checkCompaction(currentErrorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("compacts via the admission gate before the next send when the provider never reports usage (F13 systemic negative control)", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 2000 }],
		});
		harnesses.push(harness);

		// Seed enough usage-less history that the very first request's materialized size alone
		// crosses the admission gate's threshold — before check()'s between-turns path could ever
		// have run (there is no prior assistant response yet).
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "a".repeat(6000) }],
			timestamp: Date.now() - 1000,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const model = harness.getModel();
		harness.session.agent.streamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					...fauxAssistantMessage("ok"),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		// vi.spyOn without a replacement implementation still calls through to the real method —
		// this only observes admission decisions, it never substitutes them.
		const admitSpy = vi.spyOn(sessionInternals._compaction, "admitProviderRequest");

		await harness.session.prompt("continue");

		expect(admitSpy).toHaveBeenCalled();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries.length).toBeGreaterThan(0);
	});
});
