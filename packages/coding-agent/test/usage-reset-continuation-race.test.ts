import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, AssistantMessageEventStream, createEmptyUsage } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DurableCustomMessageTurnController } from "../src/core/durable-custom-message-turn-controller.ts";
import { FailureCorpusRecorder } from "../src/core/failure-corpus.ts";
import {
	ForegroundRecoveryController,
	type ForegroundSubmissionLease,
} from "../src/core/foreground-recovery-controller.ts";
import type { IcmTurnHandle } from "../src/core/memory/continuous-chat-turn-coordinator.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { RuntimeGenerationAdmission } from "../src/core/runtime-generation-admission.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { UsageResetResume } from "../src/core/usage-reset-resume.ts";
import { Agent } from "../src/kernel/agent.ts";
import type { AgentMessage } from "../src/kernel/types.ts";
import { ScriptedProvider } from "./fixtures/harness/scripted-provider.ts";

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const directories: string[] = [];
const disposers: (() => void)[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.parse("2026-11-21T08:00:00Z"));
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("Unexpected network request"))),
	);
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function fixture(held: "acquisition" | "preparation" | "chat") {
	const directory = mkdtempSync(join(tmpdir(), "pi-reset-continuation-"));
	directories.push(directory);
	const model = new ScriptedProvider().model("subscription-a");
	const other = { ...model, id: "owner-selected-b" };
	const refusal: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		usage: createEmptyUsage(),
		stopReason: "error",
		errorMessage: "Usage limit reached. Try again in 2 minutes.",
		timestamp: Date.now(),
	};
	const opening: AgentMessage = { role: "user", content: "Finish this request", timestamp: Date.now() - 1 };
	const requests: string[] = [];
	const agent = new Agent({
		initialState: { model, messages: [opening, refusal] },
		getApiKey: () => "synthetic-key",
		streamFn: (selected) => {
			requests.push(selected.id);
			const stream = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				api: selected.api,
				provider: selected.provider,
				model: selected.id,
				content: [{ type: "text", text: "Done" }],
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		},
	});
	const reached = barrier();
	const release = barrier();
	const markStart = vi.fn();
	const chatTurn: IcmTurnHandle = {
		turnId: 1,
		get boundary(): IcmTurnHandle["boundary"] {
			throw new Error("The foreground must not read the injected chat snapshot");
		},
		lineageStartedAt: Date.now(),
		startedAt: Date.now(),
		markStart,
		startMessage: undefined,
		noteCompaction: () => {},
		latestCompaction: undefined,
		notedCompactions: new Set(),
		frame: undefined,
		noteFrame: () => {},
	};
	const endChat = vi.fn();
	let blocker: ForegroundSubmissionLease | undefined;
	const foreground = new ForegroundRecoveryController({
		agent,
		runtimeAdmission: new RuntimeGenerationAdmission(),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, autonomy: { maxStallTurns: 1 } }),
		modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		failureCorpus: new FailureCorpusRecorder({ filePath: join(directory, "failures.jsonl") }),
		getContextWindow: () => model.contextWindow,
		emit: () => {},
		getInheritedOrigin: () => undefined,
		checkCompaction: async () => false,
		onSuccessfulAssistant: () => {},
		applyFailoverModel: () => undefined,
		prepareRun: async () => {
			if (held === "preparation") {
				reached.resolve();
				await release.promise;
			}
		},
		afterRun: async () => {},
		chatTurns:
			held === "chat"
				? () => ({
						begin: async () => {
							reached.resolve();
							await release.promise;
							return chatTurn;
						},
						end: endChat,
					})
				: undefined,
	});
	const turns = new DurableCustomMessageTurnController({
		foreground,
		goals: { beginExecution: () => {} },
		steering: () => agent,
		appendMessage: async () => {},
		claimCorrection: async () => undefined,
		flushOwnerItems: async () => {},
	});
	const records: unknown[] = [];
	const completed = barrier();
	let continued: boolean | undefined;
	const usage = new UsageResetResume({
		enabled: true,
		clock: {
			now: () => Date.now(),
			setTimeout: (callback, delay) => setTimeout(callback, delay),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		},
		modelRegistry: {
			find: () => model,
			isUsingSubscription: () => true,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "No request expected" }),
		},
		inRunRetryMaxMs: () => 0,
		modelExhaustion: () => undefined,
		transcript: {
			agent,
			sessionManager: {
				getLatestCustomEntryOnBranch: () => undefined,
				appendCustomEntry: (_type, details) => {
					records.push(details);
					return `usage-wake-${records.length}`;
				},
			},
		},
		waitForIdle: async () => {},
		isDisposed: () => false,
		goals: () => ({ getState: () => undefined, resumeUsageLimitedGoal: () => false }),
		continueTurn: async (isCurrent) => {
			if (held === "acquisition") {
				blocker = await foreground.acquireSubmission();
				reached.resolve();
			}
			try {
				continued = await turns.continueAfterErrors(isCurrent);
				return continued;
			} finally {
				completed.resolve();
			}
		},
		warn: () => {},
	});
	disposers.push(() => {
		usage.dispose();
		foreground.shutdown();
	});
	usage.runStopped(refusal, {
		reason: "billing_or_quota",
		retryable: false,
		shouldCompact: false,
		shouldRotateCredential: false,
		shouldFallback: false,
		retryAfterMs: 120000,
		message: refusal.errorMessage!,
	});
	await Promise.resolve();
	await vi.advanceTimersByTimeAsync(120000);
	await reached.promise;
	return {
		agent,
		refusal,
		opening,
		other,
		requests,
		records,
		foreground,
		markStart,
		endChat,
		chatTurn,
		completed,
		get continued() {
			return continued;
		},
		unblock() {
			if (blocker) foreground.releaseSubmission(blocker);
			else release.resolve();
		},
	};
}

