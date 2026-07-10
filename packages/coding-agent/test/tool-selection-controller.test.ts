import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";
import { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";
import {
	ToolSelectionController,
	type ToolSelectionTool,
} from "../src/core/tool-selection/tool-selection-controller.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeController(
	activeTools: readonly ToolSelectionTool[] = [
		{ name: "read", description: "read a file", pathValidated: true },
		{ name: "grep", description: "search files", pathValidated: true },
	],
): ToolSelectionController {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-selection-"));
	dirs.push(dir);
	return new ToolSelectionController({
		store: ToolPerformanceStore.forAgentDir(dir, {
			fingerprint: () => ({ id: "host", cpu: "cpu", cores: 4, totalMemGb: 16 }),
		}),
		getModelRef: () => "faux/model",
		getActiveTools: () => activeTools,
	});
}

describe("ToolSelectionController", () => {
	it("builds an intent-scoped observation and records successful/failing outcomes", () => {
		const controller = makeController();
		const pending = controller.begin("call-1", "read", { path: "/tmp/example.txt" });
		expect(pending.selection.ranked.some((candidate) => candidate.tool === "no_tool")).toBe(true);
		expect(pending.selection.ranked.some((candidate) => candidate.tool === "read")).toBe(true);
		controller.complete("call-1", true, [{ type: "text", text: "ok" }]);
		controller.recordValidation("read", "repaired");
		controller.recordValidation("read", "bounced");
		const next = controller.begin("call-2", "read", { path: "/tmp/other.txt" });
		controller.complete("call-2", false, [{ type: "text", text: "failed" }]);

		const store = (controller as unknown as { deps: { store: ToolPerformanceStore } }).deps.store;
		const stats = store.get({ modelRef: "faux/model", intentClass: "read", tool: "read" });
		expect(stats.sampleCount).toBe(2);
		expect(stats.repairCount).toBe(1);
		expect(stats.bounceCount).toBe(1);
		expect(stats.failureCount).toBe(1);
		expect(next.firstTool).toBe(false);
	});

	it("does not make an unresolved path candidate a deterministic recommendation", () => {
		const controller = makeController([
			{ name: "read", description: "read a file", pathValidated: false },
			{ name: "grep", description: "search files", pathValidated: true },
		]);
		const pending = controller.begin("call-1", "read", { path: "../outside" });
		expect(pending.selection.recommendation).not.toBe("read");
	});
});

describe("ToolGateController selector integration", () => {
	it("observes only calls that survive router, autonomy, and extension gates", async () => {
		const started: string[] = [];
		const completed: Array<{ id: string; success: boolean }> = [];
		const extensionRunner = {
			hasHandlers: () => false,
		} as unknown as ExtensionRunner;
		const gate = new ToolGateController({
			maybeEscalateToolCall: (toolName) => (toolName === "blocked" ? { block: true, reason: "router" } : undefined),
			getCwd: () => process.cwd(),
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => undefined,
			getExtensionRunner: () => extensionRunner,
			getToolSelectionController: () =>
				({
					begin: (id: string) => started.push(id),
					complete: (id: string, success: boolean) => completed.push({ id, success }),
				}) as unknown as ToolSelectionController,
		});
		const runBefore = (input: { toolCall: { id: string; name: string }; args: unknown }) =>
			gate.beforeToolCall(input as never);
		const runAfter = (input: {
			toolCall: { id: string; name: string };
			args: unknown;
			result: { content: unknown[]; details?: unknown };
			isError: boolean;
		}) => gate.afterToolCall(input as never);

		expect(await runBefore({ toolCall: { id: "allowed", name: "read" }, args: {} })).toBeUndefined();
		expect(await runBefore({ toolCall: { id: "blocked", name: "blocked" }, args: {} })).toMatchObject({
			block: true,
		});
		await runAfter({
			toolCall: { id: "allowed", name: "read" },
			args: {},
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(started).toEqual(["allowed"]);
		expect(completed).toEqual([{ id: "allowed", success: true }]);
	});
});
