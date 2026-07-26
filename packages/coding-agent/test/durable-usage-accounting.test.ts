import { join } from "node:path";
import type { AgentMessage, AgentState } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage, ToolResultMessage, Usage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { SPAWNED_USAGE_CUSTOM_TYPE } from "../src/core/agent-session-contracts.ts";
import { aggregateCurrentSessionCostsFromEntries } from "../src/core/cost/cost-summary.ts";
import { aggregateDailyUsageFromEntries } from "../src/core/cost/daily-usage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { Extension, ExtensionRuntime, ToolDefinition } from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionAnalytics } from "../src/core/session-analytics.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";

function usage(value: number): Usage {
	return {
		input: value,
		output: value,
		cacheRead: value,
		cacheWrite: value,
		totalTokens: value * 4,
		cost: {
			input: value / 4,
			output: value / 4,
			cacheRead: value / 4,
			cacheWrite: value / 4,
			total: value,
		},
	};
}

describe("session usage ownership", () => {
	it("lets extension tool-result hooks observe and replace model-backed usage", async () => {
		const original = usage(2);
		const replacement = usage(7);
		let observed: Usage | undefined;
		const extension = {
			path: "usage-extension.ts",
			resolvedPath: "usage-extension.ts",
			sourceInfo: { source: "path", path: "usage-extension.ts" },
			handlers: new Map([
				[
					"tool_result",
					[
						(event: unknown) => {
							observed = (event as { usage?: Usage }).usage;
							return { usage: replacement };
						},
					],
				],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
			eventUnsubscribes: [],
			disposers: [],
		} as unknown as Extension;
		const session = SessionManager.inMemory("/tmp/pi-extension-usage");
		const runner = new ExtensionRunner(
			[extension],
			{} as ExtensionRuntime,
			session.getCwd(),
			session,
			{} as ModelRegistry,
		);
		const controller = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => session.getCwd(),
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => {},
			getExtensionRunner: () => runner,
		});
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "messages",
			provider: "anthropic",
			model: "usage-model",
			usage: usage(0),
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const result = await controller.afterToolCall({
			assistantMessage,
			toolCall: { type: "toolCall", id: "tool-1", name: "model_tool", arguments: {} },
			args: {},
			result: { content: [{ type: "text", text: "done" }], details: undefined, usage: original },
			isError: false,
			context: { systemPrompt: "", messages: [], tools: [] },
		});

		expect(observed).toEqual(original);
		expect(result?.usage).toEqual(replacement);
	});

	it("counts durable assistant, tool, and summary usage exactly once after compaction", () => {
		const session = SessionManager.inMemory("/tmp/pi-durable-usage");
		const userId = session.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "working" }],
			api: "messages",
			provider: "anthropic",
			model: "usage-model",
			usage: usage(1),
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "model_tool",
			content: [{ type: "text", text: "result" }],
			usage: usage(2),
			isError: false,
			timestamp: Date.now(),
		};
		session.appendMessage(toolResult);
		const compactionId = session.appendCompaction("checkpoint", userId, 1000, undefined, false, usage(3));
		session.branchWithSummary(compactionId, "branch", undefined, false, usage(4));
		session.appendCustomEntry(SPAWNED_USAGE_CUSTOM_TYPE, { usage: usage(5), reportId: "child-1" });

		const entries = session.getEntries();
		const settings = SettingsManager.inMemory();
		const analytics = new SessionAnalytics({
			getState: () => ({ messages: session.buildSessionContext().messages }) as AgentState,
			getMessages: () => session.buildSessionContext().messages as AgentMessage[],
			getModel: () => undefined,
			getSessionManager: () => session,
			getSettingsManager: () => settings,
			getToolDefinition: (_name: string): ToolDefinition | undefined => undefined,
			getToolRecoveryEventLogPath: () => join(session.getCwd(), "missing-tool-recovery.jsonl"),
		});

		const stats = analytics.getSessionStats();
		expect(stats.cost).toBe(10);
		expect(stats.tokens.total).toBe(40);
		expect(stats.totalMessages).toBe(3);
		expect(stats.userMessages).toBe(1);
		expect(stats.assistantMessages).toBe(1);
		expect(stats.toolResults).toBe(1);

		const cumulative = analytics.getCumulativeUsage();
		expect(cumulative.cost.total).toBe(15);
		expect(cumulative.totalTokens).toBe(60);

		const current = aggregateCurrentSessionCostsFromEntries(entries);
		expect(current).toMatchObject({ ownCost: 10, subagentCost: 5, currentCost: 15, subagentReports: 1 });

		const daily = aggregateDailyUsageFromEntries(entries, {
			startMs: Date.now() - 60_000,
			endMs: Date.now() + 60_000,
		});
		expect(daily).toMatchObject({ ownCost: 10, spawnedCost: 5, totalCost: 15, totalTokens: 60, reports: 1 });
	});
});
