import { stripVTControlCharacters } from "node:util";
import { Container, Text } from "@caupulican/pi-tui";
import { beforeAll, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { setInterfaceLanguage } from "../src/core/language/interface-text.ts";
import type { DecisionGraphModel } from "../src/modes/interactive/components/decision-graph-model.ts";
import { WorkbenchComponent, type WorkbenchGeometry } from "../src/modes/interactive/components/workbench.ts";
import { WorkbenchController } from "../src/modes/interactive/workbench-controller.ts";
import { initTheme } from "../src/presentation/theme/theme.ts";

beforeAll(() => {
	setInterfaceLanguage("en");
	initTheme("dark");
});

function setup(viewportRows = () => 24) {
	const editor = new Container();
	editor.addChild(new Text("Editor", 0, 0));
	const view = new WorkbenchComponent({
		conversation: new Container(),
		editor,
		dock: [],
		brand: "Pi",
		viewportRows,
		chatRoster: () => ({
			activeTarget: { kind: "root" },
			rootModelLabel: "Test model",
			rootRunning: false,
			bots: [],
			lanes: [],
			teams: [],
		}),
	});
	const saved: WorkbenchGeometry[] = [];
	const controller = new WorkbenchController(view, {
		keybindings: new KeybindingsManager(),
		isInteractive: () => true,
		requestRender: () => {},
		requestPresentationRender: () => {},
		messages: () => [],
		copy: async () => {},
		notice: () => {},
		geometry: { save: (state) => saved.push(state) },
	});
	return { view, controller, saved };
}

function mouse(button: number, column: number, row: number, end = "M"): string {
	return `\x1b[<${button};${column + 1};${row + 1}${end}`;
}

it("resizes and hides the sidebar with the keyboard when the terminal owns the mouse", () => {
	const { view, controller, saved } = setup();
	view.setMouseMode(false);
	view.render(140);
	const initial = view.resolvedGraphWidth(140);
	expect(initial).toBeGreaterThan(0);

	expect(controller.handleInput("\x1b.")).toEqual({ consume: true });
	expect(view.resolvedGraphWidth(140)).toBe(initial + 4);
	expect(controller.handleInput("\x1b,")).toEqual({ consume: true });
	expect(view.resolvedGraphWidth(140)).toBe(initial);

	controller.handleInput("\x1bg");
	view.render(140);
	expect(view.resolvedGraphWidth(140)).toBe(0);
	const hidden = saved.at(-1);
	expect(hidden?.leftPane).toBe("hidden");
	controller.handleInput("\x1b.");
	expect(saved.at(-1)).toBe(hidden);

	controller.handleInput("\x1bg");
	view.render(140);
	expect(view.resolvedGraphWidth(140)).toBe(initial);
	expect(saved.at(-1)?.leftPane).toBe("shown");
});

it.each(["chats", "graph"] as const)("the %s chevron hides the whole sidebar", (mode) => {
	const { view, controller, saved } = setup();
	if (mode === "graph") {
		const model: DecisionGraphModel = {
			objectiveId: "test",
			you: { present: false, waiting: false, asked: 0, answered: 0 },
			decider: { owner: "root", evaluating: undefined, evaluations: 0, doing: "", rootOwned: true },
			stages: [],
			loop: 0,
			plan: [{ title: "Inspect the source", status: "active" }],
			checks: [],
			peerFindings: [],
			participants: [],
			routing: [],
			evidence: { actions: 0, fileEffects: 0, failures: 0 },
			goal: { present: false, branch: "pending" },
			unresolvedDoubtCount: 0,
			hasRunningClock: false,
			turnRunning: false,
			flow: [],
			stageLogEmpty: true,
			nowMs: 0,
		};
		view.setDecisionGraph((visible) => (visible ? model : undefined));
		view.toggleLeftPaneMode();
	}
	view.setMouseMode(true);
	view.render(140);
	const row = view.conversationTop - 1;
	expect(view.hitTest(view.resolvedGraphWidth(140), row)).toBe("graphSplit");
	expect(view.paneTitleAction(1, row)).toBe("hideLeftPane");
	controller.handleInput(mouse(0, 1, row));
	view.render(140);
	expect(view.resolvedGraphWidth(140)).toBe(0);
	expect(saved.at(-1)?.leftPane).toBe("hidden");
	controller.handleInput("\x1bg");
	view.render(140);
	expect(view.leftSidebarMode).toBe(mode);
	expect(view.resolvedGraphWidth(140)).toBeGreaterThan(0);
});

it("updates sidebar visibility while the input takes the available height", () => {
	let height = 6;
	const { view, controller, saved } = setup(() => height);
	view.render(140);
	expect(view.conversationHeight).toBe(0);
	expect(controller.handleInput("\x1bg")).toEqual({ consume: true });
	expect(saved.at(-1)?.leftPane).toBe("hidden");
	height = 24;
	view.render(140);
	expect(view.resolvedGraphWidth(140)).toBe(0);
});

it("drags the visible sidebar rule and saves only at release", () => {
	const { view, controller, saved } = setup();
	view.setMouseMode(true);
	view.render(140);
	const rule = view.resolvedGraphWidth(140);
	const row = view.conversationTop;
	expect(view.hitTest(rule, row)).toBe("graphSplit");

	controller.handleInput(mouse(0, rule, row));
	controller.handleInput(mouse(32, rule + 8, row));
	expect(view.resolvedGraphWidth(140)).toBe(rule + 8);
	expect(saved).toHaveLength(0);
	controller.handleInput(mouse(0, rule + 8, row, "m"));
	expect(saved).toHaveLength(1);
});

it("shows the Conversation/Execution column divider at a draggable cell", () => {
	const { view } = setup();
	view.toggleLayout();
	const rows = view.render(140).map(stripVTControlCharacters);
	const column = view.columnSplitStart + 1;
	const row = view.conversationTop;
	expect(rows[row]?.at(column)).toBe("│");
	expect(view.hitTest(column, row)).toBe("columnSplit");
});

it("samples the graph only when it can fit inside the actual conversation column", () => {
	const { view } = setup();
	const visibility: boolean[] = [];
	view.setDecisionGraph((visible) => {
		visibility.push(visible);
		return undefined;
	});
	view.toggleLayout();
	view.render(140);
	view.resizeConversation(0.7);
	view.render(180);
	expect(visibility).toEqual([false, true]);
});
