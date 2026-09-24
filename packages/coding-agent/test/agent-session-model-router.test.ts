import { tmpdir } from "node:os";
import type { AgentMessage, AgentTool, ThinkingLevel } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { SessionMessageBatchEntry } from "@caupulican/pi-agent-core/session";
import type { Api, AssistantMessage, Context, Message, Model, Usage } from "@caupulican/pi-ai";
import { clampThinkingLevel, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import type { FauxRequestEvent } from "@caupulican/pi-ai/faux";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { RouteDecision } from "../src/core/autonomy/contracts.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { MODEL_ROUTER_DECISION_CUSTOM_TYPE, type ModelRouterDecisionStatus } from "../src/core/model-router/status.ts";
import { ModelRouterController } from "../src/core/model-router-controller.ts";
import { FitnessStore } from "../src/core/models/fitness-store.ts";
import { CONVERSATION_TALKER_CUSTOM_TYPE } from "../src/core/reply-route.ts";
import type { ModelFitnessReport } from "../src/core/research/model-fitness.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";
import { createHarness } from "./suite/harness.ts";

type TestModel = Model<Api>;

type RouterSettings = {
	enabled: boolean;
	cheapModel?: string;
	mediumModel?: string;
	expensiveModel?: string;
	fitnessGate?: boolean;
};

type RouterContext = {
	_lastModelRouterSkipReason?: string;
	deps: {
		getSettingsManager: () => { getModelRouterSettings: () => RouterSettings };
		getSessionManager: () => { getEntries: () => [] };
		getAgentDir: () => string;
		getModelRegistry: () => {
			getAll: () => TestModel[];
			hasConfiguredAuth: (model: TestModel) => boolean;
		};
		isModelExhausted: (model: TestModel) => boolean;
		getFailoverStatus: () => { exhausted: string[]; lastNotice?: string };
		getCandidatePool: () => { customized: boolean; models: TestModel[] };
		isUsingSubscription: (model: TestModel) => boolean;
		getToolProbeVerdict: (model: TestModel) => undefined;
	};
};

/** Per-tier thinking configuration surfaced by the real settingsManager.getModelRouterSettings(). */
type RouterTierThinkingSettings = {
	cheapThinking?: ThinkingLevel;
	mediumThinking?: ThinkingLevel;
	expensiveThinking?: ThinkingLevel;
	executorThinking?: ThinkingLevel;
};

type RoutedRunContext = {
	agent: {
		state: {
			model: TestModel | undefined;
			thinkingLevel: ThinkingLevel;
			messages: AgentMessage[];
			tools: Array<{ name: string }>;
			systemPrompt?: string;
		};
	};
	deps: {
		getModel: () => TestModel | undefined;
		getAgent: () => RoutedRunContext["agent"];
		getSettingsManager: () => {
			getModelCapabilitySettings: () => { mode?: string };
			getModelRouterSettings: () => RouterTierThinkingSettings;
		};
		getSessionManager: () => {
			appendMessage: (message: Message) => string;
			appendCustomEntry: (customType: string, data?: unknown) => string;
			appendCustomMessageEntry: (customType: string, content: unknown, display: string, details?: unknown) => string;
		};
		appendSessionMessageBatch?: (batch: readonly SessionMessageBatchEntry[]) => string[];
		getBaseSystemPrompt: () => string;
		buildSystemPromptForToolNames: (toolNames: string[]) => string;
		runAgentPrompt: (messages: AgentMessage | AgentMessage[]) => Promise<void>;
		refreshCurrentModelFromRegistry?: () => void;
		emit?: (event: { type: string; message?: string }) => void;
		emitAutonomyTelemetry?: (event: unknown) => void;
	};
	_isModelRouterRetry?: boolean;
	_resolveModelRouterModelForIntent: (intent: "research" | "modify") => TestModel | undefined;
	runRoutedTurn?: ModelRouterControllerPrototype["runRoutedTurn"];
};

type ModelRouterControllerPrototype = {
	_resolveModelRouterTurnModel(this: RouterContext, prompt: string): TestModel | undefined;
	_resolveModelRouterTurnRoute(
		this: RouterContext,
		prompt: string,
	): { decision: RouteDecision; model: TestModel } | undefined;
	runRoutedTurn(
		this: RoutedRunContext,
		messages: AgentMessage | AgentMessage[],
		routedModel: TestModel | undefined,
		routeDecision: RouteDecision | undefined,
	): Promise<void>;
	captureSessionMessage(this: RoutedRunContext, message: AgentMessage): boolean;
};

type RuntimeRouterResolver = {
	_resolveModelRouterTurnRoute(prompt: string): { decision: RouteDecision; model: TestModel } | undefined;
};

const routerPrototype = ModelRouterController.prototype as unknown as ModelRouterControllerPrototype;
function testModel(id: string): TestModel {
	return {
		id,
		name: id,
		provider: "anthropic",
		api: "messages",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	} as TestModel;
}

const cheapModel = testModel("claude-haiku-4-5");
const mediumModel = testModel("claude-3-5-sonnet-20241022");
const expensiveModel = testModel("claude-sonnet-4-5");

function fitnessReport(overrides: Partial<ModelFitnessReport> = {}): ModelFitnessReport {
	const lane = { succeeded: 3, total: 3, outcomes: [], meanMs: 10 };
	return {
		trials: 3,
		research: { ...lane },
		worker: { ...lane },
		search: { ...lane },
		toolCall: { ...lane },
		digest: { ...lane },
		totalCostUsd: 0,
		...overrides,
	};
}

const bashParameters = Type.Object({ command: Type.String() });
const bashTool: AgentTool<typeof bashParameters> = {
	name: "bash",
	label: "Bash",
	description: "Run a shell command",
	parameters: bashParameters,
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

const lifecycleReadParameters = Type.Object({ value: Type.String() });
function makeLifecycleReadTool(calls: string[]): AgentTool<typeof lifecycleReadParameters> {
	return {
		name: "read_probe",
		label: "Read probe",
		description: "Read-only lifecycle regression tool",
		parameters: lifecycleReadParameters,
		execute: async (_toolCallId, args) => {
			calls.push(args.value);
			return { content: [{ type: "text", text: "read result" }], details: {} };
		},
	};
}

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
	exhaustedModels: TestModel[] = [],
): RouterContext {
	return Object.assign(Object.create(ModelRouterController.prototype), {
		deps: {
			getSettingsManager: () => ({ getModelRouterSettings: () => settings }),
			getSessionManager: () => ({ getEntries: () => [] }),
			getAgentDir: () => "/tmp/pi-router-test-agent-dir",
			getModelRegistry: () => ({
				getAll: () => [cheapModel, mediumModel, expensiveModel].filter((model) => model !== undefined),
				hasConfiguredAuth: (model: TestModel) =>
					authenticatedModels.some(
						(candidate) => candidate.provider === model.provider && candidate.id === model.id,
					),
			}),
			isModelExhausted: (model: TestModel) =>
				exhaustedModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id),
			getFailoverStatus: () => ({ exhausted: [] }),
			// Uncustomized pool: every authed model, as the session resolves it.
			getCandidatePool: () => ({ customized: false, models: [...authenticatedModels] }),
			isUsingSubscription: () => false,
			getToolProbeVerdict: () => undefined,
		},
	});
}

