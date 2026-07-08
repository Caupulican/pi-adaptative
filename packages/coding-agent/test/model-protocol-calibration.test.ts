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
} from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

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

function messageText(context: Context): string {
	return JSON.stringify(context.messages ?? []);
}

function calibrationToken(context: Context): string {
	const text = `${context.systemPrompt ?? ""}\n${messageText(context)}`;
	const match = /data exactly "([^"]+)"/.exec(text);
	if (!match?.[1]) throw new Error(`missing calibration token in ${text}`);
	return match[1];
}

function isCalibration(context: Context): boolean {
	return (context.systemPrompt ?? "").includes("Text tool protocol calibration trial");
}

function isNativeReadTaskProbe(context: Context): boolean {
	return (context.systemPrompt ?? "").includes("task-scale read");
}

function isNativeEchoProbe(context: Context): boolean {
	return (context.systemPrompt ?? "").includes("echo-only");
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

describe("text tool protocol calibration", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-protocol-calibration-"));
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
		return { ...created, modelRegistry };
	}

	it("persists a passing first variant and skips trials in later sessions", async () => {
		const model = createModel();
		const requests: CapturedRequest[] = [];
		const first = await createSession(model, requests, (context) => {
			if (!isCalibration(context)) return "done";
			return `<pi:call name="echo">{"data":"${calibrationToken(context)}"}</pi:call>`;
		});
		try {
			await first.session.prompt("real work");
		} finally {
			first.session.dispose();
			first.modelRegistry.unregisterProvider(model.provider);
		}

		const protocol = ModelAdaptationStore.forAgentDir(agentDir).get(`${model.provider}/${model.id}`).protocol;
		expect(protocol).toMatchObject({ version: 1, variant: "tool-tag" });
		const calibrationRequests = requests.filter((request) => isCalibration(request.context));
		expect(calibrationRequests).toHaveLength(2);
		expect(calibrationRequests.every((request) => !("tools" in request.context))).toBe(true);
		const realRequest = requests.at(-1);
		expect(realRequest?.options?.textToolCallProtocol).toMatchObject({ variant: "tool-tag" });
		expect(JSON.stringify(realRequest?.context)).not.toContain("pi-calibration-");

		const secondRequests: CapturedRequest[] = [];
		const second = await createSession(model, secondRequests, (context) => {
			if (isCalibration(context)) return "unexpected calibration";
			return "done again";
		});
		try {
			await second.session.prompt("second real work");
		} finally {
			second.session.dispose();
			second.modelRegistry.unregisterProvider(model.provider);
		}

		expect(secondRequests.filter((request) => isCalibration(request.context))).toHaveLength(0);
		expect(secondRequests).toHaveLength(1);
		expect(secondRequests[0]?.options?.textToolCallProtocol).toMatchObject({ variant: "tool-tag" });
	});

	it("records the simplified variant that first round-trips and uses it for real prompts", async () => {
		const model = createModel("simplified-model");
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, (context) => {
			if (!isCalibration(context)) return "done";
			if ((context.systemPrompt ?? "").includes("<tool_call>")) {
				return `<tool_call>{"name":"echo","arguments":{"data":"${calibrationToken(context)}"}}</tool_call>`;
			}
			return "I will call echo with prose instead.";
		});
		try {
			await created.session.prompt("real work");
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}

		const protocol = ModelAdaptationStore.forAgentDir(agentDir).get(`${model.provider}/${model.id}`).protocol;
		expect(protocol).toMatchObject({ version: 1, variant: "tool-call" });
		const realRequest = requests.at(-1);
		expect(realRequest?.options?.textToolCallProtocol).toMatchObject({ variant: "tool-call" });
		expect(realRequest?.context.systemPrompt).not.toContain("pi-calibration-");
	});

	it("persists failed calibration, fast-fails until explicit reset, then reruns the ladder", async () => {
		const model = createModel("failing-model");
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, () => "I cannot emit that envelope.");
		try {
			await expect(created.session.prompt("real work")).rejects.toThrow(/cannot follow the text tool protocol/i);
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}

		expect(requests.length).toBe(4);
		expect(requests.every((request) => isCalibration(request.context))).toBe(true);
		expect(ModelAdaptationStore.forAgentDir(agentDir).get(`${model.provider}/${model.id}`).protocol).toMatchObject({
			version: 1,
			status: "failed",
			variantsTried: ["tool-tag", "tool-call", "fenced-json", "function-xml"],
		});

		const fastFailRequests: CapturedRequest[] = [];
		const fastFail = await createSession(model, fastFailRequests, () => "unexpected request");
		try {
			await expect(fastFail.session.prompt("real work again")).rejects.toThrow(
				/previous text tool protocol calibration failed/i,
			);
		} finally {
			fastFail.session.dispose();
			fastFail.modelRegistry.unregisterProvider(model.provider);
		}
		expect(fastFailRequests).toHaveLength(0);

		const resetSession = await createSession(model, [], () => "unused");
		try {
			expect(resetSession.session.resetToolProtocolCalibration(`${model.provider}/${model.id}`)).toBe(true);
		} finally {
			resetSession.session.dispose();
			resetSession.modelRegistry.unregisterProvider(model.provider);
		}

		const resetRequests: CapturedRequest[] = [];
		const afterReset = await createSession(model, resetRequests, (context) => {
			if (!isCalibration(context)) return "done";
			return `<pi:call name="echo">{"data":"${calibrationToken(context)}"}</pi:call>`;
		});
		try {
			await expect(afterReset.session.prompt("real work after reset")).resolves.toBeUndefined();
		} finally {
			afterReset.session.dispose();
			afterReset.modelRegistry.unregisterProvider(model.provider);
		}
		expect(resetRequests.filter((request) => isCalibration(request.context))).toHaveLength(2);
		expect(ModelAdaptationStore.forAgentDir(agentDir).get(`${model.provider}/${model.id}`).protocol).toMatchObject({
			version: 1,
			status: "calibrated",
			variant: "tool-tag",
		});
	});

	it("rejects native tool-call content during text-pure calibration trials", async () => {
		const model = createModel("native-during-text-calibration-model");
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, (context) => {
			if (!isCalibration(context)) return "done";
			return [
				{
					type: "toolCall",
					id: "native-calibration",
					name: "echo",
					arguments: { data: calibrationToken(context) },
				},
			];
		});
		try {
			await expect(created.session.prompt("real work")).rejects.toThrow(/cannot follow the text tool protocol/i);
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}

		expect(requests).toHaveLength(4);
		expect(requests.every((request) => isCalibration(request.context))).toBe(true);
		expect(requests.every((request) => !("tools" in request.context))).toBe(true);
	});

	it("invalidates a calibrated variant after repeated live parse failures and recalibrates once", async () => {
		const model = createModel("stale-protocol-model");
		ModelAdaptationStore.forAgentDir(agentDir).setProtocol(`${model.provider}/${model.id}`, {
			version: 1,
			status: "calibrated",
			variant: "tool-tag",
			calibratedAt: "2026-07-07T00:00:00.000Z",
		});
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, (context) => {
			if (isCalibration(context)) return `<pi:call name="echo">{"data":"${calibrationToken(context)}"}</pi:call>`;
			return `<pi:call name="echo">{"data":"live"}`;
		});
		try {
			await created.session.prompt("first malformed live turn");
			await created.session.prompt("second malformed live turn");
			await created.session.prompt("third malformed live turn");
			expect(
				ModelAdaptationStore.forAgentDir(agentDir).get(`${model.provider}/${model.id}`).protocol,
			).toBeUndefined();

			await created.session.prompt("recalibrate before this turn");
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}

		expect(requests.filter((request) => isCalibration(request.context))).toHaveLength(2);
		expect(ModelAdaptationStore.forAgentDir(agentDir).get(`${model.provider}/${model.id}`).protocol).toMatchObject({
			version: 1,
			status: "calibrated",
			variant: "tool-tag",
		});
	});

	it("does not inject the text primer for the gpt-5.5 native path without an explicit flag", async () => {
		const model = createModel("gpt-5.5", { provider: "openai-codex", textProtocol: false });
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, () => "native done");
		try {
			await created.session.prompt("native work");
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}

		expect(requests).toHaveLength(1);
		expect(requests[0]?.context.systemPrompt ?? "").not.toContain("Text tool-call protocol is enabled.");
		expect(requests[0]?.options?.textToolCallProtocol).toBeUndefined();
	});

	it("probes native, text-protocol, and none verdicts and persists them per model", async () => {
		const requests: CapturedRequest[] = [];
		const nativeModel = createModel("native-model", { provider: "native-provider", textProtocol: false });
		const textModel = createModel("text-model", { provider: "text-provider", textProtocol: false });
		const noneModel = createModel("none-model", { provider: "none-provider", textProtocol: false });
		const respondForModel = (streamModel: Model<Api>, context: Context): string | AssistantMessage["content"] => {
			if (isNativeReadTaskProbe(context) && streamModel.id === "native-model") {
				return [
					{
						type: "toolCall",
						id: "native-read-probe",
						name: "read",
						arguments: { path: nativeReadProbePath(context) },
					},
				];
			}
			if (isNativeEchoProbe(context) && (streamModel.id === "native-model" || streamModel.id === "text-model")) {
				return [
					{
						type: "toolCall",
						id: "native-echo-probe",
						name: "echo",
						arguments: { data: calibrationToken(context) },
					},
				];
			}
			if (isCalibration(context) && streamModel.id === "text-model") {
				return `<pi:call name="echo">{"data":"${calibrationToken(context)}"}</pi:call>`;
			}
			return "no tools";
		};
		const created = await createSession(nativeModel, requests, (context, _index, streamModel) =>
			respondForModel(streamModel, context),
		);
		for (const model of [nativeModel, textModel, noneModel]) {
			created.modelRegistry.registerProvider(model.provider, {
				api: model.api,
				baseUrl: model.baseUrl,
				apiKey: "test-key",
				streamSimple: (streamModel, context, options) => {
					requests.push({ context, options });
					return createDoneStream(streamModel, respondForModel(streamModel, context));
				},
				models: [model],
			});
		}

		try {
			const report = await created.session.probeToolCalling();
			const registeredResults = report.results.filter((result) =>
				["native-provider", "text-provider", "none-provider"].some((provider) =>
					result.model.startsWith(`${provider}/`),
				),
			);
			expect(registeredResults).toMatchObject([
				{ model: "native-provider/native-model", verdict: "native", nativeGrade: "task" },
				{
					model: "text-provider/text-model",
					verdict: "text-protocol",
					variant: "tool-tag",
					nativeGrade: "echo-only",
				},
				{ model: "none-provider/none-model", verdict: "none", nativeGrade: "absent" },
			]);
			expect(report.table).toContain("Native grade");
			expect(report.table).toContain("text-provider/text-model | text-protocol | tool-tag | echo-only");
		} finally {
			created.session.dispose();
			for (const model of [nativeModel, textModel, noneModel]) {
				created.modelRegistry.unregisterProvider(model.provider);
			}
		}

		const store = ModelAdaptationStore.forAgentDir(agentDir);
		expect(store.get("native-provider/native-model").toolProbe).toMatchObject({
			status: "native",
			nativeGrade: "task",
		});
		expect(store.get("text-provider/text-model").toolProbe).toMatchObject({
			status: "text-protocol",
			variant: "tool-tag",
			nativeGrade: "echo-only",
		});
		expect(store.get("none-provider/none-model").toolProbe).toMatchObject({ status: "none", nativeGrade: "absent" });
	});
});
