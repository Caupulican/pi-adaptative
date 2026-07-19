import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolValidationEscalationEvent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { RouteDecision } from "../src/core/autonomy/contracts.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { isLocalOrManagedRouterModel } from "../src/core/model-router/tool-escalation.ts";
import { ModelRouterController } from "../src/core/model-router-controller.ts";
import { ModelAdaptationStore, type ModelToolProbeVerdict } from "../src/core/models/adaptation-store.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * The capability-gate spine: the evidence-gated native→phone auto-probe, the router honoring the
 * persisted tool-probe verdict for local/managed tier models, and the validation-failure escape
 * hatch de-conflated from the beforeToolCall mutation gate.
 *
 * Every test here carries the fallback-only doctrine-regression burden: a native-capable model
 * must never be phoned speculatively, a cloud model must never be probe-gated or phoned, and the
 * phone only ever activates on graded evidence.
 */

type TestModel = Model<Api>;

interface CapturedRequest {
	context: Context;
	options?: SimpleStreamOptions;
}

/** A cloud-shaped fixture: non-local provider, non-local baseUrl. Never local/managed. */
function cloudModel(id: string, provider = "cloud-provider"): TestModel {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://cloud.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

/** A local/managed-shaped fixture: ollama provider (matches isLocalExecutionModel's provider list). */
function localModel(id: string): TestModel {
	return {
		...cloudModel(id, "ollama"),
		baseUrl: "http://localhost:11434/v1",
	};
}

function isNativeReadTaskProbe(context: Context): boolean {
	return (context.systemPrompt ?? "").includes("task-scale read");
}

function isCalibration(context: Context): boolean {
	return (context.systemPrompt ?? "").includes("Text tool protocol calibration trial");
}

function messageText(context: Context): string {
	return JSON.stringify(context.messages ?? []);
}

function calibrationToken(context: Context): string {
	const text = `${context.systemPrompt ?? ""}\n${messageText(context)}`;
	const match = /data exactly "([^"]+)"/.exec(text);
	if (!match?.[1]) throw new Error(`missing calibration token in ${text}`);
	return match[1];
}

function nativeReadProbePath(context: Context): string {
	const text = `${context.systemPrompt ?? ""}\n${messageText(context)}`;
	const match = /path exactly "([^"]+)"/.exec(text);
	if (!match?.[1]) throw new Error(`missing native read probe path in ${text}`);
	return match[1];
}

function createDoneStream(model: Model<Api>, content: string | AssistantMessage["content"]) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: typeof content === "string" ? [{ type: "text", text: content }] : content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

/** Native task probe passes (grade "task") — the doctrine-regression fixture: this model must
 * never be phoned no matter how many validation failures it racks up. */
function respondNativeCapable(_streamModel: Model<Api>, context: Context): string | AssistantMessage["content"] {
	if (isNativeReadTaskProbe(context)) {
		return [
			{ type: "toolCall", id: "native-read-probe", name: "read", arguments: { path: nativeReadProbePath(context) } },
		];
	}
	return "no further tools needed";
}

/** Both native trials fail; every text-protocol calibration trial (any variant) passes with the
 * canonical tool-tag envelope — grades "text-protocol"/"tool-tag". */
function respondTextProtocolOnly(_streamModel: Model<Api>, context: Context): string | AssistantMessage["content"] {
	if (isCalibration(context)) {
		return `<pi:call name="echo">{"data":"${calibrationToken(context)}"}</pi:call>`;
	}
	return "no tools here";
}

/** Neither native nor text-protocol ever succeeds — grades "none". */
function respondNoWorkingPath(): string | AssistantMessage["content"] {
	return "I cannot call tools.";
}

