import type { Agent } from "@caupulican/pi-agent-core/agent";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { FailureCorpusRecorder } from "../src/core/failure-corpus.ts";
import { ForegroundRecoveryController } from "../src/core/foreground-recovery-controller.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

const XAI_GENERATION_ERROR = "Error Code null: Internal error during token generation";

function errorAssistant(provider: string, errorMessage: string): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		provider,
		model: provider === "xai" ? "grok-4.6" : "test-model",
	};
}

function createFixture() {
	const agent = {
		state: { messages: [] },
		hasQueuedMessages: () => false,
		prompt: vi.fn(async () => {}),
		continue: vi.fn(async () => {}),
	} as unknown as Agent;
	const retryStarts: number[] = [];
	const checkCompaction = vi.fn(async () => true);
	const afterRun = vi.fn(async () => {});
	const deps: ConstructorParameters<typeof ForegroundRecoveryController>[0] = {
		agent,
		settingsManager: {
			getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 0 }),
			getProviderRetrySettings: () => ({ maxRetryDelayMs: 60_000 }),
			getFailoverSettings: () => ({ subscriptionHop: false }),
			getAutonomySettings: () => ({ maxStallTurns: 0 }),
		} as unknown as SettingsManager,
		modelRegistry: {} as ModelRegistry,
		failureCorpus: { record: vi.fn() } as unknown as FailureCorpusRecorder,
		getContextWindow: () => 256_000,
		emit: (event) => {
			if (event.type === "auto_retry_start") retryStarts.push(event.attempt);
		},
		checkCompaction,
		onSuccessfulAssistant: vi.fn(),
		prepareRun: async () => {},
		afterRun,
	};
	const controller = new ForegroundRecoveryController(deps);

	return { agent, afterRun, checkCompaction, controller, deps, retryStarts };
}

function fixtureDeps(
	fixture: ReturnType<typeof createFixture>,
): ConstructorParameters<typeof ForegroundRecoveryController>[0] {
	return { ...fixture.deps };
}

async function handleFailure(fixture: ReturnType<typeof createFixture>, message: AssistantMessage): Promise<boolean> {
	fixture.agent.state.messages = [...fixture.agent.state.messages, message];
	fixture.controller.observeAssistant(message);
	return fixture.controller.handlePostAgentRun();
}

describe("ForegroundRecoveryController", () => {
	it("tries an unchanged xAI generation request once, then compacts before another retry", async () => {
		const fixture = createFixture();

		await expect(handleFailure(fixture, errorAssistant("xai", XAI_GENERATION_ERROR))).resolves.toBe(true);
		expect(fixture.retryStarts).toEqual([1]);
		expect(fixture.checkCompaction).not.toHaveBeenCalled();

		await expect(handleFailure(fixture, errorAssistant("xai", XAI_GENERATION_ERROR))).resolves.toBe(true);
		expect(fixture.retryStarts).toEqual([1]);
		expect(fixture.checkCompaction).toHaveBeenCalledOnce();
	});

	it("keeps ordinary retry ordering for another provider's generation error", async () => {
		const fixture = createFixture();

		await handleFailure(fixture, errorAssistant("openai", XAI_GENERATION_ERROR));
		await handleFailure(fixture, errorAssistant("openai", XAI_GENERATION_ERROR));

		expect(fixture.retryStarts).toEqual([1, 2]);
		expect(fixture.checkCompaction).not.toHaveBeenCalled();
	});

	it("requires consecutive identical recovery failures before compacting", async () => {
		const fixture = createFixture();

		await handleFailure(fixture, errorAssistant("xai", XAI_GENERATION_ERROR));
		await handleFailure(fixture, errorAssistant("xai", "network error: fetch failed"));
		await handleFailure(fixture, errorAssistant("xai", XAI_GENERATION_ERROR));

		expect(fixture.retryStarts).toEqual([1, 2, 3]);
		expect(fixture.checkCompaction).not.toHaveBeenCalled();
	});

	it("fails closed instead of shortening a provider wait above retry.provider.maxRetryDelayMs", async () => {
		const fixture = createFixture();
		fixture.checkCompaction.mockResolvedValue(false);
		const failure = errorAssistant("openrouter", "429 rate limit exceeded. Please try again in 1m19.542s.");

		const continued = await handleFailure(fixture, failure);
		expect(fixture.retryStarts).toEqual([]);
		expect(continued).toBe(false);
	});
});

