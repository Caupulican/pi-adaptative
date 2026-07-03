import type { AgentMessage, AgentTool, ThinkingLevel } from "@caupulican/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, Usage } from "@caupulican/pi-ai";
import { clampThinkingLevel, fauxAssistantMessage, fauxToolCall, getModel } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { RouteDecision } from "../src/core/autonomy/contracts.ts";
import { MODEL_ROUTER_DECISION_CUSTOM_TYPE, type ModelRouterDecisionStatus } from "../src/core/model-router/status.ts";
import { FitnessStore } from "../src/core/models/fitness-store.ts";
import type { ModelFitnessReport } from "../src/core/research/model-fitness.ts";
import { createHarness } from "./suite/harness.ts";

type TestModel = Model<Api>;

type RouterSettings = {
	enabled: boolean;
	cheapModel?: string;
	mediumModel?: string;
	expensiveModel?: string;
};

type RouterContext = {
	settingsManager: {
		getModelRouterSettings: () => RouterSettings;
	};
	sessionManager: { getEntries: () => [] };
	_modelRegistry: {
		getAll: () => TestModel[];
		hasConfiguredAuth: (model: TestModel) => boolean;
	};
};

/** Per-tier thinking configuration surfaced by the real settingsManager.getModelRouterSettings(). */
type RouterTierThinkingSettings = {
	cheapThinking?: ThinkingLevel;
	mediumThinking?: ThinkingLevel;
	expensiveThinking?: ThinkingLevel;
	executorThinking?: ThinkingLevel;
	judgeThinking?: ThinkingLevel;
};

type RoutedRunContext = {
	model: TestModel | undefined;
	agent: {
		state: {
			model: TestModel | undefined;
			thinkingLevel: ThinkingLevel;
			messages: AgentMessage[];
			tools: Array<{ name: string }>;
			systemPrompt?: string;
		};
	};
	settingsManager: {
		getModelCapabilitySettings: () => { mode?: string };
		getModelRouterSettings: () => RouterTierThinkingSettings;
	};
	sessionManager: {
		appendMessage: (message: Message) => string;
		appendCustomEntry: (customType: string, data?: unknown) => string;
		appendCustomMessageEntry: (customType: string, content: unknown, display: string, details?: unknown) => string;
	};
	_baseSystemPrompt?: string;
	_buildSystemPromptForToolNames?: (toolNames: string[]) => string;
	_runAgentPrompt: (messages: AgentMessage | AgentMessage[]) => Promise<void>;
	_refreshCurrentModelFromRegistry?: () => void;
	_emit?: (event: { type: string; message?: string }) => void;
	_emitAutonomyTelemetry?: (event: unknown) => void;
	_isModelRouterRetry?: boolean;
	_resolveModelRouterModelForIntent: (intent: "research" | "modify") => TestModel | undefined;
	_runAgentPromptWithModelRouter?: AgentSessionRouterPrototype["_runAgentPromptWithModelRouter"];
};

type AgentSessionRouterPrototype = {
	_resolveModelRouterTurnModel(this: RouterContext, prompt: string): TestModel | undefined;
	_resolveModelRouterTurnRoute(
		this: RouterContext,
		prompt: string,
	): { decision: RouteDecision; model: TestModel } | undefined;
	_runAgentPromptWithModelRouter(
		this: RoutedRunContext,
		messages: AgentMessage | AgentMessage[],
		routedModel: TestModel | undefined,
		routeDecision: RouteDecision | undefined,
	): Promise<void>;
};