describe("AgentSession model router turn selection", () => {
	it("reruns a side trip that reaches for a mutating tool on the talker, without duplicating the user message", async () => {
		const harness = await createHarness({
			// The session model is the talker; the small message takes its side trip on the cheap tier.
			models: [{ id: "expensive" }, { id: "cheap" }],
			baseToolsOverride: [bashTool],
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
				fauxAssistantMessage("retried on the talker"),
			]);

			await harness.session.prompt("Explain whether this command is safe: cp source target");

			const userStarts = harness.eventsOfType("message_start").filter((event) => event.message.role === "user");
			expect(userStarts).toHaveLength(1);
			const branch = harness.sessionManager.getBranch();
			expect(branch.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
			expect(
				branch.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.model === "expensive" &&
						entry.message.content.some(
							(block) => block.type === "text" && block.text === "retried on the talker",
						),
				),
			).toHaveLength(1);
			expect(branch.filter((entry) => entry.type === "foreground_tool_start")).toHaveLength(0);
			expect(branch.filter((entry) => entry.type === "foreground_tool_terminal")).toHaveLength(0);
			expect(harness.session.getModelRouterStatus()).toContain(
				"cheap/read-only -> faux/cheap (side_trip, escalated -> faux/expensive, selected by manual)",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("commits a cheap read-only assistant before tool execution and closes its lifecycle", async () => {
		const calls: string[] = [];
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "expensive" }],
			baseToolsOverride: [makeLifecycleReadTool(calls)],
			initialActiveToolNames: ["read_probe"],
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
				fauxAssistantMessage([fauxToolCall("read_probe", { value: "bounded" }, { id: "read-probe-call" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("cheap complete"),
			]);
			await harness.session.prompt("Explain this read-only value");
			expect(calls).toEqual(["bounded"]);
			const branch = harness.sessionManager.getBranch();
			expect(branch.filter((entry) => entry.type === "foreground_tool_start")).toHaveLength(1);
			expect(branch.filter((entry) => entry.type === "foreground_tool_terminal")).toHaveLength(1);
			expect(branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(
				1,
			);
		} finally {
			await harness.cleanup();
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

	it("skips exhausted cheap models with a visible quota reason", () => {
		const context = createContext(
			{
				enabled: true,
				cheapModel: "anthropic/claude-haiku-4-5",
				expensiveModel: "anthropic/claude-sonnet-4-5",
			},
			undefined,
			[cheapModel],
		);

		expect(routerPrototype._resolveModelRouterTurnRoute.call(context, "Explain this code block")).toBeUndefined();
		expect(context._lastModelRouterSkipReason).toBe("cheap model exhausted: quota");
	});

	it("falls back from exhausted medium to expensive", () => {
		const context = createContext(
			{
				enabled: true,
				cheapModel: "anthropic/claude-haiku-4-5",
				mediumModel: "anthropic/claude-3-5-sonnet-20241022",
				expensiveModel: "anthropic/claude-sonnet-4-5",
			},
			undefined,
			[mediumModel],
		);

		const route = routerPrototype._resolveModelRouterTurnRoute.call(
			context,
			"Implement a small fix and update the relevant unit test.",
		);
		expect(route?.model.id).toBe("claude-sonnet-4-5");
		expect(route?.decision.reasonCode).toBe("medium_exhausted_fallback_expensive");
	});

	it("keeps gate-off router behavior when a configured model has a failed fitness report", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "expensive" }],
			settings: {
				modelRouter: { enabled: true, cheapModel: "faux/cheap", expensiveModel: "faux/expensive" },
			},
		});
		try {
			FitnessStore.forAgentDir(harness.tempDir).save(
				"faux/cheap",
				fitnessReport({ research: { succeeded: 1, total: 3, outcomes: [], meanMs: 10 } }),
			);
			const route = (
				harness.session as unknown as { _modelRouter: RuntimeRouterResolver }
			)._modelRouter._resolveModelRouterTurnRoute("Explain this code block");
			expect(route?.model.id).toBe("cheap");
		} finally {
			harness.cleanup();
		}
	});

	it("skips a routed cheap turn when the opt-in fitness gate sees a failed research lane", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "expensive" }],
			settings: {
				modelRouter: {
					enabled: true,
					fitnessGate: true,
					cheapModel: "faux/cheap",
					expensiveModel: "faux/expensive",
				},
			},
		});
		try {
			FitnessStore.forAgentDir(harness.tempDir).save(
				"faux/cheap",
				fitnessReport({ research: { succeeded: 1, total: 3, outcomes: [], meanMs: 10 } }),
			);
			const route = (
				harness.session as unknown as { _modelRouter: RuntimeRouterResolver }
			)._modelRouter._resolveModelRouterTurnRoute("Explain this code block");
			expect(route).toBeUndefined();
			expect(harness.session.getModelRouterStatus()).toContain(
				"Routing: skipped (cheap model unfit: research 1/3 (fitness gate))",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back from an unfit medium model to a fit expensive model", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "medium" }, { id: "expensive" }],
			settings: {
				modelRouter: {
					enabled: true,
					fitnessGate: true,
					cheapModel: "faux/cheap",
					mediumModel: "faux/medium",
					expensiveModel: "faux/expensive",
				},
			},
		});
		try {
			FitnessStore.forAgentDir(harness.tempDir).save(
				"faux/medium",
				fitnessReport({ worker: { succeeded: 1, total: 3, outcomes: [], meanMs: 10 } }),
			);
			FitnessStore.forAgentDir(harness.tempDir).save("faux/expensive", fitnessReport());
			const route = (
				harness.session as unknown as { _modelRouter: RuntimeRouterResolver }
			)._modelRouter._resolveModelRouterTurnRoute("Implement a small fix and update the relevant unit test.");
			expect(route?.model.id).toBe("expensive");
			expect(route?.decision.reasonCode).toBe("medium_unfit_fallback_expensive");
		} finally {
			harness.cleanup();
		}
	});

	it("routes an unprobed model normally when the subtractive fitness gate is enabled", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "expensive" }],
			settings: {
				modelRouter: {
					enabled: true,
					fitnessGate: true,
					cheapModel: "faux/cheap",
					expensiveModel: "faux/expensive",
				},
			},
		});
		try {
			const route = (
				harness.session as unknown as { _modelRouter: RuntimeRouterResolver }
			)._modelRouter._resolveModelRouterTurnRoute("Explain this code block");
			expect(route?.model.id).toBe("cheap");
		} finally {
			harness.cleanup();
		}
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
		expect(ModelRouterController.prototype.getStatus.call(context as unknown as ModelRouterController)).toContain(
			"Routing: skipped (cheap model missing auth: anthropic/claude-haiku-4-5)",
		);
		expect(ModelRouterController.prototype.getStatus.call(context as unknown as ModelRouterController)).toContain(
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
		expect(ModelRouterController.prototype.getStatus.call(context as unknown as ModelRouterController)).toContain(
			"Routing: skipped (cheap model unresolved: definitely-not-a-model)",
		);
		expect(ModelRouterController.prototype.getStatus.call(context as unknown as ModelRouterController)).toContain(
			"Latest intent: research",
		);
	});

	it("includes current config diagnostics in model-router session status", () => {
		const context = createContext({
			enabled: true,
			cheapModel: "definitely-not-a-model",
			expensiveModel: "anthropic/claude-sonnet-4-5",
		});

		const status = ModelRouterController.prototype.getStatus.call(context as unknown as ModelRouterController);

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
		expect(ModelRouterController.prototype.getStatus.call(context as unknown as ModelRouterController)).toContain(
			"Routing: skipped (expensive model missing auth: anthropic/claude-sonnet-4-5)",
		);
		expect(ModelRouterController.prototype.getStatus.call(context as unknown as ModelRouterController)).toContain(
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
		expect(ModelRouterController.prototype.getStatus.call(context as unknown as ModelRouterController)).toContain(
			"Routing: skipped (expensive model unresolved: definitely-not-a-model)",
		);
		expect(ModelRouterController.prototype.getStatus.call(context as unknown as ModelRouterController)).toContain(
			"Latest intent: modify",
		);
	});

	it("uses routed models only for the current turn and restores session state", async () => {
		let modelDuringRun: TestModel | undefined;
		const persistedDecisions: ModelRouterDecisionStatus[] = [];
		const context: RoutedRunContext = {
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [], tools: [] } },
			deps: {
				getModel: () => expensiveModel,
				getAgent: () => context.agent,
				getSettingsManager: () => ({ getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) }),
				getSessionManager: () => ({
					appendMessage: () => "entry",
					appendCustomEntry: (_customType, data) => {
						persistedDecisions.push(data as ModelRouterDecisionStatus);
						return "custom";
					},
					appendCustomMessageEntry: () => "custom",
				}),
				getBaseSystemPrompt: () => "BASE_PROMPT",
				buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
				runAgentPrompt: async () => {
					modelDuringRun = context.agent.state.model;
				},
				refreshCurrentModelFromRegistry: () => {},
				emitAutonomyTelemetry: () => {},
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			runRoutedTurn: routerPrototype.runRoutedTurn,
		};

		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype.runRoutedTurn.call(context, [], cheapModel, route);

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
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [], tools: [] } },
			deps: {
				getModel: () => expensiveModel,
				getAgent: () => context.agent,
				getSettingsManager: () => ({ getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) }),
				getSessionManager: () => ({
					appendMessage: () => "entry",
					appendCustomEntry: () => "custom",
					appendCustomMessageEntry: () => "custom",
				}),
				getBaseSystemPrompt: () => "BASE_PROMPT",
				buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
				runAgentPrompt: async () => {
					thinkingDuringRun = context.agent.state.thinkingLevel;
				},
				refreshCurrentModelFromRegistry: () => {},
				emitAutonomyTelemetry: () => {},
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			runRoutedTurn: routerPrototype.runRoutedTurn,
		};

		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype.runRoutedTurn.call(context, [], cheapModel, route);

		// Backward-compat (unset per-tier thinking): identical to today's inherit-and-clamp behavior.
		expect(thinkingDuringRun).toBe(clampThinkingLevel(cheapModel, "high"));
		expect(context.agent.state.thinkingLevel).toBe("high");
	});

	it("applies a configured per-tier thinking level for a routed turn and restores session thinking after", async () => {
		let thinkingDuringRun: ThinkingLevel | undefined;
		const context: RoutedRunContext = {
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [], tools: [] } },
			deps: {
				getModel: () => expensiveModel,
				getAgent: () => context.agent,
				getSettingsManager: () => ({
					getModelCapabilitySettings: () => ({}),
					getModelRouterSettings: () => ({ cheapThinking: "low" }),
				}),
				getSessionManager: () => ({
					appendMessage: () => "entry",
					appendCustomEntry: () => "custom",
					appendCustomMessageEntry: () => "custom",
				}),
				getBaseSystemPrompt: () => "BASE_PROMPT",
				buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
				runAgentPrompt: async () => {
					thinkingDuringRun = context.agent.state.thinkingLevel;
				},
				refreshCurrentModelFromRegistry: () => {},
				emitAutonomyTelemetry: () => {},
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			runRoutedTurn: routerPrototype.runRoutedTurn,
		};

		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype.runRoutedTurn.call(context, [], cheapModel, route);

		expect(thinkingDuringRun).toBe(clampThinkingLevel(cheapModel, "low"));
		expect(context.agent.state.thinkingLevel).toBe("high");
	});

	it("applies configured executor thinking for an executor-direct route instead of the tier's cheapThinking", async () => {
		let thinkingDuringRun: ThinkingLevel | undefined;
		const context: RoutedRunContext & { _executorTurnExecutedScript: (i: number) => boolean } = {
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [], tools: [] } },
			deps: {
				getModel: () => expensiveModel,
				getAgent: () => context.agent,
				getSettingsManager: () => ({
					getModelCapabilitySettings: () => ({}),
					// A cheapThinking value is ALSO configured to prove the executor route uses executorThinking,
					// not the tier mapping (executor routes carry tier "cheap" too).
					getModelRouterSettings: () => ({ cheapThinking: "high", executorThinking: "minimal" }),
				}),
				getSessionManager: () => ({
					appendMessage: () => "entry",
					appendCustomEntry: () => "custom",
					appendCustomMessageEntry: () => "custom",
				}),
				getBaseSystemPrompt: () => "BASE_PROMPT",
				buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
				runAgentPrompt: async () => {
					thinkingDuringRun = context.agent.state.thinkingLevel;
				},
				refreshCurrentModelFromRegistry: () => {},
				emitAutonomyTelemetry: () => {},
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			runRoutedTurn: routerPrototype.runRoutedTurn,
			_executorTurnExecutedScript: () => true, // muscle hit: skip the speculative-retry branch entirely
		};

		const route: RouteDecision = {
			tier: "cheap",
			risk: "scoped-write",
			confidence: 1,
			reasonCode: "executor_direct",
			reasons: [],
		};

		await routerPrototype.runRoutedTurn.call(context, [], cheapModel, route);

		expect(thinkingDuringRun).toBe(clampThinkingLevel(cheapModel, "minimal"));
	});

	it("discards buffered cheap-turn messages and retries on expensive model after escalation", async () => {
		const persisted: Message[] = [];
		const persistedDecisions: Array<{ customType: string; data?: unknown }> = [];
		const modelsDuringRuns: string[] = [];
		const context: RoutedRunContext & { _modelRouterEscalationRequested?: boolean } = {
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [], tools: [] } },
			deps: {
				getModel: () => expensiveModel,
				getAgent: () => context.agent,
				getSettingsManager: () => ({ getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) }),
				getSessionManager: () => ({
					appendMessage: (message) => {
						persisted.push(message);
						return "entry";
					},
					appendCustomEntry: (customType, data) => {
						persistedDecisions.push({ customType, data });
						return "custom";
					},
					appendCustomMessageEntry: () => "custom",
				}),
				getBaseSystemPrompt: () => "BASE_PROMPT",
				buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
				runAgentPrompt: async () => {
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
						context.deps.getSessionManager().appendMessage(context.agent.state.messages[0] as Message);
					}
				},
				refreshCurrentModelFromRegistry: () => {},
				emitAutonomyTelemetry: () => {},
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			runRoutedTurn: routerPrototype.runRoutedTurn,
		};

		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype.runRoutedTurn.call(context, [], cheapModel, route);

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

	it("splices buffered cheap-turn messages back out when the routed run throws", async () => {
		const persisted: Message[] = [];
		const persistedDecisions: Array<{ customType: string; data?: unknown }> = [];
		const priorMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "already-persisted" }],
			api: expensiveModel.api,
			provider: expensiveModel.provider,
			model: expensiveModel.id,
			stopReason: "stop",
			timestamp: 0,
			usage: createUsage(),
		};
		const context: RoutedRunContext = {
			agent: { state: { model: expensiveModel, thinkingLevel: "high", messages: [priorMessage], tools: [] } },
			deps: {
				getModel: () => expensiveModel,
				getAgent: () => context.agent,
				getSettingsManager: () => ({ getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) }),
				getSessionManager: () => ({
					appendMessage: (message) => {
						persisted.push(message);
						return "entry";
					},
					appendCustomEntry: (customType, data) => {
						persistedDecisions.push({ customType, data });
						return "custom";
					},
					appendCustomMessageEntry: () => "custom",
				}),
				getBaseSystemPrompt: () => "BASE_PROMPT",
				buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
				runAgentPrompt: async () => {
					// Simulate the buffered turn writing to LIVE agent.state.messages (as a real routed
					// turn does) before the provider call throws after retries are exhausted.
					const buffered: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "never-persisted" }],
						api: cheapModel.api,
						provider: cheapModel.provider,
						model: cheapModel.id,
						stopReason: "stop",
						timestamp: 1,
						usage: createUsage(),
					};
					context.agent.state.messages.push(buffered);
					throw new Error("provider exhausted retries");
				},
				refreshCurrentModelFromRegistry: () => {},
				emitAutonomyTelemetry: () => {},
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			runRoutedTurn: routerPrototype.runRoutedTurn,
		};

		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await expect(routerPrototype.runRoutedTurn.call(context, [], cheapModel, route)).rejects.toThrow(
			"provider exhausted retries",
		);

		// Live messages must be rolled back to the pre-turn length: the buffered assistant message was
		// never flushed to the session, so it must not survive the throw either.
		expect(context.agent.state.messages).toEqual([priorMessage]);
		expect(persisted).toHaveLength(0);

		expect(persistedDecisions).toHaveLength(1);
		expect(persistedDecisions[0].customType).toBe(MODEL_ROUTER_DECISION_CUSTOM_TYPE);
		const decisionData = persistedDecisions[0].data as ModelRouterDecisionStatus;
		expect(decisionData.route.tier).toBe("cheap");
		expect(decisionData.outcome).toBe("failed");
	});
});

