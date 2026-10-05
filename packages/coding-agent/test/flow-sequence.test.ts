import { setAmbiguousWidthMode, visibleWidth } from "@caupulican/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type FlowEvent, MAX_FLOW_EVENTS } from "../src/core/operator-projection/flow-trace.ts";
import type { DecisionGraphModel, DecisionStageRow } from "../src/modes/interactive/components/decision-graph-model.ts";
import { DecisionGraphPane } from "../src/modes/interactive/components/decision-graph-pane.ts";
import { renderDecisionDiagram } from "../src/modes/interactive/components/decision-graph-render.ts";
import { FLOW_FRAME_MS, FlowAnimator } from "../src/modes/interactive/components/flow-animator.ts";
import {
	arrowCarrierCell,
	CARRIER_FLIGHT_MS,
	CARRIER_GLYPH,
	CARRIER_LOOP_MS,
	CARRIER_SETTLE_MS,
	CARRIER_STEP_MS,
	carrierActiveUntil,
	carrierIndex,
} from "../src/modes/interactive/components/flow-carrier.ts";
import { flowRows, renderFlowLanes } from "../src/modes/interactive/components/flow-lanes-render.ts";
import { initTheme } from "../src/presentation/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("matrix-machine"));
afterEach(() => {
	setAmbiguousWidthMode(false);
	vi.useRealTimers();
});

let sequence = 0;
function event(value: Omit<FlowEvent, "id">): FlowEvent {
	return { id: `${++sequence}`, ...value };
}

/** One session: a prompt, a turn, a judgment with evidence, a tool, two workers (one queued), a question, a failed report. */
function session(): FlowEvent[] {
	return [
		event({
			actor: "owner",
			kind: "prompt",
			label: "fix the flaky test",
			to: "root",
			startedAt: 1000,
			endedAt: 1000,
		}),
		event({ actor: "root", kind: "turn", label: "turn", startedAt: 1000 }),
		event({
			actor: "system_one",
			kind: "judgment",
			label: "route:verify → stall",
			evidence: "#a1b2",
			to: "root",
			startedAt: 1000,
			endedAt: 3100,
			outcome: "ok",
		}),
		event({ actor: "root", kind: "tool", label: "read", startedAt: 3200, endedAt: 3900, outcome: "ok" }),
		event({ actor: "root", kind: "delegate", label: "tester", to: "worker", startedAt: 4000, endedAt: 4000 }),
		event({ actor: "worker", kind: "worker", label: "tester", lane: "tester", startedAt: 4000 }),
		event({ actor: "root", kind: "delegate", label: "builder", to: "worker", startedAt: 4100, endedAt: 4100 }),
		event({ actor: "worker", kind: "wait", label: "queued", lane: "builder", startedAt: 4100 }),
		event({ actor: "root", kind: "question", label: "Keep the old flag?", to: "owner", startedAt: 5000 }),
		event({
			actor: "worker",
			kind: "report",
			label: "tester: failed",
			to: "root",
			lane: "tester",
			startedAt: 6000,
			endedAt: 6000,
			outcome: "failed",
		}),
	];
}

/** Where each field glyph starts, by terminal column, of an uncolored row. */
function glyphsByColumn(line: string): Map<number, string> {
	const columns = new Map<number, string>();
	let column = 0;
	for (const glyph of Array.from(stripAnsi(line))) {
		columns.set(column, glyph);
		column += visibleWidth(glyph);
	}
	return columns;
}

const LIFELINE_GLYPHS = new Set(["│", "┃", "┆", "·", "┼", "┤", "├"]);

