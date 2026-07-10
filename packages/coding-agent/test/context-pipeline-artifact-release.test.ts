import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextGcReport } from "../src/core/context-gc.ts";
import { ContextPipeline, type ContextPipelineDeps } from "../src/core/context-pipeline.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createPipeline(): ContextPipeline {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-pipeline-artifact-"));
	tempDirs.push(agentDir);
	return new ContextPipeline({
		getTurnIndex: () => 1,
		getSessionManager: () =>
			({ getSessionId: () => "session", getBranch: () => [], getEntries: () => [] }) as unknown as ReturnType<
				ContextPipelineDeps["getSessionManager"]
			>,
		getSettingsManager: () => ({}) as ReturnType<ContextPipelineDeps["getSettingsManager"]>,
		getModelRegistry: () => ({}) as ReturnType<ContextPipelineDeps["getModelRegistry"]>,
		getModel: () => undefined,
		getAgentDir: () => agentDir,
		getCwd: () => agentDir,
		getActiveToolNames: () => [],
		isDisposed: () => false,
		getMemoryManager: () => ({}) as ReturnType<ContextPipelineDeps["getMemoryManager"]>,
		addSpawnedUsage: () => undefined,
		runIsolatedCompletion: async () => {
			throw new Error("not used by artifact release coverage");
		},
	});
}

describe("ContextPipeline packed artifact release", () => {
	it("releases and cleans a run_toolkit_script artifact when context GC packs its tool result", () => {
		const pipeline = createPipeline();
		const store = pipeline.getToolArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: "exact toolkit output",
			toolName: "run_toolkit_script",
			createdAtTurn: 1,
			reproducible: false,
		});
		expect(store.addReference(ref.id, "tool-call-1")).toBe(true);

		const messages: AgentMessage[] = [
			{
				role: "toolResult",
				toolCallId: "tool-call-1",
				toolName: "run_toolkit_script",
				content: [{ type: "text", text: "bounded preview" }],
				details: { artifactId: ref.id },
				isError: false,
				timestamp: 0,
			},
		];
		const report: ContextGcReport = {
			enabled: true,
			packedCount: 1,
			originalTokens: 100,
			packedTokens: 10,
			savedTokens: 90,
			records: [
				{
					toolName: "run_toolkit_script",
					toolCallId: "tool-call-1",
					messageIndex: 0,
					reason: "stale-tool-result",
					originalChars: 100,
					originalTokens: 100,
					packedTokens: 10,
				},
			],
		};
		const internals = pipeline as unknown as {
			_releaseGcPackedArtifactReferences(messages: AgentMessage[], report: ContextGcReport): void;
		};

		internals._releaseGcPackedArtifactReferences(messages, report);

		expect(store.referenceCount(ref.id)).toBe(0);
		expect(store.has(ref.id)).toBe(false);
	});
});
