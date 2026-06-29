import type { AgentMessage, AgentTool, ThinkingLevel } from "@caupulican/pi-agent-core";
import type { AssistantMessage, Message, Model, Usage } from "@caupulican/pi-ai";
import { fauxAssistantMessage, fauxToolCall, getModel } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { MODEL_ROUTER_DECISION_CUSTOM_TYPE, type ModelRouterDecisionStatus } from "../src/core/model-router/status.ts";
import { createHarness } from "./suite/harness.ts";

type RouterSettings = { enabled: boolean; cheapModel?: string; expensiveModel?: string };
type RouterContext = {
	settingsManager: {
		getModelRouterSettings: () => RouterSettings;
	};
	sessionManager: { getEntries: () => [] };
	_modelRegistry: {
		getAll: () => Model<any>[];
		hasConfiguredAuth: (model: Model<any>) => boolean;
	};
};

type RoutedRunContext = {
	model: Model<any> | undefined;
	agent: { state: { model: Model<any> | undefined; thinkingLevel: ThinkingLevel; messages: AgentMessage[] } };
	sessionManager: {
		appendMessage: (message: Message) => string;
		appendCustomEntry: (customType: string, data?: unknown) => string;
	};
	_runAgentPrompt: (messages: AgentMessage | AgentMessage[]) => Promise<void>;
	_resolveModelRouterModelForIntent: (intent: "research" | "modify") => Model<any> | undefined;
	_runAgentPromptWithModelRouter?: AgentSessionRouterPrototype["_runAgentPromptWithModelRouter"];
};

type AgentSessionRouterPrototype = {
	_resolveModelRouterTurnModel(this: RouterContext, prompt: string): Model<any> | undefined;
	_runAgentPromptWithModelRouter(
		this: RoutedRunContext,
		messages: AgentMessage | AgentMessage[],
		routedModel: Model<any> | undefined,
		routedIntent: "research" | "modify" | undefined,
	): Promise<void>;
};

const routerPrototype = AgentSession.prototype as unknown as AgentSessionRouterPrototype;
const cheapModel = getModel("anthropic", "claude-haiku-4-5")!;
const expensiveModel = getModel("anthropic", "claude-sonnet-4-5")!;
const bashParameters = Type.Object({ command: Type.String() });
const bashTool: AgentTool<typeof bashParameters> = {
	name: "bash",
	label: "Bash",
	description: "Run a shell command",
	parameters: bashParameters,
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createContext(
	settings: RouterSettings,
	authenticatedModels: Model<any>[] = [cheapModel, expensiveModel],
): RouterContext {
	return Object.assign(Object.create(AgentSession.prototype), {
		settingsManager: {
			getModelRouterSettings: () => settings,
		},
		sessionManager: { getEntries: () => [] },
		_modelRegistry: {
			getAll: () => [cheapModel, expensiveModel],
			hasConfiguredAuth: (model: Model<any>) =>
				authenticatedModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id),
		},
	});
}