describe("sequence layout geometry (flow)", () => {
	for (const width of [48, 80, 120]) {
		it(`every arrow lands on lifeline columns at width ${width}`, () => {
			const result = renderFlowLanes(session(), width, 5100);
			const header = stripAnsi(result.rows[0]!);
			expect(visibleWidth(header)).toBeLessThanOrEqual(width);
			const body = result.rows.slice(result.rows.findIndex((row) => stripAnsi(row).includes("fix the flaky")));
			expect(body.length).toBe(session().length);
			// The lifeline columns are where the first row's idle lifelines stand: read them off the owner's arrow row.
			const lifelineColumns = [...glyphsByColumn(body[3]!)]
				.filter(([, glyph]) => LIFELINE_GLYPHS.has(glyph) || "◆▸●".includes(glyph))
				.map(([column]) => column);
			for (const row of body) {
				const text = stripAnsi(row);
				expect(visibleWidth(text)).toBeLessThanOrEqual(width);
				const columns = glyphsByColumn(row);
				const arrowEnd = [...columns].find(([, glyph]) => glyph === "┤" || glyph === "├");
				if (arrowEnd) expect(lifelineColumns).toContain(arrowEnd[0]);
				const head = [...columns].find(([, glyph]) => glyph === "▶" || glyph === "◀");
				if (head) expect(lifelineColumns).not.toContain(head[0]);
			}
		});
	}

	it("keeps lifeline cells on the pitch and the label column right of the field", () => {
		for (const width of [48, 80, 120]) {
			const result = renderFlowLanes(session(), width, 5100);
			const first = stripAnsi(result.rows.find((row) => stripAnsi(row).includes("fix the flaky"))!);
			const labelAt = first.indexOf("fix the flaky");
			expect(labelAt).toBeGreaterThan(0);
			expect(first.slice(0, labelAt).trimEnd().length).toBeLessThan(width / 2 + 2);
		}
	});

	it("holds the grid when ambiguous glyphs are two columns wide", () => {
		setAmbiguousWidthMode(true);
		for (const width of [48, 80, 120]) {
			const result = renderFlowLanes(session(), width, 5100);
			for (const row of result.rows) expect(visibleWidth(stripAnsi(row))).toBeLessThanOrEqual(width);
			const columns = glyphsByColumn(result.rows.find((row) => stripAnsi(row).includes("fix the flaky"))!);
			// A cell is two columns: every field glyph starts on an even column.
			for (const [column, glyph] of columns) if (LIFELINE_GLYPHS.has(glyph)) expect(column % 2).toBe(0);
		}
	});
});

describe("carrier", () => {
	it("travels once within the settle window and then disappears", () => {
		const timing = { startedAt: 1000, endedAt: 1000 };
		expect(carrierIndex(5, timing, 1000)).toBe(0);
		expect(carrierIndex(5, timing, 1000 + CARRIER_SETTLE_MS / 2)).toBe(2);
		expect(carrierIndex(5, timing, 1000 + CARRIER_SETTLE_MS - 1)).toBe(4);
		expect(carrierIndex(5, timing, 1000 + CARRIER_SETTLE_MS)).toBeUndefined();
		expect(carrierActiveUntil(timing, 1000)).toBe(1000 + CARRIER_SETTLE_MS);
		expect(carrierActiveUntil(timing, 1000 + CARRIER_SETTLE_MS)).toBeUndefined();
	});

	it("loops fast for a bounded window from the start, then steps once per second with no timer needed", () => {
		const timing = { startedAt: 0 };
		expect(carrierActiveUntil(timing, 0)).toBe(CARRIER_FLIGHT_MS);
		expect(carrierActiveUntil(timing, CARRIER_FLIGHT_MS - 1)).toBe(CARRIER_FLIGHT_MS);
		expect(carrierActiveUntil(timing, CARRIER_FLIGHT_MS)).toBeUndefined();
		expect(carrierActiveUntil(timing, 10_000_000)).toBeUndefined();
		expect(carrierIndex(4, timing, 0)).toBe(0);
		expect(carrierIndex(4, timing, CARRIER_LOOP_MS * 2 + CARRIER_LOOP_MS / 2)).toBe(2);
		// Past the window the position is a function of whole seconds: it advances one cell per step, wrapping.
		const late = 600_000;
		const first = carrierIndex(4, timing, late)!;
		expect(carrierIndex(4, timing, late + CARRIER_STEP_MS / 2)).toBe(first);
		expect(carrierIndex(4, timing, late + CARRIER_STEP_MS)).toBe((first + 1) % 4);
	});

	it("never leaves the arrow path: only cells strictly between the lifelines", () => {
		for (const arrow of [
			{ from: 0, to: 14 },
			{ from: 14, to: 0 },
			{ from: 7, to: 9 },
		]) {
			const low = Math.min(arrow.from, arrow.to);
			const high = Math.max(arrow.from, arrow.to);
			for (const timing of [{ startedAt: 0 }, { startedAt: 0, endedAt: 100 }]) {
				for (let now = 0; now < 5000; now += 25) {
					const cell = arrowCarrierCell(arrow, timing, now);
					if (cell !== undefined) {
						expect(cell).toBeGreaterThan(low);
						expect(cell).toBeLessThan(high);
					}
				}
			}
		}
	});

	it("rides the in-flight arrow in a rendered frame and is absent once settled or under reduced motion", () => {
		const flow = session();
		const moving = renderFlowLanes(flow, 80, 5100);
		const questionRow = stripAnsi(moving.rows.find((row) => stripAnsi(row).includes("Keep the old flag?"))!);
		expect(questionRow).toContain(CARRIER_GLYPH);
		expect(moving.motionUntil).toBe(5000 + CARRIER_FLIGHT_MS);
		const still = renderFlowLanes(flow, 80, 5100, false);
		expect(stripAnsi(still.rows.find((row) => stripAnsi(row).includes("Keep the old flag?"))!)).not.toContain(
			CARRIER_GLYPH,
		);
		expect(still.motionUntil).toBeUndefined();
		const settled = renderFlowLanes(
			flow.filter((item) => item.kind !== "question"),
			80,
			60_000,
		);
		expect(settled.motionUntil).toBeUndefined();
	});
});

