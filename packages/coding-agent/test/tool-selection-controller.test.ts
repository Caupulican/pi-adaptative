import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import type { ToolCallEvent } from "../src/core/extensions/types.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";
import { formatToolSelectionHints } from "../src/core/tool-selection/promotion.ts";
import { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";
import {
	recoveryToolsForFailedTool,
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
	it("does not discard a replacement observation through an old cleanup handle", () => {
		const store = makeStore();
		const controller = makeController(undefined, { store });
		const old = controller.begin("reused", "read", {}, { modelRef: "faux/old" });
		controller.begin("reused", "read", {}, { modelRef: "faux/new" });
		controller.discard("reused", old);
		controller.complete("reused", true);
		expect(store.get({ modelRef: "faux/old", intentClass: "read", tool: "read" }).sampleCount).toBe(0);
		expect(store.get({ modelRef: "faux/new", intentClass: "read", tool: "read" }).sampleCount).toBe(1);
	});

	it("pauses failed advisory writes without failing tools and recovers at a turn boundary", () => {
		const store = makeStore();
		const controller = makeController(undefined, { store });
		const record = vi.spyOn(store, "recordExecution").mockImplementationOnce(() => {
			throw new Error("fixture storage failure");
		});
		const validation = vi.spyOn(store, "recordValidation");
		const flush = vi.spyOn(store, "flush").mockImplementationOnce(() => {
			throw new Error("fixture storage still unavailable");
		});
		controller.begin("first", "read", {}, { modelRef: "faux/model" });
		expect(() => controller.complete("first", true)).not.toThrow();
		expect(controller.formatTimingReport()).toContain("observations paused");
		controller.begin("paused", "read", {}, { modelRef: "faux/model" });
		controller.complete("paused", true);
		controller.recordValidation("read", "repaired", "faux/model");
		expect(record).toHaveBeenCalledTimes(1);
		expect(validation).not.toHaveBeenCalled();
		controller.startTurn();
		expect(flush).toHaveBeenCalledTimes(1);
		expect(controller.formatTimingReport()).toContain("observations paused");
		controller.startTurn();
		expect(flush).toHaveBeenCalledTimes(2);
		controller.begin("recovered", "read", {}, { modelRef: "faux/model" });
		controller.complete("recovered", true);
		expect(record).toHaveBeenCalledTimes(2);
		expect(controller.formatTimingReport()).not.toContain("observations paused");
		expect(store.get({ modelRef: "faux/model", intentClass: "read", tool: "read" }).sampleCount).toBe(1);
	});

	it("isolates validation-statistic failures from argument repair", () => {
		const store = makeStore();
		const controller = makeController(undefined, { store });
		vi.spyOn(store, "recordValidation").mockImplementationOnce(() => {
			throw new Error("fixture validation-statistic failure");
		});
		expect(() => controller.recordValidation("read", "repaired", "faux/model")).not.toThrow();
		expect(controller.formatTimingReport()).toContain("observations paused");
	});

	it("loads one intent snapshot instead of rereading durable state per candidate", () => {
		const store = makeStore();
		const get = vi.spyOn(store, "get");
		const getStatsForIntent = vi.spyOn(store, "getStatsForIntent");
		const controller = makeController(
			Array.from({ length: 12 }, (_, index) => ({
				name: index === 0 ? "read" : `read_${index}`,
				description: "read a file",
				pathValidated: true,
			})),
			{ store },
		);

		controller.begin("call-1", "read", {}, { modelRef: "faux/model" });

		expect(get).not.toHaveBeenCalled();
		expect(getStatsForIntent).toHaveBeenCalledTimes(1);
	});

	it("builds an intent-scoped observation and records successful/failing outcomes", () => {
		const controller = makeController();
		const pending = controller.begin("call-1", "read", { path: "/tmp/example.txt" }, { modelRef: "faux/model" });
		expect(pending.selection.ranked.some((candidate) => candidate.tool === "no_tool")).toBe(true);
		expect(pending.selection.ranked.some((candidate) => candidate.tool === "read")).toBe(true);
		controller.complete("call-1", true, [{ type: "text", text: "ok" }]);
		controller.recordValidation("read", "repaired", "faux/model");
		controller.recordValidation("read", "bounced", "faux/model");
		const next = controller.begin("call-2", "read", { path: "/tmp/other.txt" }, { modelRef: "faux/model" });
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
		const pending = controller.begin("call-1", "read", { path: "../outside" }, { modelRef: "faux/model" });
		expect(pending.selection.recommendation).not.toBe("read");
	});
});