describe("ForegroundRecoveryController submission cancellation", () => {
	it("never enters the run when the submission signal aborts during prepareRun", async () => {
		// The window between a submission's abort listener attaching and the agent having a run to
		// abort is `prepareRun()`. An abort landing there reaches no run through `agent.abort()`, so
		// the read immediately before the run is the only thing that can stop the provider call.
		const fixture = createFixture();
		const cancel = new AbortController();
		const controller = new ForegroundRecoveryController({
			...fixtureDeps(fixture),
			prepareRun: async () => {
				cancel.abort();
			},
		});
		const agent = fixture.agent as unknown as {
			prompt: ReturnType<typeof vi.fn>;
			continue: ReturnType<typeof vi.fn>;
		};

		await expect(
			controller.runAgentPrompt(
				[{ role: "user", content: [{ type: "text", text: "cancelled in flight" }], timestamp: 0 }],
				undefined,
				cancel.signal,
			),
		).resolves.toBeUndefined();

		expect(agent.prompt).not.toHaveBeenCalled();
		expect(agent.continue).not.toHaveBeenCalled();
		expect(fixture.afterRun).toHaveBeenCalledOnce();
		expect(controller.isBusy).toBe(false);
	});

	it("never enters the run when the submission signal aborts before a continuation", async () => {
		const fixture = createFixture();
		const cancel = new AbortController();
		const controller = new ForegroundRecoveryController({
			...fixtureDeps(fixture),
			prepareRun: async () => {
				cancel.abort();
			},
		});
		const agent = fixture.agent as unknown as {
			prompt: ReturnType<typeof vi.fn>;
			continue: ReturnType<typeof vi.fn>;
		};

		await expect(controller.runAgentContinuation(undefined, cancel.signal)).resolves.toBeUndefined();

		expect(agent.continue).not.toHaveBeenCalled();
		expect(agent.prompt).not.toHaveBeenCalled();
		expect(controller.isBusy).toBe(false);
	});

	it("stops the goal loop when the submission signal aborts during post-run recovery", async () => {
		// Post-run recovery awaits too (compaction, retry backoff). An abort landing there has no run
		// to reach either, and without the gate before every further round the next `continue()` would
		// be a full provider turn on a cancelled submission.
		const fixture = createFixture();
		const cancel = new AbortController();
		const agent = fixture.agent as unknown as {
			prompt: ReturnType<typeof vi.fn>;
			continue: ReturnType<typeof vi.fn>;
		};
		let controller: ForegroundRecoveryController | undefined;
		agent.prompt.mockImplementation(async () => {
			controller?.observeAssistant(fauxAssistantMessage("first round"));
		});
		fixture.checkCompaction.mockImplementation(async () => {
			cancel.abort();
			return true;
		});
		controller = new ForegroundRecoveryController(fixtureDeps(fixture));

		await controller.runAgentPrompt(
			[{ role: "user", content: [{ type: "text", text: "loop" }], timestamp: 0 }],
			undefined,
			cancel.signal,
		);

		expect(agent.prompt).toHaveBeenCalledOnce();
		expect(fixture.checkCompaction).toHaveBeenCalledOnce();
		expect(agent.continue).not.toHaveBeenCalled();
		expect(controller.isBusy).toBe(false);
	});

	it("enters the run and keeps looping while the submission signal is quiet", async () => {
		// Control for the gates above: an un-aborted signal changes nothing about the drive loop.
		const fixture = createFixture();
		const cancel = new AbortController();
		const agent = fixture.agent as unknown as {
			prompt: ReturnType<typeof vi.fn>;
			continue: ReturnType<typeof vi.fn>;
		};
		let controller: ForegroundRecoveryController | undefined;
		agent.prompt.mockImplementation(async () => {
			controller?.observeAssistant(fauxAssistantMessage("first round"));
		});
		fixture.checkCompaction.mockResolvedValueOnce(true).mockResolvedValue(false);
		controller = new ForegroundRecoveryController(fixtureDeps(fixture));

		await controller.runAgentPrompt(
			[{ role: "user", content: [{ type: "text", text: "loop" }], timestamp: 0 }],
			undefined,
			cancel.signal,
		);

		expect(agent.prompt).toHaveBeenCalledOnce();
		expect(agent.continue).toHaveBeenCalledOnce();
		expect(controller.isBusy).toBe(false);
	});
});
