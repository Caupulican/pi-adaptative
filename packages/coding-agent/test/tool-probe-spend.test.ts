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
	type Usage,
} from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPAWNED_USAGE_CUSTOM_TYPE, type SpawnedUsageReport } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// Regression coverage for the native tool-call probe (_runNativeReadTaskProbeTrial,
// _runNativeEchoToolProbeTrial) and the text-protocol calibration trial (_runTextProtocolTrial)
// each spend real completions. Before this fix, none of them called addSpawnedUsage, so up to
// ~10 completions on first use of a flagged model were invisible to the turn-scoped cost guard
// and daily usage. These tests drive /toolprobe end-to-end through a faux provider and assert the
// spend lands in the session's spawned-usage ledger exactly once per completion.

type TestModel = Model<Api> & { textToolCallProtocol?: true };

interface CapturedRequest {
	context: Context;
	options?: SimpleStreamOptions;
}

const DEFAULT_USAGE: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createModel(id = "probe-model", options: { provider?: string; textProtocol?: boolean } = {}): TestModel {
	const model: TestModel = {
		id,
		name: id,
		api: "openai-completions",
		provider: options.provider ?? "probe-provider",
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

function createDoneStream(
	model: Model<Api>,
	content: string | AssistantMessage["content"],
	usage: Usage = DEFAULT_USAGE,
) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: typeof content === "string" ? [{ type: "text", text: content }] : content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

describe("tool-probe and text-protocol-calibration spend counting", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-tool-probe-spend-"));
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
		const sessionManager = SessionManager.inMemory(cwd);
		const created = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager,
		});
		return { ...created, modelRegistry, sessionManager };
	}

	function spawnedUsageEntries(sessionManager: SessionManager): SpawnedUsageReport[] {
		return sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === SPAWNED_USAGE_CUSTOM_TYPE)
			.map((entry) => (entry as { data?: SpawnedUsageReport }).data)
			.filter((data): data is SpawnedUsageReport => data !== undefined);
	}

	it("counts a native task probe that passes on the first trial", async () => {
		const model = createModel("task-model", { provider: "probe-task", textProtocol: false });
		const requests: CapturedRequest[] = [];
		const { session, sessionManager, modelRegistry } = await createSession(model, requests, (context) => {
			if (isNativeReadTaskProbe(context)) {
				return [
					{ type: "toolCall", id: "read-probe", name: "read", arguments: { path: nativeReadProbePath(context) } },
				];
			}
			throw new Error(`unexpected request: ${context.systemPrompt}`);
		});
		try {
			const report = await session.probeToolCalling(`${model.provider}/${model.id}`);
			expect(report.results).toMatchObject([{ verdict: "native", nativeGrade: "task" }]);
			expect(requests).toHaveLength(1);

			expect(session.getSpawnedUsage().reports).toBe(1);
			const entries = spawnedUsageEntries(sessionManager);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ label: "tool-probe", usage: { totalTokens: 2 } });
			expect(entries[0]?.reportId).toMatch(new RegExp(`^tool-probe:${model.provider}/${model.id}:read-task:\\d+$`));
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("counts every native + calibration trial exactly once, each with a distinct reportId", async () => {
		const model = createModel("ladder-model", { provider: "probe-ladder", textProtocol: false });
		const requests: CapturedRequest[] = [];
		const { session, sessionManager, modelRegistry } = await createSession(model, requests, (context) => {
			if (isNativeReadTaskProbe(context)) return "no tools";
			if (isNativeEchoProbe(context)) return "no tools";
			if (isCalibration(context)) return "I cannot emit that envelope.";
			throw new Error(`unexpected request: ${context.systemPrompt}`);
		});
		try {
			const report = await session.probeToolCalling(`${model.provider}/${model.id}`);
			expect(report.results).toMatchObject([{ verdict: "none", nativeGrade: "absent" }]);
			// 1 read-task + 1 echo + 4 calibration variants (1 failing trial each) = 6 completions.
			expect(requests).toHaveLength(6);

			expect(session.getSpawnedUsage().reports).toBe(6);
			const entries = spawnedUsageEntries(sessionManager);
			expect(entries).toHaveLength(6);

			const toolProbeEntries = entries.filter((entry) => entry.label === "tool-probe");
			const calibrationEntries = entries.filter((entry) => entry.label === "text-protocol-calibration");
			expect(toolProbeEntries).toHaveLength(2);
			expect(calibrationEntries).toHaveLength(4);

			const modelPrefix = `tool-probe:${model.provider}/${model.id}`;
			expect(toolProbeEntries.map((e) => e.reportId).sort()).toEqual(
				[`${modelPrefix}:echo:1`, `${modelPrefix}:read-task:0`].sort(),
			);
			for (const variant of ["tool-tag", "tool-call", "fenced-json", "function-xml"]) {
				expect(
					calibrationEntries.some((e) => e.reportId?.startsWith(`${modelPrefix}:text-protocol:${variant}:`)),
				).toBe(true);
			}

			// Every reportId is unique -- no completion's spend was dropped by an accidental collision.
			const reportIds = entries.map((e) => e.reportId);
			expect(new Set(reportIds).size).toBe(reportIds.length);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("does not double-count a re-report of the same reportId", async () => {
		const model = createModel("dedupe-model", { provider: "probe-dedupe", textProtocol: false });
		const { session, sessionManager, modelRegistry } = await createSession(model, [], () => "unused");
		try {
			const usage: Usage = {
				input: 5,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 10,
				cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
			};
			const first = session.addSpawnedUsage(usage, { label: "tool-probe", reportId: "fixed-probe-id" });
			const second = session.addSpawnedUsage(usage, { label: "tool-probe", reportId: "fixed-probe-id" });
			expect(first).toBeDefined();
			expect(second).toBeUndefined();
			expect(session.getSpawnedUsage().reports).toBe(1);
			expect(spawnedUsageEntries(sessionManager)).toHaveLength(1);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("counts spend again on a second /toolprobe run instead of deduping it away", async () => {
		const model = createModel("repeat-model", { provider: "probe-repeat", textProtocol: false });
		const requests: CapturedRequest[] = [];
		const { session, sessionManager, modelRegistry } = await createSession(model, requests, (context) => {
			if (isNativeReadTaskProbe(context)) {
				return [
					{ type: "toolCall", id: "read-probe", name: "read", arguments: { path: nativeReadProbePath(context) } },
				];
			}
			throw new Error(`unexpected request: ${context.systemPrompt}`);
		});
		try {
			await session.probeToolCalling(`${model.provider}/${model.id}`);
			expect(session.getSpawnedUsage().reports).toBe(1);

			await session.probeToolCalling(`${model.provider}/${model.id}`);
			expect(session.getSpawnedUsage().reports).toBe(2);

			const entries = spawnedUsageEntries(sessionManager);
			expect(entries).toHaveLength(2);
			expect(entries[0]?.reportId).not.toBe(entries[1]?.reportId);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("does not report spend for a probe completion with no reportable usage", async () => {
		const model = createModel("zero-usage-model", { provider: "probe-zero", textProtocol: false });
		const requests: CapturedRequest[] = [];
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (streamModel, context, options) => {
				requests.push({ context, options });
				if (isNativeReadTaskProbe(context)) {
					return createDoneStream(
						streamModel,
						[
							{
								type: "toolCall",
								id: "read-probe",
								name: "read",
								arguments: { path: nativeReadProbePath(context) },
							},
						],
						ZERO_USAGE,
					);
				}
				throw new Error(`unexpected request: ${context.systemPrompt}`);
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager,
		});
		try {
			const report = await session.probeToolCalling(`${model.provider}/${model.id}`);
			expect(report.results).toMatchObject([{ verdict: "native", nativeGrade: "task" }]);
			expect(requests).toHaveLength(1);
			expect(session.getSpawnedUsage().reports).toBe(0);
			expect(spawnedUsageEntries(sessionManager)).toHaveLength(0);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});
});
