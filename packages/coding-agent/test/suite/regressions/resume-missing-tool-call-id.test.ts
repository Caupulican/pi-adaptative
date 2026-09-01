import { SessionManager } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { ForegroundLifecycleController } from "../../../src/core/foreground-lifecycle-controller.ts";
import type { ModelRouterController } from "../../../src/core/model-router-controller.ts";

function createController(sessionManager: SessionManager, warnings: string[]): ForegroundLifecycleController {
	return new ForegroundLifecycleController({
		agent: { state: { messages: [] }, resetSanitizerPrefixHorizon: () => {} },
		sessionManager,
		modelRouter: { commitSessionBufferPrefix: () => new Map() } as ModelRouterController,
		emitWarning: (warning) => warnings.push(warning),
	});
}

describe("Regression: resume requestId-dissociated tool start", () => {
	it("repairs a start whose assistant toolCall has no request snapshot", () => {
		const sessionManager = SessionManager.inMemory();
		const assistantEntryId = sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello" }, { id: "call_123" })], {
				stopReason: "toolUse",
			}),
		);
		sessionManager.appendForegroundToolStart("r1", assistantEntryId, "call_123", "bash");
		const warnings: string[] = [];
		createController(sessionManager, warnings).repair();

		const results = sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		const terminals = sessionManager.getBranch().filter((entry) => entry.type === "foreground_tool_terminal");
		expect(results).toHaveLength(1);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({
			requestId: "r1",
			assistantMessageEntryId: assistantEntryId,
			callId: "call_123",
		});
		expect(warnings.some((warning) => warning.includes("missing assistant call"))).toBe(false);

		createController(sessionManager, warnings).repair();
		expect(sessionManager.getBranch().filter((entry) => entry.type === "foreground_tool_terminal")).toHaveLength(1);
	});
});