describe("ordinary usage-reset continuation under foreground ownership", () => {
	it("releases a chat turn acquired after model selection changes without altering the failed transcript", async () => {
		const run = await fixture("chat");
		const before = run.agent.state.messages;
		run.agent.state.model = run.other;
		run.unblock();
		await run.completed.promise;
		await Promise.resolve();
		expect(run.requests).toEqual([]);
		expect(run.continued).toBe(false);
		expect(run.agent.state.messages).toBe(before);
		expect(run.agent.state.messages).toEqual([run.opening, run.refusal]);
		expect(run.markStart).not.toHaveBeenCalled();
		expect(run.endChat).toHaveBeenCalledExactlyOnceWith(run.chatTurn);
		expect(run.foreground.getResourceSnapshot()).toMatchObject({
			activeRuns: 0,
			submissionEpoch: undefined,
			idleWaiters: 0,
		});
	});

	it("marks and releases the same-model chat turn around the one continuation", async () => {
		const run = await fixture("chat");
		run.unblock();
		await run.completed.promise;
		await Promise.resolve();
		expect(run.requests).toEqual(["subscription-a"]);
		expect(run.continued).toBe(true);
		expect(run.markStart).toHaveBeenCalledExactlyOnceWith(run.opening, true);
		expect(run.endChat).toHaveBeenCalledExactlyOnceWith(run.chatTurn);
		expect(run.foreground.getResourceSnapshot()).toMatchObject({
			activeRuns: 0,
			submissionEpoch: undefined,
			idleWaiters: 0,
		});
	});

	it.each(["acquisition", "preparation"] as const)("lapses after model selection changes during %s", async (held) => {
		const run = await fixture(held);
		const before = run.agent.state.messages;
		run.agent.state.model = run.other;
		run.unblock();
		await run.completed.promise;
		await Promise.resolve();
		expect(run.requests).toEqual([]);
		expect(run.continued).toBe(false);
		expect(run.agent.state.messages).toBe(before);
		expect(run.agent.state.messages).toEqual([run.opening, run.refusal]);
		expect(run.records).toContainEqual(expect.objectContaining({ outcome: "lapsed" }));
		expect(run.foreground.getResourceSnapshot()).toMatchObject({
			activeRuns: 0,
			submissionEpoch: undefined,
			idleWaiters: 0,
		});
	});

	it.each(["acquisition", "preparation"] as const)("preserves a newer refusal received during %s", async (held) => {
		const run = await fixture(held);
		const replacement = { ...run.refusal, errorMessage: "A different request stopped", timestamp: Date.now() + 1 };
		run.agent.state.messages = [run.opening, replacement];
		const before = run.agent.state.messages;
		run.unblock();
		await run.completed.promise;
		await Promise.resolve();
		expect(run.requests).toEqual([]);
		expect(run.continued).toBe(false);
		expect(run.agent.state.messages).toBe(before);
		expect(run.records).toContainEqual(expect.objectContaining({ outcome: "lapsed" }));
		expect(run.foreground.getResourceSnapshot()).toMatchObject({
			activeRuns: 0,
			submissionEpoch: undefined,
			idleWaiters: 0,
		});
	});

	it.each(["acquisition", "preparation"] as const)("continues once on the same model after %s", async (held) => {
		const run = await fixture(held);
		run.unblock();
		await run.completed.promise;
		await Promise.resolve();
		expect(run.continued).toBe(true);
		expect(run.requests).toEqual(["subscription-a"]);
		expect(run.agent.state.messages).toHaveLength(2);
		expect(run.agent.state.messages).not.toContain(run.refusal);
		expect(run.records).toContainEqual(expect.objectContaining({ outcome: "resumed" }));
		expect(run.foreground.getResourceSnapshot()).toMatchObject({
			activeRuns: 0,
			submissionEpoch: undefined,
			idleWaiters: 0,
		});
	});
});