describe("sequence view product", () => {
	it("reads as an engineered sequence diagram in glyphs alone (no color)", () => {
		const result = renderFlowLanes(session(), 80, 5100);
		expect(result.rows.map((row) => stripAnsi(row).trimEnd()).join("\n")).toMatchInlineSnapshot(`
			"you       2         root      tester    builder
			2 System One
			›─────────┼────────▶┤         │         │  fix the flaky test
			│         │         ●         │         │  turn  4.1s
			│         ◆────────▶┤         │         │  route:verify (stall) #a1b2  2.1s
			│         │         ▸         │         │  read
			│         │         ›────────▶┤         │  tester
			│         │         ┆         ●         │  tester  1.1s
			│         │         ›·········┼········▶┤  builder
			│         │         ┆         ┆         ○  builder: queued  1.0s
			├◀┄┄┄┄┄┄┄┄┼┄┄┄┄┄┄┄●┄?         ┆         ·  Keep the old flag?  0.1s
			│         │         ├◀───────●‹         ·  ✗ tester: failed"
		`);
	});

	it("fits the System One title at 80 columns when a lone worker shares the field", () => {
		const flow = [
			event({ actor: "root", kind: "delegate", label: "tester", to: "worker", startedAt: 0, endedAt: 0 }),
			event({ actor: "worker", kind: "worker", label: "tester", lane: "tester", startedAt: 0 }),
		];
		const rows = renderFlowLanes(flow, 80, 100).rows.map((row) => stripAnsi(row));
		expect(rows[0]).toContain("System One");
		expect(rows[1]).not.toMatch(/^\d /);
	});

	it("keeps state in glyphs: in flight dashed, claimed dotted, outcome marked", () => {
		const text = renderFlowLanes(session(), 80, 5100)
			.rows.map((row) => stripAnsi(row))
			.join("\n");
		expect(text).toContain("┄");
		expect(text).toContain("····");
		expect(text).toContain("✗ tester: failed");
		expect(text).toContain("route:verify (stall) #a1b2");
	});

	it("folds runs of finished same-kind actions and keeps the counted row", () => {
		const tools = Array.from({ length: 6 }, (_, index) =>
			event({
				actor: "root",
				kind: "tool",
				label: `t${index}`,
				startedAt: index * 10,
				endedAt: index * 10 + 5,
				outcome: "ok",
			}),
		);
		const rows = flowRows(tools);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.count).toBe(6);
		expect(rows[0]!.last).toBe(tools[5]);
	});

	it("says so when nothing happened yet", () => {
		const result = renderFlowLanes([], 60, 0);
		expect(stripAnsi(result.rows.at(-1)!)).toContain("no activity yet");
	});
});

