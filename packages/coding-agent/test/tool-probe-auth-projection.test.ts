// @guards packages/coding-agent/src/core/tool-protocol-controller.ts
import { Agent } from "@caupulican/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ToolProtocolController } from "../src/core/tool-protocol-controller.ts";
import { tempDir } from "./temp-dir.ts";

const model: Model<Api> = {
	id: "raw-auth-probe",
	name: "Raw auth probe",
	api: "openai-completions",
	provider: "probe-fixture",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function completedNativeReadProbe(systemPrompt: string): ReturnType<typeof createAssistantMessageEventStream> {
	const path = /path exactly "([^"]+)"/.exec(systemPrompt)?.[1];
	if (!path) throw new Error("missing native read probe path");
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "toolCall", id: "read-probe", name: "read", arguments: { path } }],
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
	stream.push({ type: "done", reason: "toolUse", message });
	return stream;
}

describe("tool probe request auth", () => {
	it("carries the atomic credential projection through the raw stream adapter", async () => {
		const agentDir = tempDir("pi-tool-probe-auth-");
		const agent = new Agent({ initialState: { model } });
		const requests: SimpleStreamOptions[] = [];
		agent.streamFn = (_streamModel, context, options) => {
			requests.push(options ?? {});
			return completedNativeReadProbe(context.systemPrompt ?? "");
		};
		const controller = new ToolProtocolController({
			agent,
			agentDir,
			adaptationStore: ModelAdaptationStore.forAgentDir(agentDir),
			settingsManager: SettingsManager.inMemory(),
			getModelRegistry: () => {
				throw new Error("unexpected registry access");
			},
			isRawStreamSimple: () => true,
			getRequiredRequestAuth: async () => ({
				apiKey: "request-key",
				headers: { "x-request-header": "ordinary" },
				credentialHeaders: { "x-provider-account": "subscription-a" },
				providerAccountKey: "probe-fixture:subscription-a",
			}),
			addSpawnedUsage: () => undefined,
			emitWarning: vi.fn(),
			sendCorrectiveSteer: async () => {},
			findLastAssistantMessage: () => undefined,
			buildToolFreeSystemPrompt: (suffix) => suffix,
			isDisposed: () => false,
			probeForAuto: async () => {
				throw new Error("unexpected automatic probe");
			},
		});

		await expect(controller.probeToolCallingForModel(model)).resolves.toMatchObject({
			verdict: "native",
			nativeGrade: "task",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			apiKey: "request-key",
			headers: { "x-request-header": "ordinary" },
			credentialHeaders: { "x-provider-account": "subscription-a" },
			providerAccountKey: "probe-fixture:subscription-a",
		});
	});
});
