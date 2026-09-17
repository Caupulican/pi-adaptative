import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatToolSelectionHints, renderedToolSelectionHintIntents } from "../src/core/tool-selection/promotion.ts";
import type { ToolSelectionIntentClass } from "../src/core/tool-selection/tool-performance-store.ts";
import { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";
import { ToolSelectionController } from "../src/core/tool-selection/tool-selection-controller.ts";

const prompt = formatToolSelectionHints([
	{ modelRef: "faux/model", intentClass: "read", tool: "read", sampleCount: 3, entropy: 0, margin: 1 },
])!;
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("request-bound tool hint evidence", () => {
	it.each([
		["canonical", prompt, true],
		["embedded", `Other instructions\n\n${prompt}\n\nMore instructions`, true],
		["bare line", "- read: `read` established for this model", false],
		["missing footer", prompt.replace("Use task judgment.", ""), false],
		["duplicate block", `${prompt}\n${prompt}`, false],
		[
			"duplicate intent",
			prompt.replace("Use task judgment.", "- read: `cat` established for this model\nUse task judgment."),
			false,
		],
		["unknown intent", prompt.replace("- read:", "- invented:"), false],
		["malformed line", prompt.replace("`read`", "``"), false],
	] as const)("recognizes %s without inferring eligibility", (_name, text, expected) => {
		expect([...renderedToolSelectionHintIntents(text, ["read", "search"])]).toEqual(expected ? ["read"] : []);
	});

	it("fences absent, stale, replaced, cross-model and next-turn request evidence", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-hint-request-"));
		const store = ToolPerformanceStore.forAgentDir(dir);
		cleanups.push(() => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		});
		const controller = new ToolSelectionController({
			store,
			getModelRef: () => "faux/model",
			getActiveTools: () => [{ name: "read" }],
		});
		const credit = (requestId?: string) => {
			const result = controller.begin("call", "read", {}, requestId).hintActiveAtCallTime;
			controller.complete("call", true);
			return result;
		};
		expect(credit("request-1")).toBe(false);
		controller.observeProviderRequest("request-1", "faux/model", prompt);
		expect(credit()).toBe(false);
		expect(credit("unknown")).toBe(false);
		expect(credit("request-1")).toBe(true);
		controller.observeProviderRequest("request-2", "faux/model", "No hint");
		expect(credit("request-1")).toBe(false);
		expect(credit("request-2")).toBe(false);
		controller.observeProviderRequest("request-3", "faux/other", prompt);
		expect(credit("request-3")).toBe(false);
		controller.observeProviderRequest("request-4", "faux/model", prompt);
		expect(credit("request-4")).toBe(true);
		controller.startTurn();
		expect(credit("request-4")).toBe(false);
	});

	it("replaces 2,000 request projections without retaining prompt bytes or writing evidence", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-hint-bound-"));
		const store = ToolPerformanceStore.forAgentDir(dir);
		cleanups.push(() => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		});
		const write = vi.spyOn(store, "recordExecution");
		const flush = vi.spyOn(store, "flush");
		const controller = new ToolSelectionController({
			store,
			getModelRef: () => "faux/model",
			getActiveTools: () => [],
		});
		const intents: ToolSelectionIntentClass[] = [
			"read",
			"search",
			"execute",
			"write",
			"retrieve",
			"explain",
			"other",
		];
		const allHints = formatToolSelectionHints(
			intents.map((intentClass) => ({
				modelRef: "faux/model",
				intentClass,
				tool: "fixture",
				sampleCount: 3,
				entropy: 0,
				margin: 1,
			})),
		)!;
		for (let index = 0; index < 2_000; index++) {
			const requestId = `request-${index}`;
			controller.observeProviderRequest(requestId, "faux/model", `${"unretained".repeat(2_000)}\n${allHints}`);
			const retained = (controller as unknown as { requestHints: unknown }).requestHints;
			expect(retained).toEqual({ requestId, modelRef: "faux/model", intents: new Set(intents) });
		}
		expect(write).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
		controller.startTurn();
		expect((controller as unknown as { requestHints: unknown }).requestHints).toBeUndefined();
	});

	it("retains admission evidence through prompt replacement, switch changes and delayed completion", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-hint-completion-"));
		const store = ToolPerformanceStore.forAgentDir(dir);
		cleanups.push(() => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		});
		const env = { PI_TOOL_SELECTION_HINTS: "1" };
		const controller = new ToolSelectionController({
			store,
			getModelRef: () => "faux/model",
			getActiveTools: () => [{ name: "read" }],
			env,
		});
		controller.observeProviderRequest("request-1", "faux/model", prompt);
		env.PI_TOOL_SELECTION_HINTS = "0";
		expect(controller.begin("seen", "read", {}, "request-1").hintActiveAtCallTime).toBe(true);
		controller.observeProviderRequest("request-2", "faux/model", "No hint");
		expect(controller.begin("unseen", "read", {}, "request-2").hintActiveAtCallTime).toBe(false);
		controller.complete("unseen", true);
		controller.complete("seen", true);
		expect(controller.getReport()[0]).toMatchObject({ sampleCount: 2, hintSampleCount: 1 });
	});
});