describe("sequence view under load (reality)", () => {
	function crowd(workers = 10): FlowEvent[] {
		const flow: FlowEvent[] = [];
		for (let index = 0; index < MAX_FLOW_EVENTS; index++) {
			const worker = index % workers === 0 ? `long-${"w".repeat(70)}` : `worker-${index % workers}`;
			const kind = index % 4;
			flow.push(
				kind === 0
					? event({
							actor: "root",
							kind: "delegate",
							label: worker,
							to: "worker",
							startedAt: index * 100,
							endedAt: index * 100,
						})
					: kind === 1
						? event({
								actor: "worker",
								kind: "report",
								label: `${worker}: ${index % 8 === 1 ? "failed" : "succeeded"}`,
								to: "root",
								lane: worker,
								startedAt: index * 100,
								endedAt: index * 100,
								outcome: index % 8 === 1 ? "failed" : "ok",
							})
						: kind === 2
							? event({
									actor: "worker",
									kind: "worker",
									label: worker,
									lane: worker,
									startedAt: index * 100,
									endedAt: index * 100 + 250,
									outcome: "ok",
								})
							: event({
									actor: "root",
									kind: "notice",
									label: "日本語のとても長いラベル ".repeat(8),
									to: "owner",
									startedAt: index * 100,
									endedAt: index * 100,
								}),
			);
		}
		return flow;
	}

	for (const wide of [false, true]) {
		for (const width of [48, 80, 120]) {
			it(`400 events, 10 workers, CJK labels at width ${width}${wide ? " with wide ambiguous glyphs" : ""}`, () => {
				setAmbiguousWidthMode(wide);
				const result = renderFlowLanes(crowd(), width, 41_000);
				for (const row of result.rows) expect(visibleWidth(stripAnsi(row))).toBeLessThanOrEqual(width);
				expect(result.rows.length).toBeGreaterThan(100);
			});
		}
	}

	it("folds the least recent workers into one overflow lifeline when the width cannot hold them", () => {
		const head = renderFlowLanes(crowd(14), 48, 41_000)
			.rows.slice(0, 6)
			.map((row) => stripAnsi(row));
		// Thirteen lifelines (three fixed, nine workers, one overflow) at the minimum pitch: tags in the header, names in the legend, one "+N more".
		expect(head[0]).toBe("1 2 3 4 5 6 7 8 9 a b c d");
		expect(head.join("\n")).toContain("long-");
		expect(head.join("\n")).toMatch(/d \+\d+ more/);
		const wide = renderFlowLanes(crowd(14), 120, 41_000).rows[0]!;
		expect(stripAnsi(wide)).toContain("you");
	});
});

describe("flow animator", () => {
	it("runs one timer while a carrier is needed and none when quiescent", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const requestRender = vi.fn();
		const animator = new FlowAnimator({ requestRender, reducedMotion: () => false });
		expect(animator.running).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		animator.request(CARRIER_SETTLE_MS);
		for (let rapid = 0; rapid < 20; rapid++) animator.request(CARRIER_SETTLE_MS + rapid * 10);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(FLOW_FRAME_MS * 4);
		expect(requestRender).toHaveBeenCalledTimes(4);
		vi.advanceTimersByTime(5_000);
		expect(vi.getTimerCount()).toBe(0);
		expect(animator.running).toBe(false);
		// At most 20 frames per second, and the tick that sees the end draws the settled frame once.
		expect(requestRender.mock.calls.length).toBeLessThanOrEqual(
			Math.ceil((CARRIER_SETTLE_MS + 190) / FLOW_FRAME_MS) + 1,
		);
	});

	it("clears when a frame reports no carrier and stays at one timer through rapid transitions", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const animator = new FlowAnimator({ requestRender: () => {}, reducedMotion: () => false });
		for (let step = 0; step < 50; step++) {
			animator.request(Number.POSITIVE_INFINITY);
			expect(vi.getTimerCount()).toBe(1);
			animator.settled();
			expect(vi.getTimerCount()).toBe(0);
		}
		animator.request(Number.POSITIVE_INFINITY);
		vi.advanceTimersByTime(60_000);
		expect(vi.getTimerCount()).toBe(1);
		animator.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("holds no timer past the fast window for an edge open for ten minutes", () => {
		vi.useFakeTimers();
		const opened = 1_000_000;
		vi.setSystemTime(opened);
		const flow = [event({ actor: "root", kind: "question", label: "Keep it?", to: "owner", startedAt: opened })];
		const animator = new FlowAnimator({ requestRender: () => frame(), reducedMotion: () => false });
		// What the workbench does each frame: draw at the clock, then tell the animator what the frame needs.
		const frame = (): void => {
			const drawn = renderFlowLanes(flow, 80, Date.now());
			if (drawn.motionUntil === undefined) animator.settled();
			else animator.request(drawn.motionUntil);
		};
		frame();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(CARRIER_FLIGHT_MS + FLOW_FRAME_MS * 2);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(10 * 60_000);
		expect(vi.getTimerCount()).toBe(0);
		// A frame drawn by the lane's one-second clock long after still shows the open edge, carrier stepped.
		const late = renderFlowLanes(flow, 80, opened + 10 * 60_000);
		expect(late.motionUntil).toBeUndefined();
		expect(stripAnsi(late.rows.at(-1)!)).toContain("┄");
		expect(stripAnsi(late.rows.at(-1)!)).toContain(CARRIER_GLYPH);
	});

	it("starts no timer under reduced motion", () => {
		vi.useFakeTimers();
		const animator = new FlowAnimator({ requestRender: () => {}, reducedMotion: () => true });
		expect(animator.enabled).toBe(false);
		animator.request(Number.POSITIVE_INFINITY);
		expect(vi.getTimerCount()).toBe(0);
	});
});

