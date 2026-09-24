import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import { ContextPipeline, type ContextPipelineDeps, type ContextPolicyLane } from "../src/core/context-pipeline.ts";

/**
 * A worker conversation runs the context policy (audit, shadow plan, enforcement) on its own lane: its
 * own audit memo and tool facts, and reports that never replace the root's inspection state.
 */
const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function toolResult(toolCallId: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: `output of ${toolCallId}` }],
		isError: false,
		timestamp: 0,
	};
}

function createPipeline(): ContextPipeline {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-policy-lane-"));
	tempDirs.push(agentDir);
	const sessionManager = { getLeafId: () => undefined, getBranch: () => [] } as unknown as SessionManager;
	return new ContextPipeline({
		getTurnIndex: () => 1,
		getSessionManager: () => sessionManager,
		getSettingsManager: () =>
			({
				getContextPromptEnforcementSettings: () => ({ enabled: true, preserveRecentMessages: 1, minChars: 1 }),
				getContextCurationSettings: () => ({ enabled: false, maxJobsPerTurn: 0 }),
			}) as unknown as ReturnType<ContextPipelineDeps["getSettingsManager"]>,
		getModelRegistry: () => ({}) as ReturnType<ContextPipelineDeps["getModelRegistry"]>,
		getModel: () => undefined,
		getAgentDir: () => agentDir,
		getCwd: () => agentDir,
		getActiveToolNames: () => [],
		isDisposed: () => false,
		getMemoryManager: () => ({}) as ReturnType<ContextPipelineDeps["getMemoryManager"]>,
		addSpawnedUsage: () => undefined,
		runIsolatedCompletion: async () => {
			throw new Error("not used");
		},
	});
}

describe("context policy lane", () => {
	it("audits a worker conversation on its own memo without replacing the root's reports", () => {
		const pipeline = createPipeline();
		const rootMessages = [toolResult("root-1")];
		const rootAudit = pipeline.runContextAudit(rootMessages);
		const rootPlan = pipeline.runPromptPolicyPlanning(rootAudit);
		expect(rootAudit.items).toHaveLength(1);

		const lane: ContextPolicyLane = { memo: new Map(), memoMessages: [], toolNames: ["artifact_retrieve"] };
		const workerMessages = [toolResult("worker-1"), toolResult("worker-2")];
		const workerAudit = pipeline.runContextAudit(workerMessages, lane);
		const workerPlan = pipeline.runPromptPolicyPlanning(workerAudit, lane);
		pipeline.runPromptEnforcement(workerMessages, workerPlan, lane);

		expect(workerAudit.items).toHaveLength(2);
		// The lane's memo holds the worker's messages; the root's inspection state is still the root's.
		expect(lane.memoMessages).toEqual(workerMessages);
		expect(lane.memo.size).toBe(2);
		expect(pipeline.getContextAuditReport()).toBe(rootAudit);
		expect(pipeline.getPromptPolicyReport()).toBe(rootPlan);
	});
});
