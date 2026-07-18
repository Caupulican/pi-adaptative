import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";
import { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";
import {
	ToolSelectionController,
	type ToolSelectionControllerDeps,
	type ToolSelectionTool,
} from "../src/core/tool-selection/tool-selection-controller.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): ToolPerformanceStore {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-selection-"));
	dirs.push(dir);
	return ToolPerformanceStore.forAgentDir(dir, {
		fingerprint: () => ({ id: "host", cpu: "cpu", cores: 4, totalMemGb: 16 }),
	});
}

function makeController(
	activeTools: readonly ToolSelectionTool[] = [
		{ name: "read", description: "read a file", pathValidated: true },
		{ name: "grep", description: "search files", pathValidated: true },
	],
	overrides: Partial<ToolSelectionControllerDeps> = {},
): ToolSelectionController {
	return new ToolSelectionController({
		store: overrides.store ?? makeStore(),
		getModelRef: () => "faux/model",
		getActiveTools: () => activeTools,
		...overrides,
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

describe("ToolSelectionController — observe/agreement/promotion loop", () => {
	it("records durable per-intent agreement and, once evidence clears the gate, a hint whose own efficacy is tracked separately", () => {
		const tools: ToolSelectionTool[] = [{ name: "read_file", description: "read a file", pathValidated: true }];
		const controller = makeController(tools);

		expect(controller.getActiveHints()).toEqual([]);

		for (let i = 0; i < 3; i += 1) {
			controller.begin(`call-${i}`, "read_file", {});
			controller.complete(`call-${i}`, true, [{ type: "text", text: "ok" }]);
		}

		// Evidence has now cleared the promotion gate: 3 successes, positive utility, sufficient margin.
		const hints = controller.getActiveHints();
		expect(hints).toHaveLength(1);
		expect(hints[0]).toMatchObject({ intentClass: "read", tool: "read_file" });

		// This 4th call happens WHILE the hint is active — the only call that should land in the
		// hint-efficacy bucket (hintActiveAtCallTime is stamped BEFORE this call is recorded).
		controller.begin("call-3", "read_file", {});
		controller.complete("call-3", true, [{ type: "text", text: "ok" }]);

		const report = controller.getReport();
		const readRow = report.find((row) => row.intentClass === "read");
		expect(readRow).toMatchObject({
			sampleCount: 4,
			agreementRate: 1,
			hintTool: "read_file",
			hintSampleCount: 1,
			hintAgreementRate: 1,
		});
	});

	it("deactivates the hint once accumulated failures erode the promoted tool's margin (evidence-gated both directions)", () => {
		const tools: ToolSelectionTool[] = [
			{ name: "flaky_tool", description: "a somewhat flaky tool", pathValidated: true },
		];
		const controller = makeController(tools);
		for (let i = 0; i < 3; i += 1) {
			controller.begin(`ok-${i}`, "flaky_tool", {});
			controller.complete(`ok-${i}`, true, []);
		}
		expect(controller.getActiveHints()).toHaveLength(1);

		for (let i = 0; i < 40; i += 1) {
			controller.begin(`fail-${i}`, "flaky_tool", {});
			controller.complete(`fail-${i}`, false, []);
		}
		expect(controller.getActiveHints()).toEqual([]);
	});

	it("PI_TOOL_SELECTION_OBSERVE=0 disables recording entirely (kill switch, default on)", () => {
		const store = makeStore();
		const controller = makeController([{ name: "read_file", description: "read a file", pathValidated: true }], {
			store,
			env: { PI_TOOL_SELECTION_OBSERVE: "0" },
		});
		for (let i = 0; i < 5; i += 1) {
			controller.begin(`call-${i}`, "read_file", {});
			controller.complete(`call-${i}`, true, []);
		}
		controller.recordValidation("read_file", "repaired");
		expect(store.get({ modelRef: "faux/model", intentClass: "read", tool: "read_file" }).sampleCount).toBe(0);
		expect(controller.getReport()).toEqual([]);
	});

	it("PI_TOOL_SELECTION_HINTS=0 hides the hint even once evidence clears the gate, without touching recorded evidence", () => {
		const store = makeStore();
		const tools: ToolSelectionTool[] = [{ name: "read_file", description: "read a file", pathValidated: true }];
		const observing = makeController(tools, { store });
		for (let i = 0; i < 3; i += 1) {
			observing.begin(`call-${i}`, "read_file", {});
			observing.complete(`call-${i}`, true, []);
		}
		expect(observing.getActiveHints()).toHaveLength(1);

		const hintsDisabled = makeController(tools, { store, env: { PI_TOOL_SELECTION_HINTS: "0" } });
		expect(hintsDisabled.getActiveHints()).toEqual([]);
		// The underlying evidence is untouched — only the hint SURFACE is hidden.
		expect(store.get({ modelRef: "faux/model", intentClass: "read", tool: "read_file" }).sampleCount).toBe(3);
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