describe("routed-turn capability tool filtering", () => {
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
			agent: {
				state: {
					model: expensiveModel,
					thinkingLevel: "high",
					messages: [],
					tools: [...sessionTools],
					systemPrompt: "BASE_PROMPT",
				},
			},
			deps: {
				getModel: () => expensiveModel,
				getAgent: () => context.agent,
				getSettingsManager: () => ({ getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) }),
				getSessionManager: () => ({
					appendMessage: () => "entry",
					appendCustomEntry: () => "custom",
					appendCustomMessageEntry: () => "custom",
				}),
				getBaseSystemPrompt: () => "BASE_PROMPT",
				buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
				runAgentPrompt: async () => {
					toolsDuringRun = context.agent.state.tools.map((tool) => tool.name);
					promptDuringRun = context.agent.state.systemPrompt;
				},
				refreshCurrentModelFromRegistry: () => {},
				emitAutonomyTelemetry: () => {},
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			runRoutedTurn: routerPrototype.runRoutedTurn,
		};
		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype.runRoutedTurn.call(context, [], smallCheap, route);

		// during the routed turn: 8k window -> minimal class -> autonomy tools (goal/delegate) gone
		expect(toolsDuringRun).not.toContain("goal");
		expect(toolsDuringRun).not.toContain("delegate");
		expect(toolsDuringRun).toContain("read");
		// The system prompt was rebuilt for the FILTERED surface (guidelines for goal/delegate shed)
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
			agent: {
				state: {
					model: expensiveModel,
					thinkingLevel: "high",
					messages: [],
					tools: [...sessionTools],
					systemPrompt: "BASE_PROMPT",
				},
			},
			deps: {
				getModel: () => expensiveModel,
				getAgent: () => context.agent,
				getSettingsManager: () => ({ getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) }),
				getSessionManager: () => ({
					appendMessage: () => "entry",
					appendCustomEntry: () => "custom",
					appendCustomMessageEntry: () => "custom",
				}),
				getBaseSystemPrompt: () => "BASE_PROMPT",
				buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
				runAgentPrompt: async () => {
					// prove the shed happened before the throw, so the finally has something to restore
					promptDuringRun = context.agent.state.systemPrompt;
					throw new Error("routed turn blew up");
				},
				refreshCurrentModelFromRegistry: () => {},
				emitAutonomyTelemetry: () => {},
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			runRoutedTurn: routerPrototype.runRoutedTurn,
		};
		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await expect(routerPrototype.runRoutedTurn.call(context, [], smallCheap, route)).rejects.toThrow(
			"routed turn blew up",
		);

		// the routed turn did receive the filtered prompt...
		expect(promptDuringRun).not.toContain("goal");
		// ...and the finally restored both tools and the base prompt despite the throw
		expect(context.agent.state.tools.map((tool) => tool.name)).toEqual(sessionTools.map((tool) => tool.name));
		expect(context.agent.state.systemPrompt).toBe("BASE_PROMPT");
	});

	it("does not clobber a mid-turn extension tool/prompt change (setActiveToolsByName) when restoring", async () => {
		const sessionTools = [{ name: "read" }, { name: "bash" }, { name: "goal" }, { name: "delegate" }];
		const smallCheap = { ...cheapModel, contextWindow: 8_192 };
		// What an extension's mid-turn setActiveToolsByName call assigns — brand-new references,
		// distinct from both the pre-turn session tools AND whatever the router's own swap assigned.
		const extensionTools = [{ name: "read" }, { name: "extension-tool" }];
		const extensionPrompt = "EXTENSION_OWNED_PROMPT";
		const context: RoutedRunContext = {
			agent: {
				state: {
					model: expensiveModel,
					thinkingLevel: "high",
					messages: [],
					tools: [...sessionTools],
					systemPrompt: "BASE_PROMPT",
				},
			},
			deps: {
				getModel: () => expensiveModel,
				getAgent: () => context.agent,
				getSettingsManager: () => ({ getModelCapabilitySettings: () => ({}), getModelRouterSettings: () => ({}) }),
				getSessionManager: () => ({
					appendMessage: () => "entry",
					appendCustomEntry: () => "custom",
					appendCustomMessageEntry: () => "custom",
				}),
				getBaseSystemPrompt: () => "BASE_PROMPT",
				buildSystemPromptForToolNames: (names) => `PROMPT_FOR:${names.join(",")}`,
				runAgentPrompt: async () => {
					// Simulate an extension calling session.setActiveToolsByName(...) mid-turn: it rebuilds the
					// base prompt AND reassigns both state.tools and state.systemPrompt to brand-new values,
					// without touching the model — exactly what the real setActiveToolsByName does.
					context.agent.state.tools = [...extensionTools];
					context.agent.state.systemPrompt = extensionPrompt;
				},
				refreshCurrentModelFromRegistry: () => {},
				emitAutonomyTelemetry: () => {},
			},
			_resolveModelRouterModelForIntent: () => expensiveModel,
			runRoutedTurn: routerPrototype.runRoutedTurn,
		};
		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await routerPrototype.runRoutedTurn.call(context, [], smallCheap, route);

		// Model/thinking restore is unaffected by this fix — it stays under its own guard.
		expect(context.agent.state.model).toBe(expensiveModel);
		// The extension's mid-turn tool/prompt surface must SURVIVE the router-swap restore, not be
		// silently clobbered back to the stale pre-turn snapshot.
		expect(context.agent.state.tools).toEqual(extensionTools);
		expect(context.agent.state.systemPrompt).toBe(extensionPrompt);
	});
});

