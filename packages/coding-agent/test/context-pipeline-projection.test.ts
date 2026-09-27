import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { ContextPipeline, type ContextPipelineDeps, type ContextPolicyLane } from "../src/core/context-pipeline.ts";

function toolResult(toolCallId: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: toolCallId }],
		isError: false,
		timestamp,
	};
}

function createPipeline(branch: SessionEntry[]): ContextPipeline {
	const sessionManager = {
		getBranch: () => branch,
	} as unknown as SessionManager;
	return new ContextPipeline({
		getTurnIndex: () => 7,
		getSessionManager: () => sessionManager,
		getSettingsManager: () => ({}) as ReturnType<ContextPipelineDeps["getSettingsManager"]>,
		getModelRegistry: () => ({}) as ReturnType<ContextPipelineDeps["getModelRegistry"]>,
		getModel: () => undefined,
		getAgentDir: () => "/tmp",
		getCwd: () => "/tmp",
		getActiveToolNames: () => [],
		isDisposed: () => false,
		getMemoryManager: () => ({}) as ReturnType<ContextPipelineDeps["getMemoryManager"]>,
		addSpawnedUsage: () => undefined,
		runIsolatedCompletion: async () => {
			throw new Error("not used");
		},
	});
}

describe("ContextPipeline provider projection", () => {
	it("publishes accepted root state with transcript provenance and isolates worker lanes", () => {
		const rootTool = toolResult("root-call", 10);
		const pipeline = createPipeline([
			{
				type: "message",
				id: "entry-root-call",
				parentId: null,
				timestamp: new Date(10).toISOString(),
				message: rootTool,
			},
		]);
		const rootPreview = pipeline.previewContextProjection([rootTool]);

		expect(pipeline.getContextProjection().entries).toEqual([]);
		expect(rootPreview.entries[0]?.provenance).toEqual({
			kind: "session_entry",
			sourceId: "entry-root-call",
		});
		pipeline.commitContextProjection(rootPreview);
		expect(pipeline.getContextProjection()).toBe(rootPreview);

		const workerLane: ContextPolicyLane = { memo: new Map(), memoMessages: [], toolNames: [] };
		const workerPreview = pipeline.previewContextProjection([toolResult("worker-call", 20)], workerLane);
		expect(workerPreview.entries[0]?.provenance.kind).toBe("request_derived");
		pipeline.commitContextProjection(workerPreview, workerLane);

		expect(pipeline.getContextProjection()).toBe(rootPreview);
	});
});
