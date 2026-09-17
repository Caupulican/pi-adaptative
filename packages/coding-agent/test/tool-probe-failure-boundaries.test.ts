import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@caupulican/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ToolProtocolController } from "../src/core/tool-protocol-controller.ts";
import { nodeFs } from "../src/core/util/faultable-fs.ts";

const model: Model<Api> = {
	id: "probe-model",
	name: "Probe model",
	api: "openai-completions",
	provider: "probe-fixture",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const modelKey = `${model.provider}/${model.id}`;
const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(
	respond: (context: Context, index: number) => AssistantMessage | AssistantMessageEventStream,
	isDisposed: () => boolean = () => false,
) {
	const dir = mkdtempSync(join(tmpdir(), "pi-probe-boundaries-"));
	dirs.push(dir);
	const store = ModelAdaptationStore.forAgentDir(dir);
	const agent = new Agent({ initialState: { model } });
	const requests: Context[] = [];
	agent.streamFn = (_model, context) => {
		requests.push(context);
		const result = respond(context, requests.length);
		if ("result" in result) return result;
		const stream = createAssistantMessageEventStream();
		if (result.stopReason === "error" || result.stopReason === "aborted") {
			stream.push({ type: "error", reason: result.stopReason, error: result });
		} else {
			stream.push({ type: "done", reason: result.stopReason, message: result });
		}
		return stream;
	};
	const addSpawnedUsage = vi.fn(() => undefined);
	const controller = new ToolProtocolController({
		agent,
		agentDir: dir,
		adaptationStore: store,
		settingsManager: SettingsManager.inMemory(),
		getModelRegistry: () => {
			throw new Error("unexpected registry access");
		},
		isRawStreamSimple: () => false,
		getRequiredRequestAuth: async () => {
			throw new Error("unexpected auth access");
		},
		addSpawnedUsage,
		emitWarning: vi.fn(),
		sendCorrectiveSteer: async () => {},
		findLastAssistantMessage: () => undefined,
		buildToolFreeSystemPrompt: (suffix) => suffix,
		isDisposed,
		probeForAuto: async () => {
			throw new Error("unexpected automatic probe");
		},
	});
	return { controller, store, requests, addSpawnedUsage };
}

function response(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		stopReason,
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
}

function matchingContent(context: Context): AssistantMessage["content"] {
	const prompt = context.systemPrompt ?? "";
	if (prompt.includes("task-scale read")) {
		const path = /path exactly "([^"]+)"/.exec(prompt)?.[1];
		if (!path) throw new Error("missing fixture path");
		return [{ type: "toolCall", id: "partial", name: "read", arguments: { path } }];
	}
	const envelope = prompt.split("Output only:\n").at(-1);
	if (!envelope) throw new Error("missing fixture envelope");
	return [{ type: "text", text: envelope }];
}