describe("AgentSession model router turn selection", () => {
	it("does not duplicate user message_start events and preserves escalated status after cheap-to-expensive retry", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "expensive" }],
			tools: [bashTool],
			settings: {
				modelRouter: {
					enabled: true,
					cheapModel: "faux/cheap",
					expensiveModel: "faux/expensive",
				},
			},
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "cp source target" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("retried on expensive"),
			]);

			await harness.session.prompt("Explain whether this command is safe: cp source target");

			const userStarts = harness.eventsOfType("message_start").filter((event) => event.message.role === "user");
			expect(userStarts).toHaveLength(1);
			expect(harness.session.getModelRouterStatus()).toContain(
				"research -> faux/cheap (escalated -> faux/expensive)",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("does nothing when model routing is disabled", () => {
		const selected = routerPrototype._resolveModelRouterTurnModel.call(
			createContext({ enabled: false, cheapModel: "anthropic/claude-haiku-4-5" }),
			"Explain this code block",
		);

		expect(selected).toBeUndefined();
	});

	it("selects the cheap model for authenticated research turns", () => {
		const selected = routerPrototype._resolveModelRouterTurnModel.call(
			createContext({
				enabled: true,
				cheapModel: "anthropic/claude-haiku-4-5",
				expensiveModel: "anthropic/claude-sonnet-4-5",
			}),
			"Explain this code block",
		);

		expect(selected?.id).toBe("claude-haiku-4-5");
	});

	it("selects the expensive model for authenticated modify turns", () => {
		const selected = routerPrototype._resolveModelRouterTurnModel.call(
			createContext({
				enabled: true,
				cheapModel: "anthropic/claude-haiku-4-5",
				expensiveModel: "anthropic/claude-sonnet-4-5",
			}),
			"Fix the failing tests",
		);

		expect(selected?.id).toBe("claude-sonnet-4-5");
	});

	it("refuses to route to a configured model without auth", () => {
		const context = createContext(
			{
				enabled: true,
				cheapModel: "anthropic/claude-haiku-4-5",
				expensiveModel: "anthropic/claude-sonnet-4-5",
			},
			[expensiveModel],
		);
		const selected = routerPrototype._resolveModelRouterTurnModel.call(context, "Explain this code block");

		expect(selected).toBeUndefined();
		expect(AgentSession.prototype.getModelRouterStatus.call(context)).toContain(
			"Routing: skipped (cheap model missing auth: anthropic/claude-haiku-4-5)",
		);
		expect(AgentSession.prototype.getModelRouterStatus.call(context)).toContain("Latest intent: research");
	});

	it("reports unresolved configured model when routing is skipped", () => {
		const context = createContext({
			enabled: true,
			cheapModel: "definitely-not-a-model",
			expensiveModel: "anthropic/claude-sonnet-4-5",
		});
		const selected = routerPrototype._resolveModelRouterTurnModel.call(context, "Explain this code block");

		expect(selected).toBeUndefined();
		expect(AgentSession.prototype.getModelRouterStatus.call(context)).toContain(
			"Routing: skipped (cheap model unresolved: definitely-not-a-model)",
		);
		expect(AgentSession.prototype.getModelRouterStatus.call(context)).toContain("Latest intent: research");
	});

	it("includes current config diagnostics in model-router session status", () => {
		const context = createContext({
			enabled: true,
			cheapModel: "definitely-not-a-model",
			expensiveModel: "anthropic/claude-sonnet-4-5",
		});

		const status = AgentSession.prototype.getModelRouterStatus.call(context);

		expect(status).toContain("Config diagnostics:");
		expect(status).toContain("- Model router cheap model is unresolved: definitely-not-a-model.");
	});

	it("reports expensive model auth failures for modify prompts", () => {
		const context = createContext(
			{
				enabled: true,
				cheapModel: "anthropic/claude-haiku-4-5",
				expensiveModel: "anthropic/claude-sonnet-4-5",
			},
			[cheapModel],
		);
		const selected = routerPrototype._resolveModelRouterTurnModel.call(context, "Fix the failing tests");

		expect(selected).toBeUndefined();
		expect(AgentSession.prototype.getModelRouterStatus.call(context)).toContain(
			"Routing: skipped (expensive model missing auth: anthropic/claude-sonnet-4-5)",
		);
		expect(AgentSession.prototype.getModelRouterStatus.call(context)).toContain("Latest intent: modify");
	});

	it("reports unresolved expensive model configuration for modify prompts", () => {
		const context = createContext({
			enabled: true,
			cheapModel: "anthropic/claude-haiku-4-5",
			expensiveModel: "definitely-not-a-model",
		});
		const selected = routerPrototype._resolveModelRouterTurnModel.call(context, "Fix the failing tests");

		expect(selected).toBeUndefined();
		expect(AgentSession.prototype.getModelRouterStatus.call(context)).toContain(
			"Routing: skipped (expensive model unresolved: definitely-not-a-model)",
		);
		expect(AgentSession.prototype.getModelRouterStatus.call(context)).toContain("Latest intent: modify");
	});

	it("uses routed models only for the current turn and restores session state", async () => {
		let modelDuringRun: Model<any> | undefined;
		const persistedDecisions: ModelRouterDecisionStatus[] = [];
		const context: RoutedRunContext = {
			model: expensiveModel,
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [] } },
			sessionManager: {
				appendMessage: () => "entry",
				appendCustomEntry: (_customType, data) => {
					persistedDecisions.push(data as ModelRouterDecisionStatus);
					return "custom";
				},
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_runAgentPrompt: async () => {
				modelDuringRun = context.agent.state.model;
			},
		};

		await routerPrototype._runAgentPromptWithModelRouter.call(
			context,
			{ role: "user", content: [{ type: "text", text: "Explain this code block" }], timestamp: 0 },
			cheapModel,
			"research",
		);

		expect(modelDuringRun?.id).toBe("claude-haiku-4-5");
		expect(context.agent.state.model?.id).toBe("claude-sonnet-4-5");
		expect(context.agent.state.thinkingLevel).toBe("high");
		expect(persistedDecisions).toEqual([
			{ intent: "research", routedModel: "anthropic/claude-haiku-4-5", outcome: "routed" },
		]);
	});

	it("discards buffered cheap-turn messages and retries on expensive model after escalation", async () => {
		const persisted: Message[] = [];
		const persistedDecisions: Array<{ customType: string; data?: unknown }> = [];
		const modelsDuringRuns: string[] = [];
		const context: RoutedRunContext & { _modelRouterEscalationRequested?: boolean } = {
			model: expensiveModel,
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [] } },
			sessionManager: {
				appendMessage: (message) => {
					persisted.push(message);
					return "entry";
				},
				appendCustomEntry: (customType, data) => {
					persistedDecisions.push({ customType, data });
					return "custom";
				},
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_runAgentPrompt: async () => {
				modelsDuringRuns.push(context.agent.state.model?.id ?? "none");
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: `response-${modelsDuringRuns.length}` }],
					api: expensiveModel.api,
					provider: context.agent.state.model?.provider ?? expensiveModel.provider,
					model: context.agent.state.model?.id ?? expensiveModel.id,
					stopReason: "stop",
					timestamp: modelsDuringRuns.length,
					usage: createUsage(),
				};
				context.agent.state.messages.push(message);
				if (modelsDuringRuns.length === 1) {
					context._modelRouterEscalationRequested = true;
				} else if (context.agent.state.messages[0]) {
					context.sessionManager.appendMessage(context.agent.state.messages[0] as Message);
				}
			},
		};

		await routerPrototype._runAgentPromptWithModelRouter.call(
			context,
			{ role: "user", content: [{ type: "text", text: "Explain this code block" }], timestamp: 0 },
			cheapModel,
			"research",
		);

		expect(modelsDuringRuns).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5"]);
		expect(context.agent.state.messages.map((message) => message.role)).toEqual(["assistant"]);
		expect(persisted).toHaveLength(1);
		const persistedMessage = persisted[0] as AssistantMessage;
		expect((persistedMessage.content[0] as { text: string }).text).toBe("response-2");
		expect(persistedDecisions).toEqual([
			{
				customType: MODEL_ROUTER_DECISION_CUSTOM_TYPE,
				data: {
					intent: "research",
					routedModel: "anthropic/claude-haiku-4-5",
					outcome: "escalated",
					retryModel: "anthropic/claude-sonnet-4-5",
				},
			},
		]);
	});
});