const routerPrototype = AgentSession.prototype as unknown as AgentSessionRouterPrototype;
const cheapModel = getModel("anthropic", "claude-haiku-4-5")! as TestModel;
const mediumModel = getModel("anthropic", "claude-3-5-sonnet-20241022")! as TestModel;
const expensiveModel = getModel("anthropic", "claude-sonnet-4-5")! as TestModel;

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
	authenticatedModels: TestModel[] = [cheapModel, mediumModel, expensiveModel],
): RouterContext {
	return Object.assign(Object.create(AgentSession.prototype), {
		settingsManager: {
			getModelRouterSettings: () => settings,
		},
		sessionManager: { getEntries: () => [] },
		_modelRegistry: {
			getAll: () => [cheapModel, mediumModel, expensiveModel],
			hasConfiguredAuth: (model: TestModel) =>
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
				"cheap/read-only -> faux/cheap (read_only_question, escalated -> faux/expensive)",
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

	it("selects the medium model for normal implementation prompts", () => {
		const context = createContext({
			enabled: true,
			cheapModel: "anthropic/claude-haiku-4-5",
			mediumModel: "anthropic/claude-3-5-sonnet-20241022",
			expensiveModel: "anthropic/claude-sonnet-4-5",
		});
		const resolved = routerPrototype._resolveModelRouterTurnRoute.call(
			context,
			"Implement a small fix and update the relevant unit test.",
		);

		expect(resolved?.model.id).toBe("claude-3-5-sonnet-20241022");
		expect(resolved?.decision.tier).toBe("medium");
		expect(resolved?.decision.risk).toBe("scoped-write");
	});

	it("selects the expensive model for authenticated modify turns", () => {
		const selected = routerPrototype._resolveModelRouterTurnModel.call(
			createContext({
				enabled: true,
				cheapModel: "anthropic/claude-haiku-4-5",
				expensiveModel: "anthropic/claude-sonnet-4-5",
			}),
			"Publish a release and push the tag.",
		);

		expect(selected?.id).toBe("claude-sonnet-4-5");
	});

	it("falls back to expensive when medium model is missing or lacks auth", () => {
		const context = createContext(
			{
				enabled: true,
				cheapModel: "anthropic/claude-haiku-4-5",
				mediumModel: "anthropic/claude-3-5-sonnet-20241022",
				expensiveModel: "anthropic/claude-sonnet-4-5",
			},
			[cheapModel, expensiveModel], // medium model is not authenticated!
		);
		const resolved = routerPrototype._resolveModelRouterTurnRoute.call(
			context,
			"Implement a small fix and update the relevant unit test.",
		);

		expect(resolved?.model.id).toBe("claude-sonnet-4-5");
		expect(resolved?.decision.tier).toBe("expensive");
		expect(resolved?.decision.fallbackFrom).toBe("medium");
		expect(resolved?.decision.reasonCode).toBe("medium_unavailable_fallback_expensive");
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
		expect(AgentSession.prototype.getModelRouterStatus.call(context as unknown as AgentSession)).toContain(
			"Routing: skipped (cheap model missing auth: anthropic/claude-haiku-4-5)",
		);
		expect(AgentSession.prototype.getModelRouterStatus.call(context as unknown as AgentSession)).toContain(
			"Latest intent: research",
		);
	});

	it("reports unresolved configured model when routing is skipped", () => {
		const context = createContext({
			enabled: true,
			cheapModel: "definitely-not-a-model",
			expensiveModel: "anthropic/claude-sonnet-4-5",
		});
		const selected = routerPrototype._resolveModelRouterTurnModel.call(context, "Explain this code block");

		expect(selected).toBeUndefined();
		expect(AgentSession.prototype.getModelRouterStatus.call(context as unknown as AgentSession)).toContain(
			"Routing: skipped (cheap model unresolved: definitely-not-a-model)",
		);
		expect(AgentSession.prototype.getModelRouterStatus.call(context as unknown as AgentSession)).toContain(
			"Latest intent: research",
		);
	});

	it("includes current config diagnostics in model-router session status", () => {
		const context = createContext({
			enabled: true,
			cheapModel: "definitely-not-a-model",
			expensiveModel: "anthropic/claude-sonnet-4-5",
		});

		const status = AgentSession.prototype.getModelRouterStatus.call(context as unknown as AgentSession);

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
		const selected = routerPrototype._resolveModelRouterTurnModel.call(
			context,
			"Publish a release and push the tag.",
		);

		expect(selected).toBeUndefined();
		expect(AgentSession.prototype.getModelRouterStatus.call(context as unknown as AgentSession)).toContain(
			"Routing: skipped (expensive model missing auth: anthropic/claude-sonnet-4-5)",
		);
		expect(AgentSession.prototype.getModelRouterStatus.call(context as unknown as AgentSession)).toContain(
			"Latest intent: modify",
		);
	});

	it("reports unresolved expensive model configuration for modify prompts", () => {
		const context = createContext({
			enabled: true,
			cheapModel: "anthropic/claude-haiku-4-5",
			expensiveModel: "definitely-not-a-model",
		});
		const selected = routerPrototype._resolveModelRouterTurnModel.call(
			context,
			"Publish a release and push the tag.",
		);

		expect(selected).toBeUndefined();
		expect(AgentSession.prototype.getModelRouterStatus.call(context as unknown as AgentSession)).toContain(
			"Routing: skipped (expensive model unresolved: definitely-not-a-model)",
		);
		expect(AgentSession.prototype.getModelRouterStatus.call(context as unknown as AgentSession)).toContain(
			"Latest intent: modify",
		);
	});

	it("uses routed models only for the current turn and restores session state", async () => {
		let modelDuringRun: TestModel | undefined;
		const persistedDecisions: ModelRouterDecisionStatus[] = [];
		const context: RoutedRunContext = {
			model: expensiveModel,
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [], tools: [] } },
			settingsManager: { getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) },
			sessionManager: {
				appendMessage: () => "entry",
				appendCustomEntry: (_customType, data) => {
					persistedDecisions.push(data as ModelRouterDecisionStatus);
					return "custom";
				},
				appendCustomMessageEntry: () => "custom",
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_refreshCurrentModelFromRegistry: () => {},
			_emitAutonomyTelemetry: () => {},
			_runAgentPrompt: async () => {
				modelDuringRun = context.agent.state.model;
			},
		};

		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype._runAgentPromptWithModelRouter.call(context, [], cheapModel, route);

		expect(modelDuringRun?.id).toBe("claude-haiku-4-5");
		expect(context.agent.state.model?.id).toBe("claude-sonnet-4-5");
		expect(context.agent.state.thinkingLevel).toBe("high");
		expect(persistedDecisions[0].route.tier).toBe("cheap");
		expect(persistedDecisions[0].route.reasonCode).toBe("explain");
		expect(persistedDecisions[0].outcome).toBe("routed");
	});

	it("keeps today's inherited-and-clamped thinking level when no per-tier thinking is configured", async () => {
		let thinkingDuringRun: ThinkingLevel | undefined;
		const context: RoutedRunContext = {
			model: expensiveModel,
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [], tools: [] } },
			settingsManager: { getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) },
			sessionManager: {
				appendMessage: () => "entry",
				appendCustomEntry: () => "custom",
				appendCustomMessageEntry: () => "custom",
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_refreshCurrentModelFromRegistry: () => {},
			_emitAutonomyTelemetry: () => {},
			_runAgentPrompt: async () => {
				thinkingDuringRun = context.agent.state.thinkingLevel;
			},
		};

		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype._runAgentPromptWithModelRouter.call(context, [], cheapModel, route);

		// Backward-compat (unset per-tier thinking): identical to today's inherit-and-clamp behavior.
		expect(thinkingDuringRun).toBe(clampThinkingLevel(cheapModel, "high"));
		expect(context.agent.state.thinkingLevel).toBe("high");
	});

	it("applies a configured per-tier thinking level for a routed turn and restores session thinking after", async () => {
		let thinkingDuringRun: ThinkingLevel | undefined;
		const context: RoutedRunContext = {
			model: expensiveModel,
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [], tools: [] } },
			settingsManager: {
				getModelCapabilitySettings: () => ({}),
				getModelRouterSettings: () => ({ cheapThinking: "low" }),
			},
			sessionManager: {
				appendMessage: () => "entry",
				appendCustomEntry: () => "custom",
				appendCustomMessageEntry: () => "custom",
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_refreshCurrentModelFromRegistry: () => {},
			_emitAutonomyTelemetry: () => {},
			_runAgentPrompt: async () => {
				thinkingDuringRun = context.agent.state.thinkingLevel;
			},
		};

		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype._runAgentPromptWithModelRouter.call(context, [], cheapModel, route);

		expect(thinkingDuringRun).toBe(clampThinkingLevel(cheapModel, "low"));
		expect(context.agent.state.thinkingLevel).toBe("high");
	});

	it("applies configured executor thinking for an executor-direct route instead of the tier's cheapThinking", async () => {
		let thinkingDuringRun: ThinkingLevel | undefined;
		const context: RoutedRunContext & { _executorTurnExecutedScript: (i: number) => boolean } = {
			model: expensiveModel,
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [], tools: [] } },
			settingsManager: {
				getModelCapabilitySettings: () => ({}),
				// A cheapThinking value is ALSO configured to prove the executor route uses executorThinking,
				// not the tier mapping (executor routes carry tier "cheap" too).
				getModelRouterSettings: () => ({ cheapThinking: "high", executorThinking: "minimal" }),
			},
			sessionManager: {
				appendMessage: () => "entry",
				appendCustomEntry: () => "custom",
				appendCustomMessageEntry: () => "custom",
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_refreshCurrentModelFromRegistry: () => {},
			_emitAutonomyTelemetry: () => {},
			_executorTurnExecutedScript: () => true, // muscle hit: skip the speculative-retry branch entirely
			_runAgentPrompt: async () => {
				thinkingDuringRun = context.agent.state.thinkingLevel;
			},
		};

		const route: RouteDecision = {
			tier: "cheap",
			risk: "scoped-write",
			confidence: 1,
			reasonCode: "executor_direct",
			reasons: [],
		};

		await routerPrototype._runAgentPromptWithModelRouter.call(context, [], cheapModel, route);

		expect(thinkingDuringRun).toBe(clampThinkingLevel(cheapModel, "minimal"));
	});

	it("discards buffered cheap-turn messages and retries on expensive model after escalation", async () => {
		const persisted: Message[] = [];
		const persistedDecisions: Array<{ customType: string; data?: unknown }> = [];
		const modelsDuringRuns: string[] = [];
		const context: RoutedRunContext & { _modelRouterEscalationRequested?: boolean } = {
			model: expensiveModel,
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [], tools: [] } },
			settingsManager: { getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) },
			sessionManager: {
				appendMessage: (message) => {
					persisted.push(message);
					return "entry";
				},
				appendCustomEntry: (customType, data) => {
					persistedDecisions.push({ customType, data });
					return "custom";
				},
				appendCustomMessageEntry: () => "custom",
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_refreshCurrentModelFromRegistry: () => {},
			_emitAutonomyTelemetry: () => {},
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

		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype._runAgentPromptWithModelRouter.call(context, [], cheapModel, route);

		expect(modelsDuringRuns).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5"]);
		expect(context.agent.state.messages.map((message) => message.role)).toEqual(["assistant"]);
		expect(persisted).toHaveLength(1);
		const persistedMessage = persisted[0] as AssistantMessage;
		expect((persistedMessage.content[0] as { text: string }).text).toBe("response-2");

		expect(persistedDecisions).toHaveLength(1);
		expect(persistedDecisions[0].customType).toBe(MODEL_ROUTER_DECISION_CUSTOM_TYPE);
		const decisionData = persistedDecisions[0].data as ModelRouterDecisionStatus;
		expect(decisionData.route.tier).toBe("cheap");
		expect(decisionData.outcome).toBe("escalated");
		expect(decisionData.retryModel).toBe("anthropic/claude-sonnet-4-5");
	});
});

