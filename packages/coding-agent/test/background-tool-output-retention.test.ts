import type { AgentRequestId, BackgroundToolCallCompletion, BackgroundToolCallContext } from "@caupulican/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundToolTaskController, type BackgroundToolTaskRecord } from "../src/core/background-tool-task-controller.ts";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";

const requestId = "retention-request" as AgentRequestId;
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function controlledCall(negative = false) {
	const completion = Promise.withResolvers<BackgroundToolCallCompletion>();
	const toolCall = { type: "toolCall" as const, id: "retention-call", name: "fixture", arguments: {} };
	const context: BackgroundToolCallContext = {
		requestId, toolCall, args: {}, context: { systemPrompt: "", messages: [], tools: [] },
		assistantMessage: { role: "assistant", content: [toolCall], api: "openai-responses", provider: "fixture", model: "fixture", usage, stopReason: "toolUse", timestamp: 0 },
		trigger: "manual", elapsedMs: 0, completion: completion.promise, cancel: vi.fn(),
	};
	const finished: BackgroundToolCallCompletion = {
		toolCall, isError: negative,
		result: {
			content: [{ type: "text", text: Array.from({ length: 5000 }, (_, index) => `result line ${index}`).join("\n") }], usage,
			details: {
				piToolInvocation: { version: 1, requestId, execution: "completed", operationStatus: negative ? "error" : "success", postprocessingFailures: ["cleanup"] },
				piVerification: { version: 1, id: "retention-verification", status: negative ? "failed" : "passed", outcome: "executed", evidence: "tests" },
			},
		},
	};
	return { context, completion, finished };
}

describe("background output retention failures", () => {
	afterEach(() => vi.useRealTimers());
	it.each(["lookup", "write", "reference", "control"].flatMap((fault) =>
		["success", "negative", "canceled"].map((operation) => ({ fault, operation })),
	))("publishes the operation terminal and partial-output disclosure: $fault / $operation", async ({ fault, operation }) => {
		vi.useFakeTimers();
		const persisted: BackgroundToolTaskRecord[] = [];
		const notifications: BackgroundToolTaskRecord[] = [];
		const store = createInMemoryArtifactStore();
		const write = vi.spyOn(store, "write");
		const reference = vi.spyOn(store, "addReference");
		if (fault === "write") write.mockImplementation(() => { throw new Error("private write failure"); });
		if (fault === "reference") reference.mockImplementation(() => { throw undefined; });
		const lookup = vi.fn(() => { if (fault === "lookup") throw new Error("private lookup failure"); return store; });
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "fixture-session", getArtifactStore: lookup,
			persist: (record) => { persisted.push(JSON.parse(JSON.stringify(record))); },
			notifyTerminal: (records) => { notifications.push(...records); },
		});
		const call = controlledCall(operation === "negative");
		expect(controller.handoff(call.context)).toBeDefined();
		let settled = false;
		const waiting = controller.wait("tool-task-1").then((record) => { settled = true; return record; });
		if (operation === "canceled") expect(controller.cancel("tool-task-1")).toBe(true);
		call.completion.resolve(call.finished);
		await controller.waitForNotifications();
		expect(settled).toBe(true);
		const result = await waiting;
		expect(result.status).toBe(operation === "success" ? "completed" : operation === "negative" ? "failed" : "canceled");
		expect(result.usage).toEqual(usage);
		expect(result.piToolInvocation).toMatchObject({ operationStatus: operation === "negative" ? "error" : "success", postprocessingFailures: ["cleanup"] });
		expect(result.output).toContain("result line 0");
		expect(result.output).toContain("result line 4999");
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32 * 1024 + 256);
		expect(result.output).not.toContain("private");
		if (fault !== "control") {
			expect(result.output).toContain("Full output unavailable");
			expect(result.artifactId).toBeUndefined();
		} else {
			expect(result.artifactId).toEqual(expect.any(String));
			expect(result.output).not.toContain("Full output unavailable");
		}
		expect(notifications).toHaveLength(1);
		expect(notifications[0].output).toBe(result.output);
		expect(lookup).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledTimes(fault === "lookup" ? 0 : 1);
		expect(reference).toHaveBeenCalledTimes(fault === "lookup" || fault === "write" ? 0 : 1);
		const restored = new BackgroundToolTaskController({
			getSessionId: () => "fixture-session", getArtifactStore: () => store,
			loadPersistedRecordsNewestFirst: () => [...persisted].reverse(), persist: () => {}, notifyTerminal: () => {},
		});
		expect(restored.list()[0]).toMatchObject({ status: result.status, output: result.output, piToolInvocation: result.piToolInvocation });
		await restored.shutdown();
		await controller.shutdown();
	});

	it("still refuses successful delivery when the terminal record cannot be persisted", async () => {
		const notifications: BackgroundToolTaskRecord[] = [];
		let writes = 0;
		const controller = new BackgroundToolTaskController({
			getSessionId: () => "fixture-session", getArtifactStore: () => { throw new Error("storage unavailable"); },
			persist: () => { if (++writes > 1) throw new Error("terminal write failed"); },
			notifyTerminal: (records) => { notifications.push(...records); },
		});
		const call = controlledCall();
		expect(controller.handoff(call.context)).toBeDefined();
		call.completion.resolve(call.finished);
		await controller.waitForNotifications();
		expect(notifications).toEqual([expect.objectContaining({ status: "failed", output: expect.stringContaining("could not be persisted") })]);
		expect(notifications[0].piVerification).toBeUndefined();
		expect(notifications[0].piToolInvocation).toMatchObject({ execution: "completed", operationStatus: "success" });
		await controller.shutdown();
	});
});
