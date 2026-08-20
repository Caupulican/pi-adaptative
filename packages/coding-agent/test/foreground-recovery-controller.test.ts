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
	} as unknown as Agent;
	const retryStarts: number[] = [];
	const checkCompaction = vi.fn(async () => true);
	const controller = new ForegroundRecoveryController({
		agent,
		settingsManager: {
			getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 0 }),
			getFailoverSettings: () => ({ subscriptionHop: false }),
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
		afterRun: async () => {},
	});

	return { agent, checkCompaction, controller, retryStarts };
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
});