describe("G4: routed-turn capability tool filtering", () => {
	it("reduces the tool surface for a small routed model and restores it afterwards", async () => {
		const sessionTools = [
			{ name: "read" },
			{ name: "bash" },
			{ name: "edit" },
			{ name: "write" },
			{ name: "goal" },
			{ name: "delegate" },
		];
		let toolsDuringRun: string[] = [];
		let promptDuringRun: string | undefined;
		const smallCheap = { ...cheapModel, contextWindow: 8_192 };
		const context: RoutedRunContext = {
			model: expensiveModel,
			agent: {
				state: {
					model: expensiveModel,
					thinkingLevel: "high",
					messages: [],
					tools: [...sessionTools],
					systemPrompt: "BASE_PROMPT",
				},
			},
			settingsManager: { getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) },
			sessionManager: {
				appendMessage: () => "entry",
				appendCustomEntry: () => "custom",
				appendCustomMessageEntry: () => "custom",
			},
			_baseSystemPrompt: "BASE_PROMPT",
			_buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_refreshCurrentModelFromRegistry: () => {},
			_emitAutonomyTelemetry: () => {},
			_runAgentPrompt: async () => {
				toolsDuringRun = context.agent.state.tools.map((tool) => tool.name);
				promptDuringRun = context.agent.state.systemPrompt;
			},
		};
		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype._runAgentPromptWithModelRouter.call(context, [], smallCheap, route);

		// during the routed turn: 8k window -> minimal class -> autonomy tools (goal/delegate) gone
		expect(toolsDuringRun).not.toContain("goal");
		expect(toolsDuringRun).not.toContain("delegate");
		expect(toolsDuringRun).toContain("read");
		// G4: the system prompt was rebuilt for the FILTERED surface (guidelines for goal/delegate shed)
		expect(promptDuringRun).toBe(`PROMPT_FOR:${toolsDuringRun.join(",")}`);
		expect(promptDuringRun).not.toContain("goal");
		expect(promptDuringRun).not.toContain("delegate");
		// after: full session surface AND base prompt restored
		expect(context.agent.state.tools.map((tool) => tool.name)).toEqual(sessionTools.map((tool) => tool.name));
		expect(context.agent.state.systemPrompt).toBe("BASE_PROMPT");
	});

	it("restores tools and system prompt when the routed run throws", async () => {
		const sessionTools = [{ name: "read" }, { name: "bash" }, { name: "goal" }, { name: "delegate" }];
		let promptDuringRun: string | undefined;
		const smallCheap = { ...cheapModel, contextWindow: 8_192 };
		const context: RoutedRunContext = {
			model: expensiveModel,
			agent: {
				state: {
					model: expensiveModel,
					thinkingLevel: "high",
					messages: [],
					tools: [...sessionTools],
					systemPrompt: "BASE_PROMPT",
				},
			},
			settingsManager: { getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) },
			sessionManager: {
				appendMessage: () => "entry",
				appendCustomEntry: () => "custom",
				appendCustomMessageEntry: () => "custom",
			},
			_baseSystemPrompt: "BASE_PROMPT",
			_buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_refreshCurrentModelFromRegistry: () => {},
			_emitAutonomyTelemetry: () => {},
			_runAgentPrompt: async () => {
				// prove the shed happened before the throw, so the finally has something to restore
				promptDuringRun = context.agent.state.systemPrompt;
				throw new Error("routed turn blew up");
			},
		};
		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await expect(routerPrototype._runAgentPromptWithModelRouter.call(context, [], smallCheap, route)).rejects.toThrow(
			"routed turn blew up",
		);

		// the routed turn did receive the filtered prompt...
		expect(promptDuringRun).not.toContain("goal");
		// ...and the finally restored both tools and the base prompt despite the throw
		expect(context.agent.state.tools.map((tool) => tool.name)).toEqual(sessionTools.map((tool) => tool.name));
		expect(context.agent.state.systemPrompt).toBe("BASE_PROMPT");
	});

	it("Bug G: does not clobber a mid-turn extension tool/prompt change (setActiveToolsByName) when restoring", async () => {
		const sessionTools = [{ name: "read" }, { name: "bash" }, { name: "goal" }, { name: "delegate" }];
		const smallCheap = { ...cheapModel, contextWindow: 8_192 };
		// What an extension's mid-turn setActiveToolsByName call assigns — brand-new references,
		// distinct from both the pre-turn session tools AND whatever the G4 swap itself assigned.
		const extensionTools = [{ name: "read" }, { name: "extension-tool" }];
		const extensionPrompt = "EXTENSION_OWNED_PROMPT";
		const context: RoutedRunContext = {
			model: expensiveModel,
			agent: {
				state: {
					model: expensiveModel,
					thinkingLevel: "high",
					messages: [],
					tools: [...sessionTools],
					systemPrompt: "BASE_PROMPT",
				},
			},
			settingsManager: { getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) },
			sessionManager: {
				appendMessage: () => "entry",
				appendCustomEntry: () => "custom",
				appendCustomMessageEntry: () => "custom",
			},
			_baseSystemPrompt: "BASE_PROMPT",
			_buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_refreshCurrentModelFromRegistry: () => {},
			_emitAutonomyTelemetry: () => {},
			_runAgentPrompt: async () => {
				// Simulate an extension calling session.setActiveToolsByName(...) mid-turn: it rebuilds the
				// base prompt AND reassigns both state.tools and state.systemPrompt to brand-new values,
				// without touching the model — exactly what the real setActiveToolsByName does.
				context.agent.state.tools = [...extensionTools];
				context.agent.state.systemPrompt = extensionPrompt;
			},
		};
		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype._runAgentPromptWithModelRouter.call(context, [], smallCheap, route);

		// Model/thinking restore is unaffected by this fix — it stays under its own guard.
		expect(context.agent.state.model).toBe(expensiveModel);
		// The extension's mid-turn tool/prompt surface must SURVIVE the router-swap restore, not be
		// silently clobbered back to the stale pre-turn snapshot.
		expect(context.agent.state.tools).toEqual(extensionTools);
		expect(context.agent.state.systemPrompt).toBe(extensionPrompt);
	});
});

