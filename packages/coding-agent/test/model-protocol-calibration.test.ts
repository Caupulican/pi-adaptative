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

	// Calibration is now off the hot path -- _ensureTextToolProtocolForActiveModel
	// is a pure reader of the persisted verdict and never calls _calibrateTextToolProtocolForModel
	// inline. So the ladder that used to run on a model's first `.prompt()` now only runs through the
	// explicit `/toolprobe` entry point (probeToolCalling), which is what these tests drive. Turn-safety
	// (no throw, no inline recalibration, the demote-on-evidence breaker, the force-enable default, the
	// corrective steer) is covered by text-protocol-breaker.test.ts.

	it("probeToolCalling persists a passing first variant, and real prompts reuse it without recalibrating", async () => {
		const model = createModel("graded-model", { textProtocol: false });
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, (context) => {
			if (isNativeReadTaskProbe(context)) return "no tools";
			if (isNativeEchoProbe(context)) return "no tools";
			if (isCalibration(context)) return `<pi:call name="echo">{"data":"${calibrationToken(context)}"}</pi:call>`;
			return "done";
		});
		try {
			const report = await created.session.probeToolCalling(`${model.provider}/${model.id}`);
			expect(report.results).toMatchObject([{ verdict: "text-protocol", variant: "tool-tag" }]);

			const protocol = ModelAdaptationStore.forAgentDir(agentDir).get(`${model.provider}/${model.id}`).protocol;
			expect(protocol).toMatchObject({ version: 1, variant: "tool-tag" });

			requests.length = 0;
			await created.session.prompt("real work");
			expect(requests).toHaveLength(1);
			expect(requests[0]?.options?.textToolCallProtocol).toMatchObject({ variant: "tool-tag" });
			expect(requests[0]?.context.systemPrompt ?? "").not.toContain("pi-calibration-");

			// A second, fresh session for the same model reuses the persisted variant too -- no re-probe,
			// no calibration requests.
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
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("probeToolCalling records the simplified variant that first round-trips and real prompts use it", async () => {
		const model = createModel("simplified-model", { textProtocol: false });
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, (context) => {
			if (isNativeReadTaskProbe(context)) return "no tools";
			if (isNativeEchoProbe(context)) return "no tools";
			if (!isCalibration(context)) return "done";
			if ((context.systemPrompt ?? "").includes("<tool_call>")) {
				return `<tool_call>{"name":"echo","arguments":{"data":"${calibrationToken(context)}"}}</tool_call>`;
			}
			return "I will call echo with prose instead.";
		});
		try {
			const report = await created.session.probeToolCalling(`${model.provider}/${model.id}`);
			expect(report.results).toMatchObject([{ verdict: "text-protocol", variant: "tool-call" }]);

			const protocol = ModelAdaptationStore.forAgentDir(agentDir).get(`${model.provider}/${model.id}`).protocol;
			expect(protocol).toMatchObject({ version: 1, variant: "tool-call" });

			requests.length = 0;
			await created.session.prompt("real work");
			expect(requests).toHaveLength(1);
			expect(requests[0]?.options?.textToolCallProtocol).toMatchObject({ variant: "tool-call" });
			expect(requests[0]?.context.systemPrompt ?? "").not.toContain("pi-calibration-");
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("probeToolCalling persists a 'none' verdict (not a stuck 'failed' protocol) when no variant round-trips, and /toolprotocol-reset clears a stale one", async () => {
		const model = createModel("failing-model", { textProtocol: false });
		const modelKey = `${model.provider}/${model.id}`;
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, (context) => {
			if (isNativeReadTaskProbe(context)) return "no tools";
			if (isNativeEchoProbe(context)) return "no tools";
			return "I cannot emit that envelope.";
		});
		try {
			const report = await created.session.probeToolCalling(`${model.provider}/${model.id}`);
			expect(report.results).toMatchObject([{ verdict: "none", nativeGrade: "absent" }]);
			// persistFailure:false on the /toolprobe path (agent-session.ts _probeToolCallingForModel):
			// a failed calibration ladder never gets stuck as a persisted "failed" protocol -- only the
			// honest "none" tool-probe verdict is recorded, so a later graded-evidence re-probe is free
			// to try again rather than fast-failing forever.
			const store = ModelAdaptationStore.forAgentDir(agentDir);
			expect(store.get(modelKey).protocol).toBeUndefined();
			expect(store.get(modelKey).toolProbe).toMatchObject({ status: "none", nativeGrade: "absent" });

			// A stale "failed" protocol record from before this fix (or from direct store manipulation)
			// is still readable/removable through the existing reset command.
			store.setProtocol(modelKey, {
				version: 1,
				status: "failed",
				attemptedAt: "2026-07-18T00:00:00.000Z",
				variantsTried: ["tool-tag", "tool-call", "fenced-json", "function-xml"],
			});
			expect(created.session.resetToolProtocolCalibration(modelKey)).toBe(true);
			expect(store.get(modelKey).protocol).toBeUndefined();
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("rejects native tool-call content during text-pure calibration trials (via /toolprobe)", async () => {
		const model = createModel("native-during-text-calibration-model", { textProtocol: false });
		const requests: CapturedRequest[] = [];
		const created = await createSession(model, requests, (context) => {
			if (isNativeReadTaskProbe(context)) return "no tools";
			if (isNativeEchoProbe(context)) return "no tools";
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
			const report = await created.session.probeToolCalling(`${model.provider}/${model.id}`);
			expect(report.results).toMatchObject([{ verdict: "none", nativeGrade: "absent" }]);

			const calibrationRequests = requests.filter((request) => isCalibration(request.context));
			expect(calibrationRequests.length).toBeGreaterThan(0);
			expect(calibrationRequests.every((request) => !("tools" in request.context))).toBe(true);
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("demotes a calibrated variant to native after repeated live parse failures, and does not recalibrate inline afterward", async () => {
		const model = createModel("stale-protocol-model", { textProtocol: false });
		const modelKey = `${model.provider}/${model.id}`;
		ModelAdaptationStore.forAgentDir(agentDir).setToolProbe(modelKey, {
			version: 1,
			status: "text-protocol",
			variant: "tool-tag",
			probedAt: "2026-07-07T00:00:00.000Z",
		});
		ModelAdaptationStore.forAgentDir(agentDir).setProtocol(modelKey, {
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

			// The 3rd same-signature failure demotes both records -- the calibrated
			// protocol is removed AND the tool-probe verdict is downgraded to "none" -- so the model
			// stays on native instead of the old behavior of recalibrating inline on the very next turn.
			const store = ModelAdaptationStore.forAgentDir(agentDir);
			expect(store.get(modelKey).protocol).toBeUndefined();
			expect(store.get(modelKey).toolProbe).toMatchObject({ status: "none" });

			requests.length = 0;
			await created.session.prompt("fourth turn stays native");
			expect(requests).toHaveLength(1);
			expect(requests.filter((request) => isCalibration(request.context))).toHaveLength(0);
			expect(requests[0]?.options?.textToolCallProtocol).toBeFalsy();
		} finally {
			created.session.dispose();
			created.modelRegistry.unregisterProvider(model.provider);
		}
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
		const taskOnlyModel = createModel("task-only-model", { provider: "task-provider", textProtocol: false });
		const textModel = createModel("text-model", { provider: "text-provider", textProtocol: false });
		const noneModel = createModel("none-model", { provider: "none-provider", textProtocol: false });
		const respondForModel = (streamModel: Model<Api>, context: Context): string | AssistantMessage["content"] => {
			if (
				isNativeReadTaskProbe(context) &&
				(streamModel.id === "native-model" || streamModel.id === "task-only-model")
			) {
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
		for (const model of [nativeModel, taskOnlyModel, textModel, noneModel]) {
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
				["native-provider", "task-provider", "text-provider", "none-provider"].some((provider) =>
					result.model.startsWith(`${provider}/`),
				),
			);
			expect(registeredResults).toMatchObject([
				{ model: "native-provider/native-model", verdict: "native", nativeGrade: "task" },
				{ model: "task-provider/task-only-model", verdict: "native", nativeGrade: "task" },
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
			for (const model of [nativeModel, taskOnlyModel, textModel, noneModel]) {
				created.modelRegistry.unregisterProvider(model.provider);
			}
		}

		const store = ModelAdaptationStore.forAgentDir(agentDir);
		expect(store.get("native-provider/native-model").toolProbe).toMatchObject({
			status: "native",
			nativeGrade: "task",
		});
		expect(store.get("task-provider/task-only-model").toolProbe).toMatchObject({
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
