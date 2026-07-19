import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TextToolProtocolParseEvent,
} from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// Regression coverage for the text-protocol circuit breaker. Before this
// fix, _ensureTextToolProtocolForActiveModel could (a) throw out of the prompt path -- losing the
// user's turn -- for a persisted "failed" protocol or a failed inline recalibration, (b) run up to 8
// inline calibration completions on the hot path whenever the flag was on but no valid protocol was
// persisted (including for force-enabled models), and (c) the parse-failure breaker removed the
// calibrated protocol on the 3rd same-signature failure but left the toolProbe verdict untouched, so
// the flag stayed on and the very next turn re-ran the full 8-completion ladder again. See
// text-protocol-grammar.md for the full doctrine this enforces.

type TestModel = Model<Api> & { textToolCallProtocol?: true };

interface CapturedRequest {
	context: Context;
	options?: SimpleStreamOptions;
}

function createModel(id = "phone-model", options: { provider?: string; textProtocol?: boolean } = {}): TestModel {
	const model: TestModel = {
		id,
		name: id,
		api: "openai-completions",
		provider: options.provider ?? "phone-provider",
		baseUrl: "https://phone.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
	if (options.textProtocol !== false) {
		model.textToolCallProtocol = true;
	}
	return model;
}

function isCalibration(context: Context): boolean {
	return (context.systemPrompt ?? "").includes("Text tool protocol calibration trial");
}

function messageText(context: Context): string {
	return JSON.stringify(context.messages ?? []);
}

/** Concatenates every text block across every message, unescaped -- for substring matching against
 * literal envelope syntax (quotes, brackets) that JSON.stringify would otherwise backslash-escape. */
function allMessageText(context: Context): string {
	return (context.messages ?? [])
		.flatMap((message) => {
			const content = "content" in message ? message.content : undefined;
			if (typeof content === "string") return [content];
			if (!Array.isArray(content)) return [];
			return content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text);
		})
		.join("\n");
}

function calibrationToken(context: Context): string {
	const text = `${context.systemPrompt ?? ""}\n${messageText(context)}`;
	const match = /data exactly "([^"]+)"/.exec(text);
	if (!match?.[1]) throw new Error(`missing calibration token in ${text}`);
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