describe("capability-gate spine", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-capability-gate-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	/** Boots a real AgentSession on `driverModel` and additionally registers `extraModels`, each
	 * with its own faux streamSimple dispatching through `respond`. Mirrors the pattern
	 * model-protocol-calibration.test.ts uses to drive probeToolCalling() end to end. */
	async function createSession(
		driverModel: TestModel,
		extraModels: TestModel[],
		requests: CapturedRequest[],
		respond: (streamModel: Model<Api>, context: Context) => string | AssistantMessage["content"],
	) {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		for (const model of [driverModel, ...extraModels]) {
			authStorage.setRuntimeApiKey(model.provider, "test-api-key");
			modelRegistry.registerProvider(model.provider, {
				api: model.api,
				baseUrl: model.baseUrl,
				apiKey: "test-key",
				streamSimple: (streamModel, context, options) => {
					requests.push({ context, options });
					return createDoneStream(streamModel, respond(streamModel, context));
				},
				models: [model],
			});
		}
		const created = await createAgentSession({
			cwd,
			agentDir,
			model: driverModel,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager: SessionManager.inMemory(cwd),
		});
		return { ...created, modelRegistry };
	}

	function escalationEvent(model: TestModel, tool: string, repeats = 3): ToolValidationEscalationEvent {
		return { tool, signature: `${tool}::sig`, repeats, model: model.id, provider: model.provider };
	}

	function probeSpyOn(session: { _probeToolCallingForModel: (model: TestModel) => Promise<unknown> }) {
		return vi.spyOn(session, "_probeToolCallingForModel");
	}

	it("(a) a local/managed model's repeated READ-ONLY tool validation failure fires the auto-probe", async () => {
		const driver = cloudModel("driver");
		const phone = localModel("read-only-target");
		const requests: CapturedRequest[] = [];
		const created = await createSession(driver, [phone], requests, respondNoWorkingPath);
		try {
			const spy = probeSpyOn(
				created.session as unknown as { _probeToolCallingForModel: (m: TestModel) => Promise<unknown> },
			);
			created.session.agent.onToolValidationEscalation?.(escalationEvent(phone, "read"));
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: "read-only-target" }));
			await spy.mock.results[0]?.value;
		} finally {
			created.session.dispose();
		}
	});

	it("(b) grading no-native persists a text-protocol verdict and the model phones next turn", async () => {
		const driver = cloudModel("driver");
		const phone = localModel("phone-model");
		const requests: CapturedRequest[] = [];
		const created = await createSession(driver, [phone], requests, respondTextProtocolOnly);
		try {
			const spy = probeSpyOn(
				created.session as unknown as { _probeToolCallingForModel: (m: TestModel) => Promise<unknown> },
			);
			created.session.agent.onToolValidationEscalation?.(escalationEvent(phone, "bash"));
			await spy.mock.results[0]?.value;

			expect(
				ModelAdaptationStore.forAgentDir(agentDir).get(`${phone.provider}/${phone.id}`).toolProbe,
			).toMatchObject({
				status: "text-protocol",
				variant: "tool-tag",
				nativeGrade: "absent",
			});

			const textProtocolFlag = created.session as unknown as { _textProtocolFlag: (m: TestModel) => boolean };
			expect(textProtocolFlag._textProtocolFlag(phone)).toBe(true);
		} finally {
			created.session.dispose();
		}
	});

	it("(c) a native-capable model is NEVER phoned speculatively, even after repeated validation failures (doctrine-regression guard)", async () => {
		const driver = cloudModel("driver");
		const native = localModel("native-capable-model");
		const requests: CapturedRequest[] = [];
		const created = await createSession(driver, [native], requests, respondNativeCapable);
		try {
			const spy = probeSpyOn(
				created.session as unknown as { _probeToolCallingForModel: (m: TestModel) => Promise<unknown> },
			);
			created.session.agent.onToolValidationEscalation?.(escalationEvent(native, "write"));
			await spy.mock.results[0]?.value;

			expect(
				ModelAdaptationStore.forAgentDir(agentDir).get(`${native.provider}/${native.id}`).toolProbe,
			).toMatchObject({
				status: "native",
				nativeGrade: "task",
			});
			const textProtocolFlag = created.session as unknown as { _textProtocolFlag: (m: TestModel) => boolean };
			expect(textProtocolFlag._textProtocolFlag(native)).toBe(false);
		} finally {
			created.session.dispose();
		}
	});

	it("(d) a cloud model's validation failures escalate the tier regardless of tool name, and never probe/phone", async () => {
		const driver = cloudModel("driver");
		const requests: CapturedRequest[] = [];
		const created = await createSession(driver, [], requests, respondNoWorkingPath);
		try {
			const session = created.session as unknown as {
				_modelRouter: { _activeModelRouterRoute?: RouteDecision };
				_probeToolCallingForModel: (m: TestModel) => Promise<unknown>;
			};
			const cheapRoute: RouteDecision = {
				tier: "cheap",
				risk: "read-only",
				confidence: 1,
				reasonCode: "test_cheap_route",
				reasons: [],
			};
			session._modelRouter._activeModelRouterRoute = cheapRoute;
			const probeSpy = vi.spyOn(session, "_probeToolCallingForModel");
			const abortSpy = vi.spyOn(created.session.agent, "abort");

			// Read-only tool: the OLD bug (reusing the mutation gate) would have swallowed this.
			created.session.agent.onToolValidationEscalation?.(escalationEvent(driver, "read"));
			expect(abortSpy).toHaveBeenCalledTimes(1);

			// Mutating tool: already escalated before the fix; must still escalate after it.
			abortSpy.mockClear();
			created.session.agent.onToolValidationEscalation?.(escalationEvent(driver, "write"));
			expect(abortSpy).toHaveBeenCalledTimes(1);

			expect(probeSpy).not.toHaveBeenCalled();
		} finally {
			created.session.dispose();
		}
	});

	it("cloud validation failures do not escalate outside an active cheap-tier routed turn (scoping parity with maybeEscalateToolCall)", async () => {
		const driver = cloudModel("driver");
		const requests: CapturedRequest[] = [];
		const created = await createSession(driver, [], requests, respondNoWorkingPath);
		try {
			const abortSpy = vi.spyOn(created.session.agent, "abort");
			created.session.agent.onToolValidationEscalation?.(escalationEvent(driver, "write"));
			expect(abortSpy).not.toHaveBeenCalled();
		} finally {
			created.session.dispose();
		}
	});

	it("(f) the auto-probe does not re-fire for the same model within one session, even mid-flight (anti-loop latch)", async () => {
		const driver = cloudModel("driver");
		const phone = localModel("repeat-offender");
		const requests: CapturedRequest[] = [];
		const created = await createSession(driver, [phone], requests, respondNoWorkingPath);
		try {
			const spy = probeSpyOn(
				created.session as unknown as { _probeToolCallingForModel: (m: TestModel) => Promise<unknown> },
			);
			created.session.agent.onToolValidationEscalation?.(escalationEvent(phone, "bash"));
			created.session.agent.onToolValidationEscalation?.(escalationEvent(phone, "bash"));
			expect(spy).toHaveBeenCalledTimes(1);
			await spy.mock.results[0]?.value;
		} finally {
			created.session.dispose();
		}
	});

	it("(f) the auto-probe does not re-fire when a fresh persisted verdict already exists (anti-loop cooldown)", async () => {
		const driver = cloudModel("driver");
		const phone = localModel("already-probed");
		ModelAdaptationStore.forAgentDir(agentDir).setToolProbe(`${phone.provider}/${phone.id}`, {
			version: 1,
			status: "none",
			probedAt: new Date().toISOString(),
			nativeGrade: "absent",
		});
		const requests: CapturedRequest[] = [];
		const created = await createSession(driver, [phone], requests, respondNoWorkingPath);
		try {
			const spy = probeSpyOn(
				created.session as unknown as { _probeToolCallingForModel: (m: TestModel) => Promise<unknown> },
			);
			created.session.agent.onToolValidationEscalation?.(escalationEvent(phone, "bash"));
			expect(spy).not.toHaveBeenCalled();
		} finally {
			created.session.dispose();
		}
	});

	it("falls back to the cloud/tier-escalation path when the registry can no longer resolve the failing model", async () => {
		const driver = cloudModel("driver");
		const requests: CapturedRequest[] = [];
		const created = await createSession(driver, [], requests, respondNoWorkingPath);
		try {
			const session = created.session as unknown as {
				_modelRouter: { _activeModelRouterRoute?: RouteDecision };
			};
			session._modelRouter._activeModelRouterRoute = {
				tier: "cheap",
				risk: "read-only",
				confidence: 1,
				reasonCode: "test_cheap_route",
				reasons: [],
			};
			const abortSpy = vi.spyOn(created.session.agent, "abort");
			created.session.agent.onToolValidationEscalation?.({
				tool: "read",
				signature: "read::sig-unknown",
				repeats: 3,
				model: "unregistered-model",
				provider: "unregistered-provider",
			});
			expect(abortSpy).toHaveBeenCalledTimes(1);
		} finally {
			created.session.dispose();
		}
	});
});

