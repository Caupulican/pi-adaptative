import { writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";
import { ToolSelectionController } from "../src/core/tool-selection/tool-selection-controller.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createHarness } from "./suite/harness.ts";

describe("terminal observations for calls that never execute", () => {
	it.each(["success", "reservation failure", "selector failure", "gate wrapper failure", "cancel before reservation", "cancel after gates"] as const)(
		"retires the pending observation after %s",
		async (mode) => {
			const begins = vi.spyOn(ToolSelectionController.prototype, "begin");
			const reads = vi.fn((path: string) => readFile(path));
			const harness = await createHarness({
				initialActiveToolNames: ["read"],
				tools: [createReadTool(process.cwd(), { operations: { readFile: reads, access } })],
			});
			try {
				if (mode === "selector failure") {
					harness.session.agent.isBackgroundRequested = () => { throw new Error("fixture selector failure"); };
				}
				const originalStart = harness.session.agent.onToolCallStart;
				harness.session.agent.onToolCallStart = async (...args) => {
					if (mode === "reservation failure") throw new Error("fixture reservation failure");
					if (mode === "cancel before reservation")
						harness.session.agent.abort("fixture reservation cancellation");
					return originalStart?.(...args);
				};
				const originalGate = harness.session.agent.beforeToolCall!;
				harness.session.agent.beforeToolCall = async (...args) => {
					const result = await originalGate(...args);
					if (mode === "gate wrapper failure") throw new Error("fixture failure after observation began");
					if (mode === "cancel after gates") harness.session.agent.abort("fixture post-gate cancellation");
					return result;
				};
				const path = join(harness.tempDir, "fixture.txt");
				writeFileSync(path, "fixture");
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				]);
				await harness.session.prompt("Read the fixture.");
				expect(begins).toHaveBeenCalledOnce();
				expect(reads.mock.calls.map(([path]) => path)).toEqual(mode === "success" ? [path] : []);
				const [callId] = begins.mock.calls[0];
				const controller = begins.mock.contexts[0];
				if (!(controller instanceof ToolSelectionController)) throw new Error("missing observation controller");
				// A terminal, unexecuted call must not remain eligible for a stale completion.
				controller.complete(callId, true, [{ type: "text", text: "stale completion" }]);
				await harness.session.disposeAndWait();
				const reader = ToolPerformanceStore.forAgentDir(harness.tempDir, { readOnly: true });
				try {
					const modelRef = `${harness.getModel().provider}/${harness.getModel().id}`;
					expect(reader.get({ modelRef, intentClass: "read", tool: "read" }).sampleCount).toBe(
						mode === "success" ? 1 : 0,
					);
					expect(reader.getObservations(modelRef)).toHaveLength(mode === "success" ? 1 : 0);
				} finally {
					reader.close();
				}
			} finally {
				begins.mockRestore();
				await harness.cleanup();
			}
		},
	);
});
