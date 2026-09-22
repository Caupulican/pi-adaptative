import type { AgentMessage } from "@caupulican/pi-agent-core";
import { Container, Text } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { createBackgroundToolTerminalMessage } from "../src/core/background-tool-task-controller.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { WorkbenchComponent, type WorkbenchSection } from "../src/modes/interactive/components/workbench.ts";
import { createWorkbenchToolPreview } from "../src/modes/interactive/components/workbench-tool-preview.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	buildWorkbenchSections,
	WorkbenchController,
	type WorkbenchTeamFacts,
} from "../src/modes/interactive/workbench-controller.ts";
import { WorkspaceObservation } from "../src/modes/interactive/workbench-workspace.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { workbenchCounterFixture, workbenchToolObservation } from "./fixtures/session-failures.ts";

function idleWorker(laneId: string, agentStatus: NonNullable<LaneRecord["agentStatus"]>): LaneRecord {
	return {
		laneId,
		type: "worker",
		status: "succeeded",
		label: "review",
		completedAt: "2026-09-10T20:34:00.000Z",
		agentStatus,
	};
}

function teamBody(section: WorkbenchSection | undefined): string {
	return (Array.isArray(section?.body) ? section.body : []).map(stripAnsi).join("\n");
}

describe("Workbench input boundary", () => {
	beforeAll(() => initTheme("dark"));
	it("hands the mouse over and back on the toggle key, reporting the owner in the hint row", () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 40,
		});
		let captured = false;
		const notices: string[] = [];
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice: (text) => notices.push(text),
			mouse: { enabled: () => captured, set: (enabled) => (captured = enabled) },
		});
		const hint = () => stripAnsi(view.render(120).at(-1) ?? "");
		expect(hint()).toContain("mouse: off");
		expect(controller.handleInput("\x1bm")).toEqual({ consume: true });
		expect(captured).toBe(true);
		expect(hint()).toContain("mouse: on");
		expect(notices.at(-1)).toContain("Workbench owns the mouse");
		controller.handleInput("\x1bm");
		expect(captured).toBe(false);
		expect(hint()).toContain("mouse: off");
		// Reports that still arrive (an emulator flushing after release) are consumed, never typed.
		expect(controller.handleInput("\x1b[<0;5;5M")).toEqual({ consume: true });
	});

	it("pastes the clipboard on a right click anywhere, through the paste port", async () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 40,
		});
		let pastes = 0;
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
			paste: async () => {
				pastes++;
			},
		});
		view.render(120);
		expect(controller.handleInput("\x1b[<2;40;20M")).toEqual({ consume: true }); // right button down, conversation
		expect(controller.handleInput("\x1b[<2;40;20m")).toEqual({ consume: true });
		expect(controller.handleInput("\x1b[<2;5;3M")).toEqual({ consume: true }); // right button down, work area
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pastes).toBe(2);
	});

	it("persists every operator geometry change through the geometry port", () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 40,
		});
		const saved: unknown[] = [];
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
			geometry: { save: (geometry) => saved.push(geometry) },
		});
		view.render(120);
		controller.handleInput("\x1bi");
		controller.handleInput("\x1bx");
		controller.handleInput("\x1b=");
		controller.handleInput("\x1bo");
		// 40 rows: 35 in the budget (title, live row, editor rules, hint), the even split is 16; the first
		// resize makes it an explicit 17.
		expect(saved).toEqual([
			{
				rows: "half",
				collapsed: false,
				inspector: "hidden",
				executionMaximized: false,
				inspectorFraction: 0.3,
				layout: "stacked",
				conversationFraction: 0.5,
				graph: "shown",
				graphFraction: 0.32,
				graphView: "diagram",
			},
			{
				rows: "half",
				collapsed: false,
				inspector: "hidden",
				executionMaximized: true,
				inspectorFraction: 0.3,
				layout: "stacked",
				conversationFraction: 0.5,
				graph: "shown",
				graphFraction: 0.32,
				graphView: "diagram",
			},
			{
				rows: 17,
				collapsed: false,
				inspector: "hidden",
				executionMaximized: true,
				inspectorFraction: 0.3,
				layout: "stacked",
				conversationFraction: 0.5,
				graph: "shown",
				graphFraction: 0.32,
				graphView: "diagram",
			},
			{
				rows: 17,
				collapsed: true,
				inspector: "hidden",
				executionMaximized: true,
				inspectorFraction: 0.3,
				layout: "stacked",
				conversationFraction: 0.5,
				graph: "shown",
				graphFraction: 0.32,
				graphView: "diagram",
			},
		]);
	});

	it("lists failing verifications as a Checks block the operator can act on", () => {
		const sections = buildWorkbenchSections(
			{
				laneRecords: [],
				items: [],
				verification: [
					{ id: "shell-test-abc", command: "vitest run test/x.test.ts", cwd: "/repo/packages/coding-agent" },
					{ id: "shell-test-def" },
				],
			},
			Date.now(),
		);
		const checks = sections.find((section) => section.title === "Checks");
		expect(checks?.meta).toBe("2 failing");
		const rows = (Array.isArray(checks?.body) ? checks.body : []).map(stripAnsi);
		expect(rows[0]).toContain("vitest run test/x.test.ts");
		expect(rows[1]).toContain("shell-test-def");
		expect(rows.at(-1)).toContain("/verify dismiss");
		expect(buildWorkbenchSections({ laneRecords: [], items: [] }, Date.now()).some((s) => s.title === "Checks")).toBe(
			false,
		);
	});

	it("keeps an idle succeeded worker as a retained session", () => {
		const sections = buildWorkbenchSections(
			{ laneRecords: [idleWorker("worker-1", "registered")], items: [] },
			Date.now(),
		);
		const team = sections.find((section) => section.title === "Team");
		expect(team?.meta).toBe("1 agent");
		expect(teamBody(team)).toContain("1 session retained");
	});

	it("orders the Team as Decider, Executors (root first), then Routing, from live facts", () => {
		const facts = (): WorkbenchTeamFacts => ({
			projection: {
				schema_version: "1.0" as const,
				objective_id: "obj",
				title: "fixture",
				phase: "build" as const,
				phase_index: 3,
				phase_count: 6,
				current_action: "Editing parser.ts",
				why: "root is building",
				next_action: null,
				health: "normal" as const,
				control: { owner: "system_one" as const, state: "deciding" as const, reasonCode: "goal_active" },
				active_actors: [{ id: "root", kind: "root" as const, label: "Root orchestrator" }],
				adaptation: null,
				proof: { satisfied: 0, total: 0, failing: 0, pending: 0 },
				context: null,
			},
			health: {
				state: "evaluating" as const,
				inFlight: 1,
				inFlightEvaluations: [
					{ evaluationId: "e1", programId: "system-one:verify", label: "verify", startedAt: Date.now() - 2500 },
				],
			},
			route: {
				rootModel: "xai/grok-4.6",
				activeModel: "openai-codex/gpt-5.6-mini",
				source: "model_router" as const,
				tier: "cheap",
				risk: "read-only" as const,
				reasonCode: null,
				switched: true,
			},
			lanes: [
				{
					laneId: "lane-1",
					type: "worker" as const,
					status: "running" as const,
					label: "tester",
					profileId: "tester",
					modelRef: "xai/grok-4.6",
					startedAt: new Date().toISOString(),
				},
			],
		});
		const sections = buildWorkbenchSections({ laneRecords: facts().lanes, items: [] }, Date.now(), facts);
		const team = sections.find((section) => section.title === "Team");
		expect(team?.meta).toBe("decider + 1 active");
		const body = Array.isArray(team?.body) ? team.body : (team?.body.render(80) ?? []);
		const text = body.map(stripAnsi);
		const at = (needle: string) => text.findIndex((line) => line.includes(needle));
		expect(at("Decider")).toBe(0);
		expect(text[1]).toMatch(/◆ System One · Jev\s+judging verify \d+(\.\d)?s/);
		expect(text[2]).toContain("decides next");
		expect(at("Executors")).toBe(3);
		expect(text[4]).toMatch(/● root · gpt-5.6-mini\s+Editing parser.ts/);
		expect(at("tester")).toBeGreaterThan(4);
		expect(at("Routing")).toBeGreaterThan(at("tester"));
		expect(text.at(-2)).toContain("cheap/read-only via model-router → gpt-5.6-mini for root");
		expect(text.at(-1)).toContain("profile tester → grok-4.6 for tester");
	});

	it("stops counting a retired agent's lane as a retained session", () => {
		// delegate retire ends the worker's session; the lane record stays for status, evidence, and
		// recovery, so the Team block decides by the agent's binding status, not by the record's absence.
		const retired = idleWorker("worker-1", "retired");
		const both = buildWorkbenchSections(
			{ laneRecords: [retired, idleWorker("worker-2", "registered")], items: [] },
			Date.now(),
		);
		const team = both.find((section) => section.title === "Team");
		expect(team?.meta).toBe("1 agent");
		expect(teamBody(team)).toContain("1 session retained");
		const only = buildWorkbenchSections({ laneRecords: [retired], items: [] }, Date.now());
		expect(only.some((section) => section.title === "Team")).toBe(false);
	});

	it("refuses the toggle without a terminal mouse instead of pretending", () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 40,
		});
		const notices: { text: string; error?: boolean }[] = [];
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice: (text, error) => notices.push({ text, error }),
		});
		controller.handleInput("\x1bm");
		expect(notices).toEqual([{ text: "This terminal has no mouse to hand over", error: true }]);
	});

	it("keeps replayed and late background outcomes out of the next cycle's count, including narrow panes", () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 40,
		});
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
		});
		controller.beginCycle();
		controller.record(undefined, {
			toolCallId: "old-call",
			isError: false,
			details: {
				piToolInvocation: {
					version: 1,
					requestId: "old-request",
					execution: "running",
					postprocessingFailures: [],
				},
			},
		});
		controller.complete();
		controller.beginCycle();
		controller.record(new Text("current result", 0, 0), {
			toolCallId: "new-call",
			isError: false,
			details: {
				piToolInvocation: {
					version: 1,
					requestId: "new-request",
					execution: "completed",
					operationStatus: "success",
					postprocessingFailures: [],
				},
			},
		});
		const terminal = {
			role: "custom" as const,
			timestamp: 0,
			...createBackgroundToolTerminalMessage([
				{
					sessionId: "fixture-session",
					taskId: "tool-task-1",
					toolCallId: "old-call",
					toolName: "fixture",
					status: "failed",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T00:00:01.000Z",
					elapsedBeforeHandoffMs: 1,
					summary: "fixture",
					output: "fixture",
					piToolInvocation: {
						version: 1,
						requestId: "old-request",
						execution: "completed",
						operationStatus: "error",
						postprocessingFailures: [],
					},
				},
			]),
		};
		controller.recordBackground(terminal);
		controller.recordBackground(terminal);
		for (const width of [40, 80, 110]) {
			const rendered = stripAnsi(view.render(width).join("\n"));
			expect(rendered).toContain("Completed: 1");
			expect(rendered).not.toContain("In flight:");
			expect(rendered).toContain("retained: 1 error results");
			expect(rendered).not.toContain("negative outcomes");
			expect(rendered).not.toContain("running");
		}
		controller.dispose();
	});
	it("records System One evaluations as Execution evidence with attribution, replacing a preview when its verdict is noted", () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 40,
		});
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
			previewLimit: () => 2,
			attribution: () => ({ kind: "root", label: "root", modelRef: "xai/grok-4.6" }),
		});
		view.applyGeometry({ rows: 12, collapsed: false, inspector: "hidden", executionMaximized: false });
		controller.beginCycle();
		const base = {
			evaluationId: "e1",
			programId: "system-one:verify",
			label: "verify",
			startedAt: 1000,
			endedAt: 3500,
			durationMs: 2500,
		};
		controller.recordSystemOneEvaluation({ ...base, outcome: "ok" });
		controller.recordSystemOneEvaluation({ ...base, outcome: "ok", verdict: "pass", reasons: ["all criteria hold"] });
		const rendered = stripAnsi(view.render(110).join("\n"));
		expect(rendered.match(/◆ System One verify/g)?.length).toBe(1);
		expect(rendered).toMatch(/◆ System One verify\s+system one · pass · 2\.5s/);
		expect(rendered).toContain("all criteria hold");
		expect(rendered).toContain("Completed: 0");
		controller.record(
			createWorkbenchToolPreview(
				"edit",
				{ path: "src/a.ts" },
				{ isError: false, content: [], details: { diff: "+1 x\n-1 y" } },
				controller.attribution(),
			),
			{ toolCallId: "t1", isError: false, details: {} },
		);
		const withTool = stripAnsi(view.render(110).join("\n"));
		expect(withTool).toMatch(/edit · src\/a\.ts\s+\+1 −1\s+root · grok-4\.6/);
		controller.recordSystemOneEvaluation({
			...base,
			evaluationId: "e2",
			label: "objective route",
			outcome: "failed",
			reasons: ["engine timeout"],
		});
		const bounded = stripAnsi(view.render(110).join("\n"));
		expect(bounded).not.toContain("◆ System One verify");
		expect(bounded).toContain("◆ System One objective route");
		expect(bounded).toContain("failed · 2.5s");
		expect(bounded).toContain("engine timeout");
		controller.dispose();
	});
	it("retains a visible file-effect receipt when observation finishes after the agent stops", async () => {
		let calls = 0;
		const workspace = new WorkspaceObservation({
			snapshot: async () => ({ files: new Map(++calls === 1 ? [] : [["silent.py", "changed"]]), limited: false }),
			patch: async () => "+change",
		});
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 20,
		});
		const controller = new WorkbenchController(
			view,
			{
				keybindings: new KeybindingsManager(),
				isInteractive: () => true,
				requestRender() {},
				messages: () => [],
				copy: async () => {},
				notice() {},
			},
			workspace,
		);
		controller.beginCycle("/fixture");
		const pending = controller.afterTool("python");
		controller.complete();
		await pending;
		const text = stripAnsi(view.render(110).join("\n"));
		expect(text).toContain("1 file effects");
		expect(text).toContain("+change");
		// The next cycle keeps the last evidence on screen until it produces its own.
		controller.beginCycle();
		expect(stripAnsi(view.render(110).join("\n"))).toContain("1 file effects");
		controller.record(new Text("fresh result", 0, 0), { toolCallId: "fresh", isError: false, details: {} });
		const next = stripAnsi(view.render(110).join("\n"));
		expect(next).toContain("fresh result");
		expect(next).not.toContain("file effects");
		controller.dispose();
	});
	it("names in-flight foreground work separately from completed receipts", () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 30,
		});
		let inFlight = 2;
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
			activeForegroundCount: () => inFlight,
		});
		controller.beginCycle("/repo", 1);
		controller.record(new Text("done", 0, 0), workbenchToolObservation("one"));
		let text = stripAnsi(view.render(110).join("\n"));
		expect(text).toContain("In flight: 2");
		expect(text).toContain("Completed: 1");
		inFlight = 0;
		controller.beginCycle("/repo", 1);
		text = stripAnsi(view.render(110).join("\n"));
		expect(text).toContain("Completed: 1");
		expect(text).not.toContain("In flight:");
		controller.beginCycle("/repo", 2);
		text = stripAnsi(view.render(110).join("\n"));
		expect(text).toContain("Completed: 0");
		controller.dispose();
	});

	it("keeps evidence after completion, retains failure receipts, and collapses only on request", () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 30,
		});
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
		});
		controller.beginCycle();
		for (const [index, failed] of workbenchCounterFixture.firstCycle.entries()) {
			controller.record(new Text(failed ? "failure detail" : "first-cycle success", 0, 0), {
				toolCallId: `first-${index}`,
				isError: failed,
				details: {},
			});
		}
		expect(stripAnsi(view.render(100).join("\n"))).toContain("failure detail");
		controller.complete();
		let text = stripAnsi(view.render(100).join("\n"));
		expect(text).toContain(workbenchCounterFixture.firstSummary);
		expect(text).toContain("retained: 1 error results");
		expect(text).toContain("failure detail");
		controller.beginCycle();
		for (const [index, failed] of workbenchCounterFixture.secondCycle.entries()) {
			controller.record(new Text("successful verbose result", 0, 0), {
				toolCallId: `second-${index}`,
				isError: failed,
				details: {},
			});
		}
		controller.complete();
		text = stripAnsi(view.render(100).join("\n"));
		expect(text).toContain(workbenchCounterFixture.secondSummary);
		expect(text).toContain("retained: 1 error results");
		expect(text).toContain("successful verbose result");
		expect(text).not.toContain("failure detail");
		controller.handleInput("\x1bo");
		text = stripAnsi(view.render(100).join("\n"));
		expect(view.upperHeight).toBe(0);
		expect(text).not.toContain("successful verbose result");
		expect(text).toMatch(/▸ .*Execution/);
		controller.handleInput("\x1bo");
		expect(stripAnsi(view.render(100).join("\n"))).toContain("successful verbose result");
		controller.dispose();
	});
	it("copies canonical conversation beyond the visible window without opening tool payloads", async () => {
		const messages: AgentMessage[] = Array.from({ length: 300 }, (_, i) => ({
			role: "user",
			content: `message ${i}`,
			timestamp: i,
		}));
		messages.push({
			role: "toolResult",
			toolCallId: "cold",
			toolName: "read",
			isError: false,
			timestamp: 500,
			get content(): never {
				throw new Error("must not hydrate tools to copy conversation");
			},
		});
		const copies: string[] = [];
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 20,
		});
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => messages,
			copy: async (text) => {
				copies.push(text);
			},
			notice() {},
		});
		await controller.copy(true);
		expect(copies[0]).toContain("message 0");
		expect(copies[0]).toContain("message 299");
		controller.dispose();
	});
	it("does not intercept editor input or modal navigation; remapped navigation owns conversation only", () => {
		const chat = new Container();
		chat.addChild(new Text(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), 0, 0));
		const view = new WorkbenchComponent({
			conversation: chat,
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 30,
		});
		let interactive = false;
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager({ "app.conversation.pageUp": "alt+u" }),
			isInteractive: () => interactive,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
		});
		view.render(110);
		expect(controller.handleInput("\x1bu")).toBeUndefined();
		interactive = true;
		expect(controller.handleInput("x")).toBeUndefined();
		expect(controller.handleInput("\x1b[A")).toBeUndefined();
		expect(controller.handleInput("\x1bu")).toEqual({ consume: true });
		expect(view.conversation.following).toBe(false);
		controller.dispose();
	});
	it("routes wheel input by pane rectangle, including narrow stacked execution", () => {
		const chat = new Container();
		chat.addChild(new Text(Array.from({ length: 100 }, (_, i) => `chat ${i}`).join("\n"), 0, 0));
		const view = new WorkbenchComponent({
			conversation: chat,
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 40,
		});
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
		});
		view.setInspector([{ title: "Work plan", body: ["active"] }]);
		controller.record(new Text(Array.from({ length: 40 }, (_, i) => `execution ${i}`).join("\n"), 0, 0), {
			toolCallId: "scroll-fixture",
			isError: false,
			details: {},
		});
		view.render(110);
		expect(stripAnsi(view.render(110).join("\n"))).toContain("execution 39");
		controller.handleInput("\x1b[<64;50;4M");
		const scrolled = stripAnsi(view.render(110).join("\n"));
		expect(scrolled).toContain("execution 36");
		expect(scrolled).not.toContain("execution 39");
		expect(view.conversation.following).toBe(true);
		view.render(40);
		controller.handleInput("\x1b[<64;2;6M");
		expect(stripAnsi(view.render(40).join("\n"))).not.toContain("execution 39");
		expect(view.conversation.following).toBe(true);
		controller.handleInput(`\x1b[<64;2;${view.conversationTop + 2}M`);
		expect(view.conversation.following).toBe(false);
		controller.dispose();
	});
	it("mouse selection pauses live text, copies selection and leaves the editor untouched", async () => {
		const chat = new Container();
		chat.addChild(new Text("hello world", 0, 0));
		const view = new WorkbenchComponent({
			conversation: chat,
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 20,
		});
		const copies: string[] = [];
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async (text) => {
				copies.push(text);
			},
			notice() {},
		});
		view.render(80);
		expect(view.conversationTop).toBe(9);
		expect(view.conversationHeight).toBe(7);
		// The single row anchors to the bottom of the conversation area (row 15, 1-based 16).
		controller.handleInput("\x1b[<0;1;16M"); // The gutter must not select text.
		expect(view.conversation.following).toBe(true);
		// A click without a drag only focuses the pane: nothing freezes, following continues.
		controller.handleInput("\x1b[<0;2;16M");
		controller.handleInput("\x1b[<0;2;16m");
		expect(view.conversation.following).toBe(true);
		expect(view.conversation.selectionText()).toBeUndefined();
		controller.handleInput("\x1b[<0;2;16M");
		controller.handleInput("\x1b[<32;7;16M");
		controller.handleInput("\x1b[<0;7;16m");
		// Release copies the selection, as the terminal would have; an explicit copy repeats it.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(copies).toEqual(["hello"]);
		await controller.copy(false);
		expect(copies).toEqual(["hello", "hello"]);
		expect(view.conversation.following).toBe(false);
		controller.dispose();
	});

	function mouse(button: number, column: number, row: number, release = false): string {
		return `\x1b[<${button};${column + 1};${row + 1}${release ? "m" : "M"}`;
	}

	function pointerWorkbench() {
		const conversation = new Container();
		conversation.addChild(new Text("hello world", 0, 0));
		const view = new WorkbenchComponent({
			conversation,
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 30,
		});
		const saved: unknown[] = [];
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
			geometry: { save: (geometry) => saved.push({ ...geometry }) },
		});
		view.applyGeometry({ rows: 10, collapsed: false, inspector: "shown", executionMaximized: false });
		view.setInspector([{ title: "Work plan", meta: "1 / 3", body: ["active step"] }]);
		view.setExecution(new Text("fn main() {}", 0, 0));
		view.render(110);
		return { view, controller, saved };
	}

	it("hides the Work plan from Hide and restores it from Show plan", () => {
		const { view, controller } = pointerWorkbench();
		const shown = stripAnsi(view.render(110)[1] ?? "");
		const hide = shown.indexOf("Hide");
		expect(hide).toBeGreaterThan(0);
		expect(controller.handleInput(mouse(0, hide, 1))).toEqual({ consume: true });
		expect(view.geometry().inspector).toBe("hidden");
		const title = stripAnsi(view.render(110)[1] ?? "");
		const chip = title.indexOf("Show plan");
		expect(chip).toBeGreaterThan(0);
		controller.handleInput(mouse(0, chip, 1));
		expect(view.geometry().inspector).toBe("shown");
	});

	it("maximizes Execution from Maximize and restores from Restore", () => {
		const { view, controller } = pointerWorkbench();
		const shown = stripAnsi(view.render(110)[1] ?? "");
		const maximize = shown.indexOf("Maximize");
		expect(maximize).toBeGreaterThan(0);
		controller.handleInput(mouse(0, maximize, 1));
		expect(view.geometry().executionMaximized).toBe(true);
		expect(view.geometry().collapsed).toBe(false);
		const restored = stripAnsi(view.render(110)[1] ?? "");
		const restore = restored.indexOf("Restore");
		expect(restore).toBeGreaterThan(0);
		controller.handleInput(mouse(0, restore, 1));
		expect(view.geometry().executionMaximized).toBe(false);
	});

	it("does not change geometry from title text outside a chip", () => {
		const { view, controller, saved } = pointerWorkbench();
		const title = stripAnsi(view.render(110)[1] ?? "");
		const plan = title.indexOf("Work plan");
		const execution = title.indexOf("Execution");
		expect(plan).toBeGreaterThanOrEqual(0);
		expect(execution).toBeGreaterThan(plan);
		controller.handleInput(mouse(0, plan, 1));
		controller.handleInput(mouse(0, execution, 1));
		expect(view.geometry()).toMatchObject({ inspector: "shown", executionMaximized: false });
		expect(saved).toEqual([]);
	});

	it("collapses on a divider click and resizes on a divider drag, persisting only on release", () => {
		const { view, controller, saved } = pointerWorkbench();
		const divider = view.dividerRow;
		controller.handleInput(mouse(0, 0, divider));
		controller.handleInput(mouse(0, 0, divider, true));
		expect(view.geometry().collapsed).toBe(true);
		controller.handleInput(mouse(0, 0, view.dividerRow));
		controller.handleInput(mouse(0, 0, view.dividerRow, true));
		expect(view.geometry().collapsed).toBe(false);
		view.render(110);
		saved.length = 0;
		const start = view.dividerRow;
		const height = view.upperHeight;
		controller.handleInput(mouse(0, 0, start));
		expect(saved).toEqual([]);
		controller.handleInput(mouse(32, 0, start + 4));
		view.render(110);
		expect(view.upperHeight).toBe(height + 4);
		expect(view.geometry().collapsed).toBe(false);
		expect(saved).toEqual([]);
		controller.handleInput(mouse(0, 0, start + 4, true));
		expect(saved.at(-1)).toMatchObject({ rows: height + 4, collapsed: false });
	});

	it("drags the inspector split and keeps the fraction inside its clamps", () => {
		const { view, controller, saved } = pointerWorkbench();
		const split = [...Array(110).keys()].find((column) => view.hitTest(column, 5) === "split");
		expect(split).toBeDefined();
		const start = view.geometry().inspectorFraction ?? 0.3;
		controller.handleInput(mouse(0, split!, 5));
		controller.handleInput(mouse(32, split! + 16, 5));
		expect(view.geometry().inspectorFraction).toBeGreaterThan(start);
		expect(saved).toEqual([]);
		controller.handleInput(mouse(32, 0, 5));
		expect(view.geometry().inspectorFraction).toBeGreaterThanOrEqual(0.2);
		controller.handleInput(mouse(0, 0, 5, true));
		expect(saved.at(-1)).toMatchObject({
			inspectorFraction: view.geometry().inspectorFraction,
			inspector: "shown",
		});
	});

	it("switches to columns from its key and resizes the conversation split on drag", () => {
		const { view, controller, saved } = pointerWorkbench();
		// One chip per pane: the columns layout lives on alt+p and on the header's Stacked chip.
		expect(stripAnsi(view.render(110)[1] ?? "")).not.toContain("Columns");
		controller.handleInput("\x1bp");
		expect(view.geometry().layout).toBe("columns");
		view.toggleInspector();
		view.render(110);
		expect(stripAnsi(view.render(110)[1] ?? "")).toMatch(/Conversation.*Execution/);
		expect(stripAnsi(view.render(110).join("\n"))).not.toContain("Work plan");
		const split = [...Array(110).keys()].find((column) => view.hitTest(column, 5) === "columnSplit");
		expect(split).toBeDefined();
		saved.length = 0;
		controller.handleInput(mouse(0, split!, 5));
		controller.handleInput(mouse(32, split! + 10, 5));
		expect(saved).toEqual([]);
		controller.handleInput(mouse(0, split! + 10, 5, true));
		expect(saved.at(-1)).toMatchObject({ layout: "columns" });
		expect(view.geometry().conversationFraction).toBeGreaterThan(0.3);
		const stacked = stripAnsi(view.render(110)[1] ?? "").indexOf("Stacked");
		expect(stacked).toBeGreaterThan(0);
		controller.handleInput(mouse(0, stacked, 1));
		expect(view.geometry().layout).toBe("stacked");
	});

	it("does not apply a stacked inspector chip to the execution title row", () => {
		const { view, controller } = pointerWorkbench();
		view.render(60);
		let executionRow = -1;
		let inspectorRow = -1;
		for (let row = 0; row < 20; row++) {
			if (executionRow < 0 && view.hitTest(2, row) === "executionTitle") executionRow = row;
			if (inspectorRow < 0 && view.hitTest(2, row) === "inspectorTitle") inspectorRow = row;
		}
		expect(executionRow).toBeGreaterThan(0);
		expect(inspectorRow).toBeGreaterThan(executionRow);
		const hide = stripAnsi(view.render(60)[inspectorRow] ?? "").indexOf("Hide");
		expect(hide).toBeGreaterThan(0);
		expect(view.hitTest(hide, executionRow)).toBe("executionTitle");
		expect(view.paneTitleAction(hide, inspectorRow)).toBe("hideInspector");
		expect(view.paneTitleAction(hide, executionRow)).not.toBe("hideInspector");
		controller.handleInput(mouse(0, hide, executionRow));
		expect(view.geometry()).toMatchObject({ executionMaximized: true, inspector: "shown" });
	});

	it("restores rows when a divider drag returns to its origin before release", () => {
		const { view, controller, saved } = pointerWorkbench();
		view.applyGeometry({ rows: 60, collapsed: false, inspector: "shown", executionMaximized: false });
		view.render(110);
		expect(view.upperHeight).toBeLessThan(60);
		const start = view.dividerRow;
		controller.handleInput(mouse(0, 0, start));
		controller.handleInput(mouse(32, 0, start - 2));
		view.render(110);
		controller.handleInput(mouse(32, 0, start));
		controller.handleInput(mouse(0, 0, start, true));
		expect(view.geometry().rows).toBe(60);
		expect(view.geometry().collapsed).toBe(false);
		expect(saved.at(-1)).toMatchObject({ rows: 60, collapsed: false });
	});

	it("keeps the even-split row setting when a divider drag returns to its origin", () => {
		const { view, controller, saved } = pointerWorkbench();
		view.applyGeometry({ rows: "half", collapsed: false, inspector: "shown", executionMaximized: false });
		view.render(110);
		const start = view.dividerRow;
		controller.handleInput(mouse(0, 0, start));
		controller.handleInput(mouse(32, 0, start + 3));
		view.render(110);
		controller.handleInput(mouse(32, 0, start));
		controller.handleInput(mouse(0, 0, start, true));
		expect(view.geometry().rows).toBe("half");
		expect(saved.at(-1)).toMatchObject({ rows: "half" });
	});

	it("ignores orthogonal motion on the inspector split", () => {
		const { view, controller, saved } = pointerWorkbench();
		const split = [...Array(110).keys()].find((column) => view.hitTest(column, 5) === "split");
		expect(split).toBeDefined();
		const fraction = view.geometry().inspectorFraction;
		controller.handleInput(mouse(0, split!, 5));
		controller.handleInput(mouse(32, split!, 8));
		controller.handleInput(mouse(0, split!, 8, true));
		expect(view.geometry().inspectorFraction).toBe(fraction);
		expect(saved).toEqual([]);
	});

	it("does not change geometry from a pane-body click or a conversation drag", () => {
		const { view, controller, saved } = pointerWorkbench();
		const before = view.geometry();
		controller.handleInput(mouse(0, 2, 4));
		controller.handleInput(mouse(0, 2, 4, true));
		expect(view.geometry()).toEqual(before);
		controller.handleInput(mouse(0, 2, view.conversationTop));
		controller.handleInput(mouse(32, 8, view.conversationTop));
		controller.handleInput(mouse(0, 8, view.conversationTop, true));
		expect(view.geometry()).toEqual(before);
		expect(saved).toEqual([]);
	});
});
