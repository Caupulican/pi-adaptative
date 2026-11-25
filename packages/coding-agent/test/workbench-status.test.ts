/** Verifies the Workbench's single status row, its live clock, and the priority of actionable states. */
import { stripVTControlCharacters } from "node:util";
import { Container, Text, visibleWidth } from "@caupulican/pi-tui";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { interfaceText, setInterfaceLanguage } from "../src/core/language/interface-text.ts";
import { ActivityLaneComponent, RUNTIME_TURN_ACTIVITY_ID } from "../src/modes/interactive/components/activity-lane.ts";
import { ACTIVITY_FRAME_MS } from "../src/modes/interactive/components/activity-status-animation.ts";
import {
	buildOperatorPovSegments,
	OperatorPovBarComponent,
	type OperatorPovSource,
} from "../src/modes/interactive/components/operator-pov-bar.ts";
import { WorkbenchComponent } from "../src/modes/interactive/components/workbench.ts";
import { initTheme } from "../src/presentation/theme/theme.ts";
import { theme } from "../src/presentation/theme-model.ts";

beforeAll(() => {
	setInterfaceLanguage("en");
	initTheme("dark");
});

let now: number;
let lane: ActivityLaneComponent;
beforeEach(() => {
	now = 1000;
	lane = new ActivityLaneComponent(
		theme,
		() => {},
		2000,
		() => now,
	);
});
afterEach(() => lane.dispose());

function startTurn(): void {
	lane.start({ id: RUNTIME_TURN_ACTIVITY_ID, kind: "runtime", label: interfaceText().frame.working.workingMessage });
	now += 3000;
}

function statusBar(
	override: Partial<ReturnType<OperatorPovSource["getProjection"]>> = {},
	indicator?: (width: number) => readonly string[],
): OperatorPovBarComponent {
	const segments = buildOperatorPovSegments({
		getProjection: () => ({
			schema_version: "1.0",
			objective_id: "session",
			has_goal: false,
			title: "",
			phase: "build",
			phase_index: 3,
			phase_count: 6,
			current_action: interfaceText().status.operatorTurn,
			why: "",
			health: "normal",
			control: { owner: "root", state: "executing" },
			active_actors: [],
			proof: { satisfied: 0, total: 0, failing: 0, pending: 0 },
			...override,
		}),
		getRouteSnapshot: () => ({
			rootModel: null,
			activeModel: null,
			source: "direct",
			tier: null,
			risk: null,
			reasonCode: null,
			switched: false,
		}),
		getSemanticPlaneHealth: () => ({ state: "ok" }),
		getCostSummary: () => ({
			currentCost: 1.23,
			ownCost: 1.23,
			subagentCost: 0,
			subagentReports: 0,
			historySummaryCost: 0,
			historySummaryReports: 0,
		}),
		isUsingSubscription: () => false,
	});
	return new OperatorPovBarComponent(
		() => segments,
		() => {},
		() => lane.readStatusRow(indicator),
	);
}

it.each(["stacked", "columns"] as const)("uses one status row in the %s layout", (layout) => {
	const editor = new Container();
	editor.addChild(new Text("Editor", 0, 0));
	const view = new WorkbenchComponent({
		conversation: new Container(),
		editor,
		dock: [],
		operatorStatus: statusBar(),
		brand: "Pi",
		viewportRows: () => 20,
	});
	if (layout === "columns") view.toggleLayout();
	startTurn();

	const rows = view.render(100).map(stripVTControlCharacters);
	const editorIndex = rows.findIndex((line) => line.trim() === "Editor");
	expect(rows).toHaveLength(20);
	expect(rows.filter((line) => line.includes("Working"))).toHaveLength(1);
	expect(rows[editorIndex - 1]).toContain("Working (3s)");
	expect(rows[editorIndex - 1]).toContain("$1.230");
	expect(rows.join("\n")).not.toContain(interfaceText().status.operatorTurn);
});

it("names the single foreground tool without replacing the turn clock or repeating the tool count", () => {
	startTurn();
	lane.start({ id: "tool:1", kind: "tool", label: "Bash", tag: "bash" });
	const [row] = statusBar().render(80).map(stripVTControlCharacters);
	expect(row).toContain("Bash (3s)");
	expect(row).not.toContain("1 bash");
});

