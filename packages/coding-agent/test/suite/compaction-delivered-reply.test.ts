import type { Api, Model } from "@caupulican/pi-ai";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { type LastSentRequest, sessionLaneSummarizerRequest } from "../../src/core/compaction-support.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("compaction after a delivered reply", () => {
	it("extends the last sent provider context with that reply", async () => {
		const harness = await createHarness();
		const reply = "Read. Waiting for the next step.";
		harness.setResponses([fauxAssistantMessage(reply)]);
		await harness.session.prompt("Read the projects, then wait.");

		const lastSent = (harness.session as unknown as { _lastSentRequest?: LastSentRequest })._lastSentRequest;
		const model = harness.session.model as Model<Api>;
		const liveMessages = harness.session.agent.state.messages;
		const request = sessionLaneSummarizerRequest({
			compactionModel: model,
			sessionModel: model,
			systemPrompt: harness.session.agent.state.systemPrompt,
			tools: [],
			messagesToSummarize: liveMessages,
			liveMessages,
			lastSent,
			textToolCallProtocol: harness.session.agent.textToolCallProtocol,
			sessionId: harness.session.sessionManager.getSessionId(),
		});

		expect(lastSent).toBeDefined();
		expect(lastSent?.sourceMessages).toHaveLength(liveMessages.length - 1);
		expect(request?.sentContext?.messages.at(-1)?.role).toBe("assistant");
		expect(getMessageText(request?.sentContext?.messages.at(-1))).toContain(reply);
	});
});