describe("text-protocol circuit breaker", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-protocol-breaker-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(
		model: TestModel,
		requests: CapturedRequest[],
		respond: (context: Context, index: number, model: Model<Api>) => string | AssistantMessage["content"],
	) {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (streamModel, context, options) => {
				requests.push({ context, options });
				return createDoneStream(streamModel, respond(context, requests.length, streamModel));
			},
		});
		const created = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager: SessionManager.inMemory(cwd),
		});
		const events: AgentSessionEvent[] = [];
		created.session.subscribe((event) => events.push(event));
		return { ...created, modelRegistry, events };
	}

	function warningMessages(events: AgentSessionEvent[]): string[] {
		return events.filter((event) => event.type === "warning").map((event) => event.message);
	}

	it("falls back to native with a warning instead of throwing when a stale 'failed' protocol is on record", async () => {
		const model = createModel("stale-failed-model", { textProtocol: false });
		const modelKey = `${model.provider}/${model.id}`;
		// A "failed" protocol.status can no longer be produced by the hot path after this fix (only
		// _calibrateTextToolProtocolForModel's persistFailure:true caller did that, and it was inline-
		// only -- since removed). Seed it directly to cover the defensive/backward-compat branch:
		// state written by a prior session/version, or a stale record surviving a partial reset.
		ModelAdaptationStore.forAgentDir(agentDir).setToolProbe(modelKey, {
			version: 1,
			status: "text-protocol",
			variant: "tool-tag",
			probedAt: "2026-07-18T00:00:00.000Z",
		});
		ModelAdaptationStore.forAgentDir(agentDir).setProtocol(modelKey, {
			version: 1,
			status: "failed",
			attemptedAt: "2026-07-18T00:00:00.000Z",
			variantsTried: ["tool-tag", "tool-call", "fenced-json", "function-xml"],
		});
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, () => "native done");
		try {
			await expect(created.session.prompt("real work")).resolves.toBeUndefined();
			expect(requests).toHaveLength(1);
			expect(requests[0]?.options?.textToolCallProtocol).toBeFalsy();
			expect(requests[0]?.context.systemPrompt ?? "").not.toContain("Text tool-call protocol is enabled.");
			expect(
				warningMessages(created.events).some(
					(message) => /previously failed/i.test(message) && /falling back to native/i.test(message),
				),
			).toBe(true);
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("falls back to native with a warning and runs zero calibration completions when the flag is on but nothing valid is persisted", async () => {
		const model = createModel("no-protocol-model", { textProtocol: false });
		const modelKey = `${model.provider}/${model.id}`;
		// Graded evidence (a prior /toolprobe) turned the flag on, but no calibrated variant is on
		// record for it -- the case that used to run the full 8-completion ladder inline.
		ModelAdaptationStore.forAgentDir(agentDir).setToolProbe(modelKey, {
			version: 1,
			status: "text-protocol",
			variant: "tool-tag",
			probedAt: "2026-07-18T00:00:00.000Z",
		});
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, () => "native done");
		try {
			await expect(created.session.prompt("real work")).resolves.toBeUndefined();
			expect(requests).toHaveLength(1);
			expect(requests.every((request) => !isCalibration(request.context))).toBe(true);
			expect(requests[0]?.options?.textToolCallProtocol).toBeFalsy();
			expect(
				warningMessages(created.events).some(
					(message) => /no valid calibration on record/i.test(message) && /\/toolprobe/.test(message),
				),
			).toBe(true);
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("the force-enable override still defaults to the tool-tag variant with zero inline calibration completions", async () => {
		const model = createModel("force-enabled-model"); // textToolCallProtocol: true (per-model force-enable)
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, () => "done");
		try {
			await expect(created.session.prompt("real work")).resolves.toBeUndefined();
			expect(requests).toHaveLength(1);
			expect(requests.every((request) => !isCalibration(request.context))).toBe(true);
			expect(requests[0]?.options?.textToolCallProtocol).toBe(true);
			expect(requests[0]?.context.systemPrompt ?? "").toContain("Text tool-call protocol is enabled.");
			// Force-enable never touches the calibration store -- it always defaults, never calibrates.
			expect(
				ModelAdaptationStore.forAgentDir(agentDir).get(`${model.provider}/${model.id}`).protocol,
			).toBeUndefined();
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("a stale 'failed' protocol does not block the force-enable override (force-enable is checked first)", async () => {
		const model = createModel("force-enabled-with-stale-failure-model");
		const modelKey = `${model.provider}/${model.id}`;
		ModelAdaptationStore.forAgentDir(agentDir).setProtocol(modelKey, {
			version: 1,
			status: "failed",
			attemptedAt: "2026-07-18T00:00:00.000Z",
			variantsTried: ["tool-tag", "tool-call", "fenced-json", "function-xml"],
		});
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, () => "done");
		try {
			await expect(created.session.prompt("real work")).resolves.toBeUndefined();
			expect(requests).toHaveLength(1);
			expect(requests.every((request) => !isCalibration(request.context))).toBe(true);
			expect(requests[0]?.options?.textToolCallProtocol).toBe(true);
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("demotes to native on the 3rd same-signature live parse failure and stays native afterward, without recalibrating", async () => {
		const model = createModel("thrashing-model", { textProtocol: false });
		const modelKey = `${model.provider}/${model.id}`;
		ModelAdaptationStore.forAgentDir(agentDir).setToolProbe(modelKey, {
			version: 1,
			status: "text-protocol",
			variant: "tool-tag",
			probedAt: "2026-07-18T00:00:00.000Z",
		});
		ModelAdaptationStore.forAgentDir(agentDir).setProtocol(modelKey, {
			version: 1,
			status: "calibrated",
			variant: "tool-tag",
			calibratedAt: "2026-07-18T00:00:00.000Z",
		});
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, (context) => {
			if (isCalibration(context)) return `<pi:call name="echo">{"data":"${calibrationToken(context)}"}</pi:call>`;
			// An unterminated envelope naming an unregistered tool: the model attempts the protocol
			// every single completion (including the agent's own intra-turn retries after the bounce),
			// but _recordTextToolProtocolParseOutcomeFromLastAssistant reports at most one outcome per
			// OUTER .prompt() call, so this always-malformed response still yields exactly one
			// same-signature failure per turn -- the evidence the breaker counts.
			return `<pi:call name="echo">{"data":"live"}`;
		});
		try {
			await created.session.prompt("first malformed live turn");
			await created.session.prompt("second malformed live turn");
			await created.session.prompt("third malformed live turn");

			const store = ModelAdaptationStore.forAgentDir(agentDir);
			expect(store.get(modelKey).protocol).toBeUndefined();
			expect(store.get(modelKey).toolProbe).toMatchObject({ status: "none" });
			expect(
				warningMessages(created.events).some((message) => /stopped parsing after 3 attempts/i.test(message)),
			).toBe(true);

			requests.length = 0;
			await expect(created.session.prompt("fourth turn is native, no throw")).resolves.toBeUndefined();
			expect(requests).toHaveLength(1);
			expect(requests.every((request) => !isCalibration(request.context))).toBe(true);
			expect(requests[0]?.options?.textToolCallProtocol).toBeFalsy();
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("injects a one-line corrective steer after the first parse failure, throttled every Nth failure after", async () => {
		const model = createModel("steer-model", { textProtocol: false });
		const modelKey = `${model.provider}/${model.id}`;
		ModelAdaptationStore.forAgentDir(agentDir).setToolProbe(modelKey, {
			version: 1,
			status: "text-protocol",
			variant: "tool-tag",
			probedAt: "2026-07-18T00:00:00.000Z",
		});
		ModelAdaptationStore.forAgentDir(agentDir).setProtocol(modelKey, {
			version: 1,
			status: "calibrated",
			variant: "tool-tag",
			calibratedAt: "2026-07-18T00:00:00.000Z",
		});
		const created = await createSession(model, [], () => "unused");
		try {
			const session = created.session as unknown as { _pendingNextTurnMessages: readonly unknown[] };
			const event: TextToolProtocolParseEvent = {
				provider: model.provider,
				model: model.id,
				variant: "tool-tag",
				status: "failed",
				callCount: 0,
				textLength: 12,
				reason: "unrecognized",
			};
			const pendingCountAfterEachCall: number[] = [];
			for (let i = 0; i < 6; i++) {
				created.session.agent.onTextToolProtocolParse?.(event);
				pendingCountAfterEachCall.push(session._pendingNextTurnMessages.length);
			}
			// 1st failure queues a steer (count 1). 2nd-4th are throttled (still 1). The 5th (the
			// TEXT_TOOL_PROTOCOL_STEER_INTERVAL-th) queues another (count 2). The 6th is throttled again.
			expect(pendingCountAfterEachCall).toEqual([1, 1, 1, 1, 2, 2]);
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("the corrective steer reaches the model on the next turn as plain text matching the envelope grammar", async () => {
		const model = createModel("steer-delivery-model", { textProtocol: false });
		const modelKey = `${model.provider}/${model.id}`;
		ModelAdaptationStore.forAgentDir(agentDir).setToolProbe(modelKey, {
			version: 1,
			status: "text-protocol",
			variant: "tool-tag",
			probedAt: "2026-07-18T00:00:00.000Z",
		});
		ModelAdaptationStore.forAgentDir(agentDir).setProtocol(modelKey, {
			version: 1,
			status: "calibrated",
			variant: "tool-tag",
			calibratedAt: "2026-07-18T00:00:00.000Z",
		});
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, () => "done");
		try {
			created.session.agent.onTextToolProtocolParse?.({
				provider: model.provider,
				model: model.id,
				variant: "tool-tag",
				status: "failed",
				callCount: 0,
				textLength: 12,
				reason: "unrecognized",
			});

			await created.session.prompt("next turn should carry the steer");
			expect(requests).toHaveLength(1);
			const payload = allMessageText(requests[0]?.context ?? { messages: [] });
			expect(payload).toContain("emit exactly this envelope shape");
			expect(payload).toContain(`<pi:call name="TOOL">{"arg":"value"}</pi:call>`);
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
	});
});