it("keeps the live clock at narrow widths and keeps a blocker ahead of telemetry", () => {
	startTurn();
	const [live] = statusBar().render(20).map(stripVTControlCharacters);
	const [blocked] = statusBar({ phase: "blocked", why: "Approval needed" }).render(20).map(stripVTControlCharacters);
	expect(live).toContain("Working (3s)");
	expect(blocked).toContain("BLOCKED");
	expect(visibleWidth(live!)).toBeLessThanOrEqual(20);
	expect(visibleWidth(blocked!)).toBeLessThanOrEqual(20);
});

it("shows idle and blocked states without inventing a live clock", () => {
	const [idle] = statusBar({
		phase: "understand",
		control: { owner: "root", state: "deciding" },
		current_action: "Ready for instructions",
	})
		.render(80)
		.map(stripVTControlCharacters);
	const [blocked] = statusBar({ phase: "blocked", why: "Approval needed" }).render(80).map(stripVTControlCharacters);
	expect(idle).toContain("Ready for instructions");
	expect(idle).not.toMatch(/\(\d+s\)/);
	expect(blocked).toContain("BLOCKED");
	expect(blocked).toContain("Approval needed");
});

it("reads the clock again on each render and fits the status to the available width", () => {
	startTurn();
	const bar = statusBar();
	const [first] = bar.render(80).map(stripVTControlCharacters);
	now += 2000;
	const [later] = bar.render(80).map(stripVTControlCharacters);
	expect(first).toContain("Working (3s)");
	expect(later).toContain("Working (5s)");
	for (const width of [4, 12, 20, 40, 80, 120]) {
		const rows = bar.render(width);
		expect(rows).toHaveLength(1);
		expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
	}
});

it("uses a compatibility working indicator in place of the usual activity label", () => {
	startTurn();
	const rows = statusBar({}, () => ["", "\x1b[90m \x1b[0m", "Custom extension activity", "Wrapped line"])
		.render(80)
		.map(stripVTControlCharacters);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toContain("Custom extension activity");
	expect(rows[0]).not.toContain("Wrapped line");
	expect(rows[0]).not.toContain("Working (3s)");
	expect(rows[0]).not.toContain(interfaceText().status.operatorTurn);
});

it("ignores a blank compatibility indicator", () => {
	const indicator = () => ["", "\x1b[90m \x1b[0m"];
	expect(lane.readStatusRow(indicator)).toBeUndefined();
	startTurn();
	const [row] = statusBar({}, indicator).render(80).map(stripVTControlCharacters);
	expect(row).toContain("Working (3s)");
	expect(row).toContain("$1.230");
});

it("paints subsecond animation frames without requesting a fresh session sample", () => {
	vi.useFakeTimers();
	vi.stubEnv("PI_REDUCE_MOTION", "0");
	vi.setSystemTime(1000);
	const requestRender = vi.fn();
	const clockedLane = new ActivityLaneComponent(theme, requestRender, 2000, () => Date.now());
	try {
		clockedLane.start({ id: RUNTIME_TURN_ACTIVITY_ID, kind: "runtime", label: "Working" });
		requestRender.mockClear();
		vi.advanceTimersByTime(ACTIVITY_FRAME_MS);
		expect(requestRender.mock.calls).toEqual([["presentation"]]);
		vi.advanceTimersByTime(1000);
		expect(requestRender.mock.calls.filter(([kind]) => kind === undefined)).toHaveLength(1);
	} finally {
		clockedLane.dispose();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	}
});

it("shows the input wait only once and retains the queued-message hint", () => {
	startTurn();
	lane.syncHumanInputActivity({ requestId: "1", waiting: true });
	lane.wait({ id: "queue:messages", kind: "queue", label: "1 queued · send now" });
	const bar = statusBar({ control: { owner: "user", state: "awaiting_user" } });
	const [row] = bar.render(80).map(stripVTControlCharacters);
	expect(row).toContain("Awaiting you (3s)");
	expect(row).toContain("1 queued · send now");
	expect(row).not.toContain("NEEDS INPUT");
});