describe("Router candidate pool provenance (CONFIRMED-001, FC-016)", () => {
	const RESEARCH_PROMPT = "Explain this code block";

	const poolHarness = (routerSettings: Record<string, unknown>, withOrchestrationProfile: boolean) =>
		createHarness({
			models: [
				{ id: "root-model", contextWindow: 128_000, cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } },
				{ id: "peer-model", contextWindow: 128_000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
			],
			...(withOrchestrationProfile
				? {
						orchestrationProfile: createTestWorkerOrchestrationProfile({
							profileId: "pool-provenance-root",
							model: { provider: "faux", id: "root-model" },
						}),
					}
				: {}),
			settings: { modelCapability: { mode: "off" }, modelRouter: { enabled: true, ...routerSettings } },
		});

	it("an orchestration profile pins cycling to its root model and never narrows the pool", async () => {
		const harness = await poolHarness({ selectionMode: "auto" }, true);
		try {
			expect(harness.session.scopedModels.map((scoped) => scoped.model.id)).toEqual(["root-model"]);
			const available = harness.session.modelRegistry.getAvailable();
			const pool = harness.session.getRouterCandidatePool();
			expect(pool.customized).toBe(false);
			expect(pool.source).toBe("all_enabled");
			expect(pool.models.map((model) => model.id)).toEqual(available.map((model) => model.id));
			expect(pool.models.map((model) => model.id)).toContain("peer-model");
			expect(pool.models.map((model) => model.id)).toContain("root-model");

			// AUTO can therefore still route away from the profile's root model.
			const preview = harness.session.previewRoute(RESEARCH_PROMPT);
			expect(preview.pool).toEqual({ customized: false, count: available.length, source: "all_enabled" });
			expect(preview.selection).toBe("auto");
			// The profile's root model is not the automatic choice: the pool is still the whole
			// Models configuration, so AUTO ranks across it.
			expect(preview.chosenModel).not.toBe("faux/root-model");
			expect(pool.models.map((model) => `${model.provider}/${model.id}`)).toContain(preview.chosenModel);
		} finally {
			await harness.cleanup();
		}
	});

	it("a Models-selector edit becomes the pool immediately, and clearing it restores all enabled", async () => {
		const harness = await poolHarness({ selectionMode: "auto" }, true);
		try {
			const peer = harness.session.modelRegistry.getAvailable().find((model) => model.id === "peer-model")!;
			harness.session.setRouterPool({ source: "models_selector", models: [peer] });
			const pool = harness.session.getRouterCandidatePool();
			expect(pool.customized).toBe(true);
			expect(pool.source).toBe("models_selector");
			expect(harness.session.previewRoute(RESEARCH_PROMPT).pool).toEqual({
				customized: true,
				count: 1,
				source: "models_selector",
			});

			harness.session.setRouterPool(undefined);
			expect(harness.session.getRouterCandidatePool().customized).toBe(false);
			expect(harness.session.previewRoute(RESEARCH_PROMPT).pool.count).toBe(
				harness.session.modelRegistry.getAvailable().length,
			);
		} finally {
			await harness.cleanup();
		}
	});

	it("an SDK scope with no explicit pool becomes the pool, with source sdk_models", async () => {
		const harness = await createHarness({
			models: [
				{ id: "root-model", contextWindow: 128_000 },
				{ id: "peer-model", contextWindow: 128_000 },
			],
			scopedModelIds: ["peer-model"],
			settings: { modelCapability: { mode: "off" }, modelRouter: { enabled: true, selectionMode: "auto" } },
		});
		try {
			const pool = harness.session.getRouterCandidatePool();
			expect(pool.customized).toBe(true);
			expect(pool.source).toBe("sdk_models");
			expect(pool.models.map((model) => model.id)).toEqual(["peer-model"]);
		} finally {
			await harness.cleanup();
		}
	});

	it("createAgentSession rejects an SDK scope together with an orchestration profile", async () => {
		// Why the session constructor infers `sdk_models` only when no profile is set: the SDK entry
		// point never delivers both. A caller that passes a scope with a profile is rejected here,
		// so an orchestration override can never silently consume an operator's scope as the pool.
		const authStorage = AuthStorage.inMemory();
		await expect(
			createAgentSession({
				cwd: tmpdir(),
				authStorage,
				modelRegistry: ModelRegistry.inMemory(authStorage),
				settingsManager: SettingsManager.inMemory(),
				sessionManager: SessionManager.inMemory(),
				orchestrationProfile: createTestWorkerOrchestrationProfile({
					profileId: "pool-conflict-root",
					model: { provider: "faux", id: "root-model" },
				}),
				scopedModels: [{ model: cheapModel }],
			}),
		).rejects.toThrow(/remove conflicting SDK options: scopedModels/);
	});

	it("FC-016: a manual pin outside a customized pool still wins and is reported explicitly", async () => {
		const harness = await poolHarness({ selectionMode: "manual", cheapModel: "faux/peer-model" }, false);
		try {
			const root = harness.session.modelRegistry.getAvailable().find((model) => model.id === "root-model")!;
			harness.session.setRouterPool({ source: "models_selector", models: [root] });

			const preview = harness.session.previewRoute(RESEARCH_PROMPT);
			expect(preview.manualPin).toBe("faux/peer-model");
			expect(preview.manualPinOutsidePool).toBe(true);
			expect(preview.chosenModel).toBe("faux/peer-model");

			const status = harness.session.getModelRouterStatus();
			expect(status).toContain("Pool exceptions:");
			expect(status).toContain("cheap pin faux/peer-model is outside the candidate pool");
			expect(status).toContain("1 selected model (Models selector)");
		} finally {
			await harness.cleanup();
		}
	});
});