describe("ToolSelectionController — observe/agreement/promotion loop", () => {
	it.each(["removed", "profile", "capability", "policy"] as const)(
		"withdraws learned hints when the tool is %s and restores them when available",
		(reason) => {
			let tools: ToolSelectionTool[] = [{ name: "read_file", description: "read a file" }];
			let policyAllowed = true;
			const controller = makeController(undefined, {
				getActiveTools: () => tools,
				isCandidateAllowed: () => policyAllowed,
			});
			for (let i = 0; i < 3; i++) {
				controller.begin(`learn-${i}`, "read_file", {}, { modelRef: "faux/model" });
				controller.complete(`learn-${i}`, true, []);
			}
			expect(controller.getActiveHints().map((hint) => hint.tool)).toEqual(["read_file"]);
			if (reason === "removed") tools = [];
			if (reason === "profile") tools[0].profileAllowed = false;
			if (reason === "capability") tools[0].capabilityAllowed = false;
			if (reason === "policy") policyAllowed = false;
			expect(controller.getActiveHints()).toEqual([]);
			tools = [{ name: "read_file", description: "read a file" }];
			policyAllowed = true;
			expect(controller.getActiveHints().map((hint) => hint.tool)).toEqual(["read_file"]);
		},
	);

	it("does not attribute calls to a hint while the hint surface is disabled", () => {
		const env = { PI_TOOL_SELECTION_HINTS: "1" };
		const controller = makeController([{ name: "read_file", description: "read a file" }], { env });
		for (let i = 0; i < 3; i++) {
			controller.begin(`learn-${i}`, "read_file", {}, { modelRef: "faux/model" });
			controller.complete(`learn-${i}`, true, []);
		}
		expect(controller.getActiveHints()).toHaveLength(1);
		env.PI_TOOL_SELECTION_HINTS = "0";
		controller.begin("without-hint", "read_file", {}, { modelRef: "faux/model" });
		controller.complete("without-hint", true, []);
		expect(controller.getReport()[0].hintSampleCount).toBe(0);
		env.PI_TOOL_SELECTION_HINTS = "1";
		controller.observeProviderRequest(
			"hint-request",
			"faux/model",
			formatToolSelectionHints(controller.getActiveHints())!,
		);
		controller.begin("with-hint", "read_file", {}, { modelRef: "faux/model", requestId: "hint-request" });
		controller.complete("with-hint", true, []);
		expect(controller.getReport()[0].hintSampleCount).toBe(1);
	});

	it("loads one model snapshot when evaluating every intent hint", () => {
		const getStatsForModel = vi.fn(() => []);
		const getStatsForIntent = vi.fn(() => []);
		const controller = makeController(undefined, {
			store: { getStatsForModel, getStatsForIntent } as unknown as ToolPerformanceStore,
		});

		expect(controller.getActiveHints()).toEqual([]);
		expect(getStatsForModel).toHaveBeenCalledTimes(1);
		expect(getStatsForIntent).not.toHaveBeenCalled();
	});

	it("records durable per-intent agreement and, once evidence clears the gate, a hint whose own efficacy is tracked separately", () => {
		const tools: ToolSelectionTool[] = [{ name: "read_file", description: "read a file", pathValidated: true }];
		const controller = makeController(tools);

		expect(controller.getActiveHints()).toEqual([]);

		for (let i = 0; i < 3; i += 1) {
			controller.begin(`call-${i}`, "read_file", {}, { modelRef: "faux/model" });
			controller.complete(`call-${i}`, true, [{ type: "text", text: "ok" }]);
		}

		// Evidence has now cleared the promotion gate: 3 successes, positive utility, sufficient margin.
		const hints = controller.getActiveHints();
		expect(hints).toHaveLength(1);
		expect(hints[0]).toMatchObject({ intentClass: "read", tool: "read_file" });

		// Eligibility alone is not delivery: this request actually includes the promoted hint.
		controller.observeProviderRequest("hint-request", "faux/model", formatToolSelectionHints(hints)!);
		controller.begin("call-3", "read_file", {}, { modelRef: "faux/model", requestId: "hint-request" });
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
			controller.begin(`ok-${i}`, "flaky_tool", {}, { modelRef: "faux/model" });
			controller.complete(`ok-${i}`, true, []);
		}
		expect(controller.getActiveHints()).toHaveLength(1);

		for (let i = 0; i < 40; i += 1) {
			controller.begin(`fail-${i}`, "flaky_tool", {}, { modelRef: "faux/model" });
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
			controller.begin(`call-${i}`, "read_file", {}, { modelRef: "faux/model" });
			controller.complete(`call-${i}`, true, []);
		}
		controller.recordValidation("read_file", "repaired", "faux/model");
		expect(store.get({ modelRef: "faux/model", intentClass: "read", tool: "read_file" }).sampleCount).toBe(0);
		expect(controller.getReport()).toEqual([]);
	});

	it("PI_TOOL_SELECTION_HINTS=0 hides the hint even once evidence clears the gate, without touching recorded evidence", () => {
		const store = makeStore();
		const tools: ToolSelectionTool[] = [{ name: "read_file", description: "read a file", pathValidated: true }];
		const observing = makeController(tools, { store });
		for (let i = 0; i < 3; i += 1) {
			observing.begin(`call-${i}`, "read_file", {}, { modelRef: "faux/model" });
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
	it("keeps advisory selection reads from denying an allowed tool", async () => {
		const store = makeStore();
		const controller = makeController(undefined, { store });
		vi.spyOn(store, "getStatsForIntent").mockImplementation(() => {
			throw new Error("advisory read unavailable");
		});
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => process.cwd(),
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome() {},
			getExtensionRunner: () => ({ hasHandlers: () => false }) as unknown as ExtensionRunner,
			getToolSelectionController: () => controller,
		});
		await expect(
			gate.beforeToolCall({
				assistantMessage: { provider: "faux", model: "model" },
				toolCall: { id: "advisory-error", name: "read" },
				args: {},
			} as never),
		).resolves.toBeUndefined();
	});

	it("preserves a successful result during a real advisory storage failure and recovers without a prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-selection-storage-failure-"));
		dirs.push(dir);
		const store = ToolPerformanceStore.forAgentDir(dir, { writeBehind: { maxPending: 1 } });
		const controller = makeController(undefined, { store });
		const blocker = join(dir, "state");
		writeFileSync(blocker, "not a directory");
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => process.cwd(),
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => undefined,
			getExtensionRunner: () => ({ hasHandlers: () => false }) as unknown as ExtensionRunner,
			getToolSelectionController: () => controller,
		});
		try {
			const call = {
				assistantMessage: { provider: "faux", model: "model" },
				toolCall: { id: "success", name: "read" },
				args: {},
			};
			await gate.beforeToolCall(call as never);
			await expect(
				gate.afterToolCall({
					...call,
					result: { content: [{ type: "text", text: "actual result" }] },
					isError: false,
				} as never),
			).resolves.toBeUndefined();
			expect(controller.formatTimingReport()).toContain("observations paused");
			expect(controller.getActiveHints()).toEqual([]);
			rmSync(blocker);
			controller.startTurn();
			expect(controller.formatTimingReport()).not.toContain("observations paused");
			expect(store.get({ modelRef: "faux/model", intentClass: "read", tool: "read" }).sampleCount).toBe(1);
		} finally {
			rmSync(blocker, { recursive: true, force: true });
			store.close();
		}
	});

	it.each([false, true])("retires observations when a result hook fails (throws=%s)", async (throws) => {
		const store = makeStore();
		const controller = makeController(undefined, { store });
		const hookError = new Error("result projection failed");
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => process.cwd(),
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => undefined,
			getExtensionRunner: () =>
				({
					hasHandlers: (event: string) => event === "tool_result",
					emitToolResult: async () => {
						if (throws) throw hookError;
					},
				}) as unknown as ExtensionRunner,
			getToolSelectionController: () => controller,
		});
		const call = {
			assistantMessage: { provider: "faux", model: "model" },
			toolCall: { id: "terminal", name: "read" },
			args: {},
		};
		await gate.beforeToolCall(call as never);
		const completion = gate.afterToolCall({ ...call, result: { content: [] }, isError: false } as never);
		if (throws) await expect(completion).rejects.toBe(hookError);
		else await expect(completion).resolves.toBeUndefined();
		// A stale completion cannot resurrect a terminal call or fabricate usable routing evidence.
		controller.complete("terminal", true, [{ type: "text", text: "late" }]);
		expect(store.get({ modelRef: "faux/model", intentClass: "read", tool: "read" }).sampleCount).toBe(throws ? 0 : 1);
	});

	it.each([false, true])("observes an extension-rewritten call only when allowed (blocked=%s)", async (blocked) => {
		const begin = vi.fn();
		const rewritten = { block: blocked };
		const args = { path: "initial.txt" };
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => process.cwd(),
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => undefined,
			getExtensionRunner: () =>
				({
					hasHandlers: () => true,
					emitToolCall: async (event: ToolCallEvent) => {
						Object.assign(event.input, { path: "rewritten.txt" });
						return rewritten;
					},
				}) as unknown as ExtensionRunner,
			getToolSelectionController: () => ({ begin }) as unknown as ToolSelectionController,
		});
		const result = await gate.beforeToolCall({
			assistantMessage: { provider: "faux", model: "model" },
			toolCall: { id: "rewritten", name: "read" },
			args,
		} as never);
		expect(result).toBe(rewritten);
		expect(args.path).toBe("rewritten.txt");
		if (blocked) expect(begin).not.toHaveBeenCalled();
		else
			expect(begin).toHaveBeenCalledWith("rewritten", "read", args, {
				modelRef: "faux/model",
				requestId: undefined,
			});
	});

	it("observes only calls that survive router, autonomy, and extension gates", async () => {
		const started: string[] = [];
		const completed: Array<{ id: string; success: boolean }> = [];
		const retired: string[] = [];
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
					discard: (id: string) => retired.push(id),
				}) as unknown as ToolSelectionController,
		});
		const runBefore = (input: { toolCall: { id: string; name: string }; args: unknown }) =>
			gate.beforeToolCall({ ...input, assistantMessage: { provider: "faux", model: "model" } } as never);
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
		expect(retired).toEqual(["allowed"]);
	});

	it("maps failed tools to recovery tools and never write after a read miss", () => {
		expect(recoveryToolsForFailedTool("read")).toEqual(["ls"]);
		expect(recoveryToolsForFailedTool("edit")).toEqual(["read"]);
		expect(recoveryToolsForFailedTool("bash")).toEqual(["read", "edit"]);
		expect(recoveryToolsForFailedTool("read")).not.toContain("write");
	});
});
