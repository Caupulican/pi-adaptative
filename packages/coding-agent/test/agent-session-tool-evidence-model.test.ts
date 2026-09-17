import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";
import { createHarness } from "./suite/harness.ts";

describe("request model ownership of tool evidence", () => {
	it.each([{}, { provider: "faux" }, { model: "producer" }])(
		"does not invent the current model for incomplete validation identity %j",
		(identity) =>
			createHarness().then(async (harness) => {
				harness.session.agent.onToolArgumentValidation?.({
					...identity,
					outcome: "bounced",
					tool: "read",
					failureModes: [],
					repairsApplied: [],
					taught: "none",
					executionOutcome: "not_run",
				});
				await harness.session.disposeAndWait();
				const reader = ToolPerformanceStore.forAgentDir(harness.tempDir, { readOnly: true });
				try {
					expect(reader.get({ modelRef: "unknown", intentClass: "read", tool: "read" }).bounceCount).toBe(1);
					expect(
						reader.get({
							modelRef: `${harness.getModel().provider}/${harness.getModel().id}`,
							intentClass: "read",
							tool: "read",
						}).bounceCount,
					).toBe(0);
				} finally {
					reader.close();
					await harness.cleanup();
				}
			}),
	);

	it.each(["none", "response", "tool hook"] as const)(
		"records execution and repair on the producing model (switch=%s)",
		async (switchAt) => {
			let switchFromHook: (() => Promise<void>) | undefined;
			const harness = await createHarness({
				models: [{ id: "producer" }, { id: "next" }],
				initialActiveToolNames: ["read"],
				extensionFactories: [
					(pi) => {
						pi.on("tool_call", async () => {
							await switchFromHook?.();
						});
					},
				],
			});
			const original = harness.getModel();
			const next = harness.getModel("next")!;
			if (switchAt === "tool hook")
				switchFromHook = () => harness.session.setModel(next, { persistSettings: false });
			const path = join(harness.tempDir, "fixture.txt");
			writeFileSync(path, "fixture\nsecond line");
			harness.setResponses([
				async () => {
					if (switchAt === "response") await harness.session.setModel(next, { persistSettings: false });
					return fauxAssistantMessage(fauxToolCall("read", { path, limit: "1" }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("Read complete."),
			]);
			await harness.session.prompt("Read the first line.");
			await harness.session.disposeAndWait();
			const reader = ToolPerformanceStore.forAgentDir(harness.tempDir, { readOnly: true });
			try {
				expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
				expect(harness.eventsOfType("tool_execution_end")[0].isError).toBe(false);
				expect(
					reader.get({ modelRef: `${original.provider}/${original.id}`, intentClass: "read", tool: "read" }),
				).toMatchObject({
					sampleCount: 1,
					repairCount: 1,
				});
				expect(
					reader.get({ modelRef: `${next.provider}/${next.id}`, intentClass: "read", tool: "read" }),
				).toMatchObject({
					sampleCount: 0,
					repairCount: 0,
				});
			} finally {
				reader.close();
				await harness.cleanup();
			}
		},
	);

	it.each([false, true])(
		"attributes validation rejection without executing a tool (switch=%s)",
		async (switchModel) => {
			const harness = await createHarness({
				models: [{ id: "producer" }, { id: "next" }],
				initialActiveToolNames: ["read"],
			});
			const original = harness.getModel();
			const next = harness.getModel("next")!;
			const execute = vi.spyOn(harness.session.agent.state.tools.find((tool) => tool.name === "read")!, "execute");
			harness.setResponses([
				async () => {
					if (switchModel) await harness.session.setModel(next, { persistSettings: false });
					return fauxAssistantMessage(fauxToolCall("read", { path: null }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("Cannot read without a path."),
			]);
			await harness.session.prompt("Read the fixture.");
			await harness.session.disposeAndWait();
			const reader = ToolPerformanceStore.forAgentDir(harness.tempDir, { readOnly: true });
			try {
				expect(execute).not.toHaveBeenCalled();
				expect(harness.eventsOfType("tool_execution_end")[0].isError).toBe(true);
				expect(
					reader.get({ modelRef: `${original.provider}/${original.id}`, intentClass: "read", tool: "read" }),
				).toMatchObject({ sampleCount: 0, bounceCount: 1 });
				expect(
					reader.get({ modelRef: `${next.provider}/${next.id}`, intentClass: "read", tool: "read" }),
				).toMatchObject({ sampleCount: 0, bounceCount: 0 });
			} finally {
				reader.close();
				await harness.cleanup();
			}
		},
	);
});