describe("conversation stage routing", () => {
	const routedHarness = (requests: FauxRequestEvent[]) =>
		createHarness({
			models: [{ id: "root" }, { id: "cheap" }, { id: "medium" }],
			fauxProvider: { onRequest: (event) => requests.push(event) },
			settings: {
				modelRouter: {
					enabled: true,
					cheapModel: "faux/cheap",
					mediumModel: "faux/medium",
					expensiveModel: "faux/medium",
				},
			},
		});
	const talkerEntries = (harness: Awaited<ReturnType<typeof createHarness>>) =>
		harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === CONVERSATION_TALKER_CUSTOM_TYPE);

	it("chooses the talker once at the opening and keeps it for later substantive messages", async () => {
		const requests: FauxRequestEvent[] = [];
		const harness = await routedHarness(requests);
		try {
			harness.setResponses([fauxAssistantMessage("plan one"), fauxAssistantMessage("plan two")]);
			await harness.session.prompt("Plan the migration of the ledger to a new schema; list the steps.");
			expect(harness.session.model?.id).toBe("medium");
			expect(talkerEntries(harness)).toHaveLength(1);
			await harness.session.prompt("Plan the rollback for that migration; list the steps.");
			// No second route: the talker answered, and it is still the session model.
			expect(talkerEntries(harness)).toHaveLength(1);
			expect(harness.session.model?.id).toBe("medium");
			const replies = harness.session.messages.filter((message) => message.role === "assistant");
			expect(replies.map((message) => (message as AssistantMessage).model)).toEqual(["medium", "medium"]);
			// The talker's second request appends to its first.
			expect(requests[1]?.cachedChars).toBeGreaterThan(0);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps a model the owner selected before the opening as the talker, with no route judged", async () => {
		const requests: FauxRequestEvent[] = [];
		const harness = await routedHarness(requests);
		try {
			const selected = harness.getModel("root");
			expect(selected).toBeDefined();
			await harness.session.setModel(selected!);
			harness.setResponses([fauxAssistantMessage("the plan")]);
			await harness.session.prompt("Plan the migration of the ledger to a new schema; list the steps.");
			const reply = harness.session.messages.at(-1) as AssistantMessage;
			expect(reply.model).toBe("root");
			expect(harness.session.model?.id).toBe("root");
			const talkers = talkerEntries(harness);
			expect(talkers).toHaveLength(1);
			expect(talkers[0]?.type === "custom" ? talkers[0].data : undefined).toMatchObject({
				reasons: ["model selected"],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("moves the talker to where a quota failover continued the work", async () => {
		const requests: FauxRequestEvent[] = [];
		const harness = await routedHarness(requests);
		try {
			await harness.session.setModel(harness.getModel("root")!);
			vi.spyOn(harness.session.modelRegistry, "isUsingSubscription").mockReturnValue(true);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "The usage limit has been reached" }),
				fauxAssistantMessage("continued"),
			]);
			await harness.session.prompt("Plan the migration of the ledger to a new schema; list the steps.");
			const continuedOn = harness.session.model?.id;
			expect(continuedOn).not.toBe("root");
			const talkers = talkerEntries(harness);
			const latest = talkers.at(-1);
			expect(latest?.type === "custom" ? latest.data : undefined).toMatchObject({
				model: `faux/${continuedOn}`,
				reasons: ["faux/root out of quota"],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("runs internal turns on the talker with no route and no swap", async () => {
		const requests: FauxRequestEvent[] = [];
		const harness = await routedHarness(requests);
		try {
			harness.setResponses([fauxAssistantMessage("continued")]);
			// A goal continuation or route brief the classifier would call small still runs on the root lane.
			await harness.session.prompt("Explain this read-only value", { autoContinueGoal: false });
			const reply = harness.session.messages.at(-1) as AssistantMessage;
			expect(reply.model).toBe("root");
			expect(harness.session.model?.id).toBe("root");
			expect(harness.session.getModelRouterStatus()).toContain("Last decision: none");
		} finally {
			harness.cleanup();
		}
	});

	it("lets a side trip search the conversation its brief omits, on its own model, with the talker left in place", async () => {
		const requests: FauxRequestEvent[] = [];
		const harness = await routedHarness(requests);
		try {
			let sideTrip: { tools: string[]; brief: string } | undefined;
			let found = "";
			harness.setResponses([
				fauxAssistantMessage("Step one exports the ledger; step two migrates it."),
				fauxAssistantMessage("ok"),
				(context: Context) => {
					const note = context.messages.at(-2);
					sideTrip = {
						tools: (context.tools ?? []).map((tool) => tool.name),
						brief: note?.role === "user" && typeof note.content !== "string" ? JSON.stringify(note.content) : "",
					};
					return fauxAssistantMessage([fauxToolCall("conversation_history", { query: "step one" })], {
						stopReason: "toolUse",
					});
				},
				(context: Context) => {
					const result = context.messages.at(-1);
					found = result?.role === "toolResult" ? JSON.stringify(result.content) : "";
					return fauxAssistantMessage("Step one exports the ledger.");
				},
			]);
			await harness.session.prompt("Plan the migration of the ledger to a new schema; list the steps.");
			await harness.session.prompt("thanks!");
			await harness.session.prompt("What did the first step say?");
			// The side trip keeps the whole surface (reaching for a mutating tool hands the work to the
			// talker) and gains the search.
			expect(sideTrip?.tools).toContain("conversation_history");
			expect(sideTrip?.tools).toEqual(expect.arrayContaining(harness.session.getActiveToolNames()));
			expect(sideTrip?.brief).toContain("search it with conversation_history");
			// The search reads the conversation before the brief, which the brief itself never sent.
			expect(found).toContain("Step one exports the ledger");
			const reply = harness.session.messages.at(-1) as AssistantMessage;
			expect(reply.model).toBe("cheap");
			expect(harness.session.model?.id).toBe("medium");
			expect(harness.session.getModelRouterStatus()).not.toContain("escalated");
		} finally {
			harness.cleanup();
		}
	});

	it("sends a small message on a side trip that reads only its brief, leaving the talker in place", async () => {
		const requests: FauxRequestEvent[] = [];
		const harness = await routedHarness(requests);
		try {
			harness.setResponses([fauxAssistantMessage("the plan"), fauxAssistantMessage("you're welcome")]);
			await harness.session.prompt("Plan the migration of the ledger to a new schema; list the steps.");
			await harness.session.prompt("thanks!");
			const sideTrip = harness.session.messages.at(-1) as AssistantMessage;
			expect(sideTrip.model).toBe("cheap");
			expect(harness.session.model?.id).toBe("medium");
			// The brief is the talker's last reply and the new message, never the transcript.
			expect(requests[1]?.messageCount).toBe(2);
			expect(requests[1]?.messageCount).toBeLessThan(harness.session.messages.length);
		} finally {
			harness.cleanup();
		}
	});
});