describe("tool probe failure boundaries", () => {
	it.each([false, true])("commits a text route and its calibration together; commit fails: %s", async (failCommit) => {
		const { controller, store } = fixture((context, index) =>
			index <= 2 ? response([]) : response(matchingContent(context)),
		);
		const before = store.get(modelKey);
		const rename = vi.spyOn(nodeFs, "renameSync");
		if (failCommit) {
			vi.spyOn(store, "setToolProbe").mockImplementationOnce(() => {
				throw new Error("fixture route commit failure");
			});
		}
		const result = await controller.probeToolCallingForModel(model);
		if (failCommit) {
			expect(result.verdict).toBe("inconclusive");
			expect(store.get(modelKey)).toEqual(before);
			expect(rename).not.toHaveBeenCalled();
		} else {
			expect(result.verdict).toBe("text-protocol");
			expect(store.get(modelKey).toolProbe?.status).toBe("text-protocol");
			expect(store.get(modelKey).protocol?.status).toBe("calibrated");
			expect(rename).toHaveBeenCalledTimes(1);
		}
	});

	it.each([1, 3, 4, 6])("fences an older delayed probe at request %s after a newer verdict", async (failAt) => {
		const delayed = createAssistantMessageEventStream();
		const reached = Promise.withResolvers<void>();
		const { controller, store, requests, addSpawnedUsage } = fixture((context, index) => {
			if (index === failAt) {
				reached.resolve();
				return delayed;
			}
			if (index <= 2 || index > failAt) return response([]);
			return response(matchingContent(context));
		});
		const older = controller.probeToolCallingForModel(model);
		await reached.promise;
		const newer = await controller.probeToolCallingForModel(model);
		expect(newer.verdict).toBe("none");
		const committed = store.get(modelKey);
		const lateResult = response(matchingContent(requests[failAt - 1]), "toolUse");
		delayed.push({ type: "done", reason: "toolUse", message: lateResult });
		expect((await older).verdict).toBe("inconclusive");
		expect(store.get(modelKey)).toEqual(committed);
		expect(requests).toHaveLength(failAt + 6);
		expect(addSpawnedUsage).toHaveBeenCalledTimes(failAt + 6);
	});

	it("reports an inconclusive result when the final negative verdict cannot be persisted", async () => {
		const { controller, store } = fixture(() => response([]));
		vi.spyOn(store, "setToolProbe").mockImplementationOnce(() => {
			throw new Error("fixture probe storage failure");
		});
		await expect(controller.probeToolCallingForModel(model)).resolves.toMatchObject({
			verdict: "inconclusive",
			diagnostic: "fixture probe storage failure",
		});
		expect(store.get(modelKey).toolProbe).toBeUndefined();
	});

	it("does not start a probe for a disposed session", async () => {
		const { controller, store, requests } = fixture(
			() => response([]),
			() => true,
		);
		expect((await controller.probeToolCallingForModel(model)).verdict).toBe("inconclusive");
		expect(requests).toHaveLength(0);
		expect(store.get(modelKey).toolProbe).toBeUndefined();
	});

	it("accounts for a late result without persisting it after disposal", async () => {
		let disposed = false;
		const delayed = createAssistantMessageEventStream();
		const { controller, store, requests, addSpawnedUsage } = fixture(
			() => delayed,
			() => disposed,
		);
		const probe = controller.probeToolCallingForModel(model);
		disposed = true;
		const result = response(matchingContent(requests[0]), "toolUse");
		delayed.push({ type: "done", reason: "toolUse", message: result });
		expect((await probe).verdict).toBe("inconclusive");
		expect(store.get(modelKey).toolProbe).toBeUndefined();
		expect(addSpawnedUsage).toHaveBeenCalledTimes(1);
		expect(requests).toHaveLength(1);
	});

	it.each(
		(["error", "aborted", "length"] as const).flatMap((stopReason) =>
			[1, 3, 4].map((failAt) => ({ stopReason, failAt })),
		),
	)("does not certify partial calls after $stopReason at request $failAt", async ({ stopReason, failAt }) => {
		const { controller, store, requests, addSpawnedUsage } = fixture((context, index) => {
			if (index === failAt) return response(matchingContent(context), stopReason);
			if (index <= 2) return response([{ type: "text", text: "no tools" }]);
			return response(matchingContent(context));
		});
		store.setToolProbe(modelKey, {
			version: 1,
			status: "native",
			nativeGrade: "task",
			probedAt: new Date(0).toISOString(),
		});
		const prior = store.get(modelKey);
		const result = await controller.probeToolCallingForModel(model);
		expect(result.verdict, `failure at request ${failAt}`).toBe("inconclusive");
		expect(store.get(modelKey)).toEqual(prior);
		expect(requests).toHaveLength(failAt);
		expect(addSpawnedUsage).toHaveBeenCalledTimes(failAt);
	});

	it.each([1, 3])("preserves an unprobed model on a thrown transport error at request %s", async (failAt) => {
		const { controller, store, requests } = fixture((_context, index) => {
			if (index === failAt) throw new Error("fixture transport timeout");
			return response([]);
		});
		const result = await controller.probeToolCallingForModel(model);
		expect(result).toMatchObject({ verdict: "inconclusive", diagnostic: "fixture transport timeout" });
		expect(store.get(modelKey).toolProbe).toBeUndefined();
		expect(requests).toHaveLength(failAt);
	});

	it("still persists a negative verdict after all probes complete without a valid call", async () => {
		const { controller, store, requests, addSpawnedUsage } = fixture(() => response([]));
		expect(await controller.probeToolCallingForModel(model)).toMatchObject({ verdict: "none" });
		expect(store.get(modelKey).toolProbe?.status).toBe("none");
		expect(requests).toHaveLength(6);
		expect(addSpawnedUsage).toHaveBeenCalledTimes(6);
	});

	it("still certifies a completed native call", async () => {
		const { controller, store, requests } = fixture((context) => response(matchingContent(context), "toolUse"));
		expect(await controller.probeToolCallingForModel(model)).toMatchObject({
			verdict: "native",
			nativeGrade: "task",
		});
		expect(store.get(modelKey).toolProbe?.status).toBe("native");
		expect(requests).toHaveLength(1);
	});
});
