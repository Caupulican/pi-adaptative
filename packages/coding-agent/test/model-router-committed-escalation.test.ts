import type { Agent, AgentMessage } from "@caupulican/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, Usage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { RouteDecision } from "../src/core/autonomy/contracts.ts";
import type { ModelRouterSessionBuffer } from "../src/core/model-router/session-buffer.ts";
import type { ModelRouterControllerDeps } from "../src/core/model-router-controller.ts";
import { ModelRouterController } from "../src/core/model-router-controller.ts";

const cheapModel = makeModel("cheap");
const expensiveModel = makeModel("expensive");

function makeModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "faux",
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: Date.now(),
		usage: usage(),
	};
}

const cheapRoute: RouteDecision = {
	tier: "cheap",
	risk: "read-only",
	confidence: 1,
	reasonCode: "explain",
	reasons: [],
};

interface RouterProbe {
	controller: ModelRouterController;
	agent: {
		state: { model: Model<Api>; thinkingLevel: "high"; messages: AgentMessage[]; tools: []; systemPrompt: string };
	};
	persisted: Message[];
	models: string[];
}

function makeProbe(throwAfterCommit: boolean): RouterProbe {
	const persisted: Message[] = [];
	const models: string[] = [];
	const agent = {
		state: {
			model: expensiveModel,
			thinkingLevel: "high" as const,
			messages: [] as AgentMessage[],
			tools: [] as [],
			systemPrompt: "BASE",
		},
	};
	let controller!: ModelRouterController;
	const sessionEntries: unknown[] = [];
	const deps: ModelRouterControllerDeps = {
		getAgent: () => agent as unknown as Agent,
		getModel: () => expensiveModel,
		getSettingsManager: () =>
			({
				getModelRouterSettings: () => ({ enabled: true, expensiveModel: "faux/expensive" }),
				getModelCapabilitySettings: () => ({ mode: "off" }),
				getToolkitScripts: () => [],
			}) as never,
		getSessionManager: () =>
			({
				getEntries: () => sessionEntries,
				appendCustomEntry: (customType: string, data: unknown) => {
					sessionEntries.push({ customType, data });
					return "decision-entry";
				},
			}) as never,
		appendSessionMessageBatch: (batch) => {
			for (const entry of batch) if (entry.kind === "message") persisted.push(entry.message);
			return batch.map((_, index) => `message-${persisted.length - batch.length + index + 1}`);
		},
		getModelRegistry: () =>
			({
				hasConfiguredAuth: () => true,
				getAll: () => [cheapModel, expensiveModel],
			}) as never,
		isModelExhausted: () => false,
		getFailoverStatus: () => ({ exhausted: [] }),
		getAgentDir: () => "/tmp/pi-router-committed-escalation",
		getReflectionSignal: () => new AbortController().signal,
		getBaseSystemPrompt: () => "BASE",
		runAgentPrompt: async () => {
			models.push(agent.state.model.id);
			const message = assistant(agent.state.model, "durable cheap result");
			agent.state.messages.push(message);
			const buffer = (controller as unknown as { _modelRouterSessionBuffer?: ModelRouterSessionBuffer })
				._modelRouterSessionBuffer;
			if (!buffer) throw new Error("router buffer was not created");
			buffer.messages.push({ kind: "message", message });
			buffer.committed = true;
			persisted.push(message);
			(controller as unknown as { _modelRouterEscalationRequested: boolean })._modelRouterEscalationRequested = true;
			if (throwAfterCommit) throw new Error("failure after durable commit");
		},
		runAgentContinuation: async () => {
			models.push(agent.state.model.id);
			const message = assistant(agent.state.model, "continued from canonical history");
			agent.state.messages.push(message);
			persisted.push(message);
		},
		buildSystemPromptForToolNames: () => "ROUTED",
		refreshCurrentModelFromRegistry: () => {},
		runIsolatedCompletion: async () => {
			throw new Error("isolated completion is not expected");
		},
		addSpawnedUsage: () => undefined,
		emit: () => {},
		emitAutonomyTelemetry: () => {},
		resolveLaneModel: () => undefined,
		resolveCurationModelIfFit: () => undefined,
		getToolProbeVerdict: () => undefined,
	};
	controller = new ModelRouterController(deps);
	return { controller, agent, persisted, models };
}

describe("committed model-router history", () => {
	it("continues from canonical history after escalation without splicing durable messages", async () => {
		const probe = makeProbe(false);
		await probe.controller.runRoutedTurn([], cheapModel, cheapRoute);
		expect(probe.models).toEqual(["cheap", "expensive"]);
		expect(probe.agent.state.messages).toHaveLength(2);
		expect(probe.persisted).toHaveLength(2);
		expect((probe.agent.state.messages[0] as AssistantMessage).content[0]).toMatchObject({
			text: "durable cheap result",
		});
	});

	it("keeps canonical messages when the committed route throws", async () => {
		const probe = makeProbe(true);
		await expect(probe.controller.runRoutedTurn([], cheapModel, cheapRoute)).rejects.toThrow(
			"failure after durable commit",
		);
		expect(probe.agent.state.messages).toHaveLength(1);
		expect(probe.persisted).toHaveLength(1);
	});
});