describe("isLocalOrManagedRouterModel (shared predicate)", () => {
	it("is true for ollama/transformers providers regardless of baseUrl", () => {
		expect(
			isLocalOrManagedRouterModel({
				provider: "ollama",
				baseUrl: "https://not-actually-local.example",
			} as TestModel),
		).toBe(true);
		expect(
			isLocalOrManagedRouterModel({
				provider: "transformers",
				baseUrl: "https://not-actually-local.example",
			} as TestModel),
		).toBe(true);
	});

	it("is true for a localhost baseUrl regardless of provider", () => {
		expect(
			isLocalOrManagedRouterModel({ provider: "openai-compat", baseUrl: "http://127.0.0.1:8080/v1" } as TestModel),
		).toBe(true);
	});

	it("is false for a known cloud provider on a non-local baseUrl", () => {
		expect(
			isLocalOrManagedRouterModel({ provider: "anthropic", baseUrl: "https://api.anthropic.com" } as TestModel),
		).toBe(false);
	});
});

describe("model-router tier resolution honors the tool-probe verdict", () => {
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
			getToolProbeVerdict: (model: TestModel) => ModelToolProbeVerdict | undefined;
		};
	};

	type RouterPrototype = {
		_resolveModelRouterTurnRoute(
			this: RouterContext,
			prompt: string,
		): { decision: RouteDecision; model: TestModel } | undefined;
		resolveConfiguredTierModel(this: RouterContext, tier: "cheap" | "medium" | "expensive"): TestModel | undefined;
	};

	const routerPrototype = ModelRouterController.prototype as unknown as RouterPrototype;

	function createContext(
		settings: RouterSettings,
		models: TestModel[],
		getToolProbeVerdict: (model: TestModel) => ModelToolProbeVerdict | undefined = () => undefined,
	): RouterContext {
		return Object.assign(Object.create(ModelRouterController.prototype), {
			deps: {
				getSettingsManager: () => ({ getModelRouterSettings: () => settings }),
				getSessionManager: () => ({ getEntries: () => [] }),
				getAgentDir: () => "/tmp/pi-capability-gate-router-test",
				getModelRegistry: () => ({
					getAll: () => models,
					hasConfiguredAuth: () => true,
				}),
				isModelExhausted: () => false,
				getFailoverStatus: () => ({ exhausted: [] }),
				getToolProbeVerdict,
			},
		});
	}

	it("(e) routes an UNPROBED local/managed model native-first — not pre-blocked", () => {
		const phone = localModel("unprobed-model");
		const context = createContext(
			{ enabled: true, cheapModel: `${phone.provider}/${phone.id}` },
			[phone],
			() => undefined,
		);

		const resolved = routerPrototype._resolveModelRouterTurnRoute.call(context, "Explain this code block");

		expect(resolved?.model.id).toBe("unprobed-model");
	});

	it("routes a local/managed model verdicted 'native' normally", () => {
		const phone = localModel("native-verdict-model");
		const context = createContext(
			{ enabled: true, cheapModel: `${phone.provider}/${phone.id}` },
			[phone],
			() => "native",
		);

		const resolved = routerPrototype._resolveModelRouterTurnRoute.call(context, "Explain this code block");

		expect(resolved?.model.id).toBe("native-verdict-model");
	});

	it("routes a local/managed model verdicted 'text-protocol' normally (the phone lane engages downstream, not at the router)", () => {
		const phone = localModel("text-protocol-verdict-model");
		const context = createContext(
			{ enabled: true, cheapModel: `${phone.provider}/${phone.id}` },
			[phone],
			() => "text-protocol",
		);

		const resolved = routerPrototype._resolveModelRouterTurnRoute.call(context, "Explain this code block");

		expect(resolved?.model.id).toBe("text-protocol-verdict-model");
	});

	it("skips a local/managed model verdicted 'none' and falls back to the expensive tier", () => {
		const broken = localModel("no-tool-path-model");
		const expensive = cloudModel("claude-sonnet-4-5", "anthropic");
		const context = createContext(
			{
				enabled: true,
				mediumModel: `${broken.provider}/${broken.id}`,
				expensiveModel: `${expensive.provider}/${expensive.id}`,
			},
			[broken, expensive],
			(model) => (model.id === broken.id ? "none" : undefined),
		);

		const resolved = routerPrototype._resolveModelRouterTurnRoute.call(
			context,
			"Implement a small fix and update the relevant unit test.",
		);

		expect(resolved?.model.id).toBe("claude-sonnet-4-5");
		expect(resolved?.decision.reasonCode).toBe("medium_no_tool_path_fallback_expensive");
	});

	it("skips a local/managed model verdicted 'none' with no fallback available and surfaces the skip reason", () => {
		const broken = localModel("no-tool-path-only-model");
		const context = createContext(
			{ enabled: true, cheapModel: `${broken.provider}/${broken.id}` },
			[broken],
			() => "none",
		);

		const resolved = routerPrototype._resolveModelRouterTurnRoute.call(context, "Explain this code block");

		expect(resolved).toBeUndefined();
		expect(context._lastModelRouterSkipReason).toContain("no working tool-call path");
	});

	it("resolveConfiguredTierModel skips a local/managed model verdicted 'none'", () => {
		const broken = localModel("no-tool-path-tier-model");
		const context = createContext(
			{ enabled: true, expensiveModel: `${broken.provider}/${broken.id}` },
			[broken],
			() => "none",
		);

		expect(routerPrototype.resolveConfiguredTierModel.call(context, "expensive")).toBeUndefined();
	});

	it("(doctrine regression guard) never applies the no-tool-path skip to a cloud model", () => {
		const cloud = cloudModel("claude-haiku-4-5", "anthropic");
		// getToolProbeVerdict is wired to return "none" for EVERYTHING — if the router ever consulted
		// it for a cloud model (instead of gating by isLocalOrManagedRouterModel first), this would
		// wrongly skip a known-capable cloud model.
		const context = createContext(
			{ enabled: true, cheapModel: `${cloud.provider}/${cloud.id}` },
			[cloud],
			() => "none",
		);

		const resolved = routerPrototype._resolveModelRouterTurnRoute.call(context, "Explain this code block");

		expect(resolved?.model.id).toBe("claude-haiku-4-5");
	});
});