describe("speculative executor retry (G16 refinement)", () => {
	it("retries once with a brain-refined instruction when the executor turn ran no script", async () => {
		let retried = false;
		let runCount = 0;
		const smallCheap = { ...cheapModel, contextWindow: 8_192 };
		const context: RoutedRunContext & {
			_executorTurnExecutedScript: (i: number) => boolean;
			_buildExecutorRefinedPrompt: (m: unknown) => Promise<string | undefined>;
		} = {
			model: expensiveModel,
			agent: {
				state: {
					model: expensiveModel,
					thinkingLevel: "high",
					messages: [],
					tools: [],
					systemPrompt: "BASE_PROMPT",
				},
			},
			settingsManager: { getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) },
			sessionManager: {
				appendMessage: () => "entry",
				appendCustomEntry: () => "custom",
				appendCustomMessageEntry: () => "custom",
			},
			_baseSystemPrompt: "BASE_PROMPT",
			_buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_refreshCurrentModelFromRegistry: () => {},
			_emitAutonomyTelemetry: () => {},
			_executorTurnExecutedScript: () => false, // muscle missed
			_buildExecutorRefinedPrompt: async () => 'Run the toolkit script "restore-db" ...',
			_runAgentPrompt: async () => {
				runCount++;
				if (runCount > 1) retried = true;
			},
		};
		const route: RouteDecision = {
			tier: "cheap",
			risk: "scoped-write",
			confidence: 1,
			reasonCode: "executor_direct",
			reasons: [],
		};

		await routerPrototype._runAgentPromptWithModelRouter.call(context, [], smallCheap, route);
		expect(retried).toBe(true);
		// exactly-once: the initial executor turn + a single speculative retry, never more.
		expect(runCount).toBe(2);
	});

	it("surfaces a warning (no retry) when the executor missed and the brain produced no refinement", async () => {
		let runCount = 0;
		const emitted: Array<{ type: string; message?: string }> = [];
		const smallCheap = { ...cheapModel, contextWindow: 8_192 };
		const context: RoutedRunContext & {
			_executorTurnExecutedScript: (i: number) => boolean;
			_buildExecutorRefinedPrompt: (m: unknown) => Promise<string | undefined>;
		} = {
			model: expensiveModel,
			agent: {
				state: {
					model: expensiveModel,
					thinkingLevel: "high",
					messages: [],
					tools: [],
					systemPrompt: "BASE_PROMPT",
				},
			},
			settingsManager: { getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) },
			sessionManager: {
				appendMessage: () => "entry",
				appendCustomEntry: () => "custom",
				appendCustomMessageEntry: () => "custom",
			},
			_baseSystemPrompt: "BASE_PROMPT",
			_buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
			_resolveModelRouterModelForIntent: () => expensiveModel,
			_runAgentPromptWithModelRouter: routerPrototype._runAgentPromptWithModelRouter,
			_refreshCurrentModelFromRegistry: () => {},
			_emit: (event) => emitted.push(event),
			_emitAutonomyTelemetry: () => {},
			_executorTurnExecutedScript: () => false, // muscle missed
			_buildExecutorRefinedPrompt: async () => undefined, // brain could not refine
			_runAgentPrompt: async () => {
				runCount++;
			},
		};
		const route: RouteDecision = {
			tier: "cheap",
			risk: "scoped-write",
			confidence: 1,
			reasonCode: "executor_direct",
			reasons: [],
		};

		await routerPrototype._runAgentPromptWithModelRouter.call(context, [], smallCheap, route);

		// no retry happened (only the initial turn), and the miss was surfaced, not swallowed
		expect(runCount).toBe(1);
		const warnings = emitted.filter((event) => event.type === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message?.toLowerCase()).toContain("executor");
	});
});