function stageRow(stage: DecisionStageRow["stage"], current: boolean): DecisionStageRow {
	return { stage, totalMs: 1000, passMs: current ? 500 : 0, passes: 1, current, loop: 1, events: [] };
}

function modelAt(stage: DecisionStageRow["stage"], nowMs: number): DecisionGraphModel {
	const order: DecisionStageRow["stage"][] = ["understand", "plan", "build", "verify"];
	const stages = order.slice(0, order.indexOf(stage) + 1).map((name) => stageRow(name, name === stage));
	return {
		objectiveId: "obj-1",
		you: { present: false, waiting: false, asked: 0, answered: 0 },
		decider: { owner: "system_one", evaluations: 0, doing: "planning", rootOwned: false },
		stages,
		current: stages.at(-1)!,
		loop: 1,
		plan: [],
		checks: [],
		peerFindings: [],
		participants: [{ id: "root", kind: "root", label: "root", running: true, acted: true }],
		routing: [],
		evidence: { actions: 0, fileEffects: 0, failures: 0 },
		goal: { present: true, branch: "pending" },
		unresolvedDoubtCount: 0,
		hasRunningClock: true,
		turnRunning: true,
		flow: [],
		stageLogEmpty: false,
		nowMs,
	} as DecisionGraphModel;
}

describe("diagram stage transition", () => {
	it("draws one carrier on the spine for the settle window, then none", () => {
		const model = modelAt("build", 10_000);
		const transition = { from: "understand" as const, to: "build" as const, at: 10_000 };
		const plain = renderDecisionDiagram(model, 60).rows.map((row) => stripAnsi(row));
		const during = renderDecisionDiagram(model, 60, transition);
		// The carrier starts on the stage the loop left: exactly one row differs from the still frame.
		expect(during.rows.map((row, index) => stripAnsi(row) !== plain[index]).filter(Boolean)).toHaveLength(1);
		expect(during.motionUntil).toBe(10_000 + CARRIER_SETTLE_MS);
		const after = renderDecisionDiagram(modelAt("build", 10_000 + CARRIER_SETTLE_MS), 60, transition);
		expect(after.motionUntil).toBeUndefined();
		const rest = renderDecisionDiagram(model, 60);
		expect(rest.motionUntil).toBeUndefined();
	});

	it("keeps every other row of the diagram unchanged while the carrier is drawn", () => {
		const model = modelAt("build", 10_000);
		const plain = renderDecisionDiagram(model, 60).rows.map((row) => stripAnsi(row));
		const moving = renderDecisionDiagram(model, 60, { from: "understand", to: "build", at: 10_000 }).rows.map((row) =>
			stripAnsi(row),
		);
		const changed = moving.filter((row, index) => row !== plain[index]);
		expect(changed.length).toBeLessThanOrEqual(1);
		expect(moving).toHaveLength(plain.length);
	});

	it("is seen by the pane as the stage changes between frames, and only with motion enabled", () => {
		const pane = new DecisionGraphPane();
		const draw = (model: DecisionGraphModel, motion: boolean) =>
			pane.draw(model, "diagram", 0, 0, 60, 30, [], motion);
		draw(modelAt("understand", 1000), true);
		expect(pane.motionUntil).toBeUndefined();
		draw(modelAt("build", 2000), true);
		expect(pane.motionUntil).toBe(2000 + CARRIER_SETTLE_MS);
		draw(modelAt("build", 2000 + CARRIER_SETTLE_MS), true);
		expect(pane.motionUntil).toBeUndefined();
		draw(modelAt("verify", 5000), false);
		expect(pane.motionUntil).toBeUndefined();
		pane.hide();
		expect(pane.motionUntil).toBeUndefined();
	});
});