describe("executor lane fitness gate (session-level)", () => {
	type ExecutorRouteResolver = {
		_resolveExecutorRoute(
			prompt: string,
			executorPattern?: string,
		): { decision: RouteDecision; model: TestModel } | undefined;
	};

	const laneReport = (toolCall: { succeeded: number; total: number }): ModelFitnessReport => {
		const lane = { succeeded: 3, total: 3, outcomes: [], meanMs: 10 };
		return {
			trials: 3,
			research: { ...lane },
			worker: { ...lane },
			search: { ...lane },
			toolCall: { ...lane, ...toolCall },
			digest: { ...lane },
			judge: {
				parsed: 0,
				planningElevated: 0,
				planningTotal: 0,
				trivialCheap: 0,
				trivialTotal: 0,
				total: 0,
				outcomes: [],
				meanMs: 0,
			},
			totalCostUsd: 0,
		};
	};

	const makeHarness = () =>
		createHarness({
			models: [{ id: "exec", contextWindow: 8_192 }],
			settings: {
				modelRouter: { enabled: true, executorModel: "faux/exec" },
				toolkit: {
					scripts: [
						{ name: "status-report", description: "Print the status report", path: "s.sh", runner: "bash" },
					],
				},
			},
		});

	const resolve = (harness: Awaited<ReturnType<typeof makeHarness>>) =>
		(harness.session as unknown as ExecutorRouteResolver)._resolveExecutorRoute("status-report", "faux/exec");

	it("does not route to the executor without a tool-call fitness report", async () => {
		const harness = await makeHarness();
		try {
			expect(resolve(harness)).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("does not route when tool-call success is below ceil(2/3 of trials)", async () => {
		const harness = await makeHarness();
		try {
			FitnessStore.forAgentDir(harness.tempDir).save("faux/exec", laneReport({ succeeded: 1, total: 3 }));
			expect(resolve(harness)).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("routes to the executor at the ceil(2/3) tool-call threshold", async () => {
		const harness = await makeHarness();
		try {
			FitnessStore.forAgentDir(harness.tempDir).save("faux/exec", laneReport({ succeeded: 2, total: 3 }));
			const route = resolve(harness);
			expect(route?.decision.reasonCode).toBe("executor_direct");
			expect(route?.model.id).toBe("exec");
		} finally {
			harness.cleanup();
		}
	});
});
