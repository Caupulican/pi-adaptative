import { visibleWidth } from "@caupulican/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { addTaskStep, createTaskStepsState, updateTaskStep } from "../src/core/tasks/task-state.ts";
import {
	ActivityLaneComponent,
	formatElapsed,
	projectActivityLane,
	renderActivityLaneLine,
} from "../src/modes/interactive/components/activity-lane.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("activity lane", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("projects current task, workers, and goal into one bounded horizontal line", () => {
		const taskState = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Implement status lane", activeForm: "Implementing status lane", status: "in_progress" },
			"T1",
		);
		const projection = projectActivityLane({
			taskState,
			goalState: {
				goalId: "goal-1",
				userGoal: "Stabilize the harness",
				status: "active",
				requirements: [],
				evidence: [],
				events: [],
				createdAt: "T0",
				updatedAt: "T1",
				lastProgressAt: "T1",
				stallTurns: 0,
			},
			laneRecords: [{ laneId: "worker-1", type: "worker", status: "running", label: "Fast coder" }],
		});
		const lines = renderActivityLaneLine(theme, projection.active, 62);
		const text = stripAnsi(lines.join("\n"));

		expect(lines).toHaveLength(1);
		expect(text).toContain("Implementing status lane");
		// Detached execution is explicitly named; the plan can reclaim the count's width.
		expect(text).toMatch(/●\s+Background work/);
		// The task owns the plan slot; the goal yields to it.
		expect(text).not.toContain("Stabilize the harness");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(62);
	});

	it("names the one running tool as the subject with its elapsed time, and counts tools once there is company", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		const text = () => stripAnsi(lane.render(100).join("\n"));
		lane.start({ id: "runtime:turn", kind: "runtime", label: "Working..." });
		expect(text()).toMatch(/^\s*●\s+Working\.\.\. \(0s\)\s*$/);
		now += 12_000;
		lane.start({ id: "tool:1", kind: "tool", label: "Bash", tag: "bash" });
		expect(text()).toContain("(12s");
		expect(text()).toContain("1 bash");
		now += 72_000;
		expect(text()).toContain("(1m24s");
		expect(text()).toContain("1 bash");
		lane.start({ id: "tool:2", kind: "tool", label: "Bash", tag: "bash" });
		expect(text()).toContain("2 bash");
		expect(text()).toContain("(1m24s");
		expect(text()).not.toContain("Bash (");
		lane.remove("tool:2");
		expect(text()).toContain("(1m24s");
		expect(text()).toContain("1 bash");
		lane.finish("tool:1", "success");
		// Finished tool is the newest event; the turn clock stays so live work does not look stuck.
		expect(text()).toContain("(1m24s");
		expect(text()).toContain("Bash");
		lane.dispose();
		expect(formatElapsed(59_999)).toBe("59s");
		expect(formatElapsed(3_600_000 + 120_000)).toBe("1h02m");
	});

	/**
	 * The row's whole job in the turn slot is "is this stuck". On a slow-first-token provider the
	 * elapsed figure alone cannot say whether the provider has answered at all, so the parenthetical
	 * carries the answer - and only once the wait is long enough to be news, so a fast provider
	 * renders exactly what it always did.
	 */
	it("names the wait for the first token, then what it cost, without disturbing a fast turn", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		const text = () => stripAnsi(lane.render(100).join("\n"));
		lane.start({ id: "runtime:turn", kind: "runtime", label: "Working..." });

		now += 2_000;
		expect(text()).toContain("Working... (2s)");
		expect(text()).not.toContain("no token yet");

		now += 7_000;
		expect(text()).toContain("Working... (9s, no token yet)");

		lane.markFirstToken("runtime:turn");
		now += 14_000;
		expect(text()).toContain("Working... (23s, first 9s)");

		// Idempotent: a later delta must not move the mark forward.
		lane.markFirstToken("runtime:turn");
		expect(text()).toContain("(23s, first 9s)");

		// The mark belongs to the turn: the next turn starts unmarked and silent again.
		lane.remove("runtime:turn");
		lane.start({ id: "runtime:turn", kind: "runtime", label: "Working..." });
		expect(text()).toContain("Working... (0s)");
		now += 9_000;
		expect(text()).toContain("Working... (9s, no token yet)");
		lane.dispose();
	});

	it("a long subject yields width to the timing suffix instead of swallowing it", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		const text = () => stripAnsi(lane.render(100).join("\n"));
		lane.start({ id: "runtime:turn", kind: "runtime", label: "Reading the worker report and the ledger" });
		now += 9_000;
		lane.markFirstToken("runtime:turn");
		now += 14_000;
		const line = text();
		expect(line).toContain("(23s, first 9s)");
		expect(line).toMatch(/Reading[^(]*… \(23s, first 9s\)/);
	});

	it("keeps the first-token phrasing off every item that never waits for a token", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		const text = () => stripAnsi(lane.render(100).join("\n"));
		lane.start({ id: "tool:1", kind: "tool", label: "Bash", tag: "bash" });
		now += 30_000;
		expect(text()).toContain("Bash (30s)");
		expect(text()).not.toContain("no token yet");

		lane.remove("tool:1");
		lane.wait({ id: "runtime:retry", kind: "runtime", label: "Retry 1/3 in 20s" });
		now += 20_000;
		expect(text()).toContain("Retry 1/3 in 20s (20s)");
		expect(text()).not.toContain("no token yet");

		// markFirstToken is a no-op for an item that is not live.
		lane.markFirstToken("runtime:turn");
		expect(text()).not.toContain("first ");
		lane.dispose();
	});

	it("carries the first-token mark across a label change inside the same turn", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		const text = () => stripAnsi(lane.render(100).join("\n"));
		lane.start({ id: "runtime:turn", kind: "runtime", label: "Working..." });
		now += 5_000;
		lane.markFirstToken("runtime:turn");
		now += 5_000;
		// The working indicator toggling re-starts the same live id mid-turn; the clock and the mark
		// both belong to the turn, so both survive it.
		lane.start({ id: "runtime:turn", kind: "runtime", label: "Reading" });
		expect(text()).toContain("Reading (10s, first 5s)");
		lane.update("runtime:turn", "Citing");
		expect(text()).toContain("Citing (10s, first 5s)");
		lane.dispose();
	});

	it("does not replay old terminal state when a resumed session is primed", () => {
		let taskState = addTaskStep(createTaskStepsState("T0"), { content: "Already done" }, "T1");
		const step = taskState.steps[0];
		if (!step) throw new Error("test step missing");
		taskState = updateTaskStep(taskState, step.id, { status: "completed", evidence: ["verified"] }, "T2");
		const lane = new ActivityLaneComponent(theme, () => {});

		lane.replaceCanonical("resumed", { taskState, laneRecords: [] });

		expect(lane.getItems()).toEqual([]);
		lane.dispose();
	});

	it("briefly reports a successful transition, then disappears without polling", () => {
		vi.useFakeTimers();
		let renders = 0;
		const lane = new ActivityLaneComponent(theme, () => {
			renders += 1;
		});
		let taskState = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Verify behavior", status: "in_progress" },
			"T1",
		);
		lane.replaceCanonical("session", { taskState, laneRecords: [] });
		const step = taskState.steps[0];
		if (!step) throw new Error("test step missing");
		taskState = updateTaskStep(taskState, step.id, { status: "completed", evidence: ["passed"] }, "T2");

		lane.updateCanonical("session", { taskState, laneRecords: [] });

		expect(lane.getItems()).toEqual([
			expect.objectContaining({ kind: "task", status: "success", label: "Completed · Verify behavior" }),
		]);
		vi.advanceTimersByTime(2_000);
		expect(lane.getItems()).toEqual([]);
		expect(renders).toBeGreaterThanOrEqual(3);
		lane.dispose();
	});

	it("does not project worker terminals before the delivery owner resolves their read receipt", () => {
		vi.useFakeTimers();
		const lane = new ActivityLaneComponent(theme, () => {});
		lane.replaceCanonical("session", {
			laneRecords: [{ laneId: "worker-1", type: "worker", status: "running", label: "Verifier" }],
		});

		lane.updateCanonical("session", {
			laneRecords: [
				{
					laneId: "worker-1",
					type: "worker",
					status: "failed",
					label: "Verifier",
					completedAt: "T2",
				},
			],
		});

		expect(lane.getItems()).toEqual([]);
		lane.dispose();
	});

	it("shows transient warning announcements and expires them", () => {
		vi.useFakeTimers();
		const lane = new ActivityLaneComponent(theme, () => {});
		const message = 'Provider tool guideline dropped: guidelines budget exhausted: "..."';

		lane.announce(message, "warning");

		expect(lane.getItems()).toEqual([expect.objectContaining({ kind: "notice", label: message, status: "warning" })]);
		vi.advanceTimersByTime(1_999);
		expect(lane.getItems()).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(lane.getItems()).toEqual([]);
		lane.dispose();
	});

	it("projects status-only goal badges and a completion notice", () => {
		const active = createGoalState({ goalId: "active", userGoal: "Keep the objective private", now: "T0" });
		const completed = applyGoalEvent(active, {
			type: "complete_goal",
			now: "T1",
		});

		expect(projectActivityLane({ goalState: active, laneRecords: [] })).toEqual({
			active: [expect.objectContaining({ kind: "goal", status: "active", label: "active" })],
			terminal: [],
		});
		expect(projectActivityLane({ goalState: completed, laneRecords: [] })).toEqual({
			active: [],
			terminal: [expect.objectContaining({ kind: "goal", status: "success", label: "Goal achieved" })],
		});
	});

	it("projects budget-limited goals as terminal while keeping blocked goals live", () => {
		const budgetLimited = applyGoalEvent(createGoalState({ goalId: "budget", userGoal: "Spend less", now: "T0" }), {
			type: "system_stop_goal",
			status: "budget_limited",
			reason: "token ceiling",
			now: "T1",
		});
		const blocked = applyGoalEvent(createGoalState({ goalId: "blocked", userGoal: "Need access", now: "T0" }), {
			type: "block_goal",
			reason: "waiting for owner",
			now: "T1",
		});

		const budgetProjection = projectActivityLane({ goalState: budgetLimited, laneRecords: [] });
		const blockedProjection = projectActivityLane({ goalState: blocked, laneRecords: [] });

		expect(budgetProjection.active).toEqual([]);
		expect(budgetProjection.terminal).toEqual([
			expect.objectContaining({ kind: "goal", status: "neutral", label: "Goal closed" }),
		]);
		expect(blockedProjection.active).toEqual([
			expect.objectContaining({ kind: "goal", status: "waiting", label: "blocked" }),
		]);
		expect(blockedProjection.terminal).toEqual([]);
	});
});

describe("activity lane slots", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("anchors active ages to monotonic time despite wall-clock corrections", () => {
		let wall = 1_000_000;
		let monotonic = 0;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => wall,
			() => monotonic,
		);
		lane.replaceCanonical("session", {
			laneRecords: [
				{ laneId: "w", type: "worker", status: "running", startedAt: new Date(wall - 10_000).toISOString() },
			],
		});
		monotonic += 5_000;
		wall -= 60_000;
		expect(stripAnsi(lane.render(100).join(""))).toContain("15s");
		wall += 120_000;
		monotonic += 5_000;
		expect(stripAnsi(lane.render(100).join(""))).toContain("20s");
		lane.dispose();
	});

	it("unchanged source snapshots are render no-ops and start only one ticker", () => {
		vi.useFakeTimers();
		const render = vi.fn();
		const lane = new ActivityLaneComponent(theme, render);
		const snapshot = { laneRecords: [{ laneId: "w", type: "worker" as const, status: "running" as const }] };
		lane.replaceCanonical("session", snapshot);
		render.mockClear();
		lane.updateCanonical("session", snapshot);
		expect(render).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		lane.reconcileByPrefix("background-tool:", [{ id: "background-tool:a", kind: "tool", label: "A" }]);
		render.mockClear();
		lane.reconcileByPrefix("background-tool:", [{ id: "background-tool:a", kind: "tool", label: "A" }]);
		expect(render).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		lane.dispose();
		expect(vi.getTimerCount()).toBe(0);
		vi.useRealTimers();
	});

	it("settles preparation without agent_start and gives a new submission a fresh clock", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		lane.syncForegroundActivity({ sessionId: "s", epoch: 1, busy: true });
		now += 12_000;
		expect(stripAnsi(lane.render(100).join(""))).toContain("Preparing");
		lane.syncForegroundActivity({ sessionId: "s", busy: false });
		expect(lane.getItems().some((item) => item.id === "runtime:turn")).toBe(false);
		lane.syncForegroundActivity({ sessionId: "s", epoch: 2, busy: true });
		expect(stripAnsi(lane.render(100).join(""))).toContain("(0s)");
		lane.dispose();
	});

	it("visibility changes keep the parent clock and independent background work", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		lane.syncForegroundActivity({ sessionId: "s", epoch: 1, busy: true });
		lane.start({ id: "background-tool:a", kind: "tool", label: "Build" });
		lane.setParentVisible(false);
		now += 12_000;
		expect(stripAnsi(lane.render(100).join(""))).not.toContain("Preparing");
		expect(stripAnsi(lane.render(100).join(""))).toContain("Background work");
		lane.setParentVisible(true);
		expect(stripAnsi(lane.render(100).join(""))).toContain("12s");
		lane.dispose();
	});

	it("running work outranks a parent wait while preserving the parent total clock", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		lane.syncForegroundActivity({ sessionId: "s", epoch: 1, busy: true });
		now += 30_000;
		lane.wait({ id: "runtime:retry", kind: "runtime", label: "Retry waiting" });
		lane.start({ id: "tool:a", kind: "tool", label: "Build" });
		const rendered = stripAnsi(lane.render(100).join(""));
		expect(rendered).toMatch(/● Working/);
		expect(rendered).toContain("30s");
		lane.remove("tool:a");
		expect(stripAnsi(lane.render(100).join(""))).toContain("Retry waiting");
		lane.dispose();
	});

	it("shows Awaiting you for the blocked question invocation, leaving unrelated work active", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		lane.syncForegroundActivity({ sessionId: "s", epoch: 1, busy: true });
		lane.start({ id: "tool:question", kind: "tool", label: "Question" });
		lane.syncHumanInputActivity({ requestId: "q", toolCallId: "question", waiting: true });
		now += 12_000;
		expect(stripAnsi(lane.render(100).join(""))).toContain("Awaiting you");
		lane.start({ id: "tool:build", kind: "tool", label: "Build" });
		expect(stripAnsi(lane.render(100).join(""))).toMatch(/● Working/);
		lane.syncHumanInputActivity({ requestId: "q", toolCallId: "question", waiting: false });
		expect(stripAnsi(lane.render(100).join(""))).not.toContain("Awaiting you");
		lane.dispose();
	});

	it("does not inherit first-observed clocks across sessions that reuse a lane ID", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		const snapshot = { laneRecords: [{ laneId: "w", type: "worker" as const, status: "running" as const }] };
		lane.replaceCanonical("a", snapshot);
		now += 60_000;
		lane.replaceCanonical("a", snapshot);
		expect(stripAnsi(lane.render(100).join(""))).toContain("observed 1m00s");
		lane.replaceCanonical("b", snapshot);
		expect(stripAnsi(lane.render(100).join(""))).toContain("observed 0s");
		lane.dispose();
	});

	it("retains question wait semantics while the parent indicator is hidden", () => {
		const lane = new ActivityLaneComponent(theme, () => {});
		lane.syncForegroundActivity({ sessionId: "s", epoch: 1, busy: true });
		lane.start({ id: "tool:q", kind: "tool", label: "Question" });
		lane.syncHumanInputActivity({ requestId: "q", toolCallId: "q", waiting: true });
		lane.setParentVisible(false);
		expect(stripAnsi(lane.render(100).join(""))).toContain("Awaiting you");
		lane.start({ id: "background-tool:b", kind: "tool", label: "Build" });
		expect(stripAnsi(lane.render(100).join(""))).toContain("Background work");
		lane.syncHumanInputActivity({ requestId: "q", toolCallId: "q", waiting: false });
		expect(stripAnsi(lane.render(100).join(""))).not.toContain("Awaiting you");
		lane.dispose();
	});

	it.each(["background", "worker"] as const)(
		"retains %s admission waits across parent settlement, visibility and a new submission",
		(scope) => {
			vi.useFakeTimers();
			let now = 1_000_000;
			const lane = new ActivityLaneComponent(
				theme,
				() => {},
				2_000,
				() => now,
			);
			lane.syncForegroundActivity({ sessionId: "s", epoch: 1, busy: true });
			lane.wait({ id: `runtime:admission:${scope}:provider`, kind: "runtime", scope, label: `${scope} waiting` });
			lane.wait({ id: "runtime:retry", kind: "runtime", label: "Parent retry" });
			now += 12_000;
			lane.syncForegroundActivity({ sessionId: "s", busy: false });
			lane.setParentVisible(false);
			expect(lane.getItems().some((item) => item.id === "runtime:retry")).toBe(false);
			expect(stripAnsi(lane.render(100).join(""))).toContain(`${scope} waiting (12s)`);
			expect(vi.getTimerCount()).toBe(2); // one active ticker and the parent's bounded terminal transient
			lane.syncForegroundActivity({ sessionId: "s", epoch: 2, busy: true });
			expect(stripAnsi(lane.render(100).join(""))).toContain(`${scope} waiting (12s)`);
			lane.remove(`runtime:admission:${scope}:provider`);
			expect(stripAnsi(lane.render(100).join(""))).not.toContain(`${scope} waiting`);
			expect(vi.getTimerCount()).toBe(1); // hidden parent does not tick
			lane.dispose();
			vi.useRealTimers();
		},
	);

	it("does not claim Done while an independently owned wait remains", () => {
		const lane = new ActivityLaneComponent(theme, () => {});
		lane.syncForegroundActivity({ sessionId: "s", epoch: 1, busy: true });
		lane.wait({
			id: "runtime:admission:background:p",
			kind: "runtime",
			scope: "background",
			label: "Background waiting",
		});
		lane.setForegroundOutcome("success", "Done");
		lane.syncForegroundActivity({ sessionId: "s", busy: false });
		expect(stripAnsi(lane.render(120).join(""))).toContain("Background waiting");
		expect(stripAnsi(lane.render(120).join(""))).not.toContain("Done");
		lane.remove("runtime:admission:background:p");
		expect(stripAnsi(lane.render(120).join(""))).toContain("Done");
		lane.dispose();
	});

	it.each(["background", "worker"] as const)(
		"does not label a %s wait as Parent when only detached work runs",
		(scope) => {
			const lane = new ActivityLaneComponent(theme, () => {});
			lane.start({ id: "background-tool:build", kind: "tool", label: "Build" });
			lane.wait({ id: `runtime:admission:${scope}:p`, kind: "runtime", scope, label: `${scope} request waiting` });
			const text = stripAnsi(lane.render(120).join(""));
			expect(text).toContain("Background work");
			expect(text).toContain(`${scope} request waiting`);
			expect(text).not.toContain("Parent");
			lane.dispose();
		},
	);

	it("keeps a state and clock at narrow width and freezes terminal duration", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		lane.syncForegroundActivity({ sessionId: "s", epoch: 1, busy: true });
		lane.update("runtime:turn", "非常に長い作業中のラベル");
		now += 12_000;
		expect(stripAnsi(lane.render(20).join(""))).toContain("12s");
		expect(stripAnsi(lane.render(20).join(""))).toContain("Working");
		lane.setForegroundOutcome("success", "Done");
		lane.syncForegroundActivity({ sessionId: "s", busy: false });
		now += 1_000;
		expect(stripAnsi(lane.render(100).join(""))).toContain("Done (12s)");
		lane.dispose();
	});

	it("resets the queued phase once on admission and gives a reused specialist a new lane clock", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		lane.replaceCanonical("s", {
			laneRecords: [{ laneId: "w1", type: "worker", label: "Reviewer", status: "queued" }],
		});
		now += 30_000;
		const snapshot = {
			laneRecords: [
				{
					laneId: "w1",
					type: "worker" as const,
					label: "Reviewer",
					status: "running" as const,
					startedAt: new Date(now).toISOString(),
				},
			],
		};
		lane.updateCanonical("s", snapshot);
		expect(stripAnsi(lane.render(100).join(""))).toContain("oldest 0s");
		now += 10_000;
		lane.updateCanonical("s", snapshot);
		expect(stripAnsi(lane.render(100).join(""))).toContain("oldest 10s");
		lane.updateCanonical("s", {
			laneRecords: [{ ...snapshot.laneRecords[0], laneId: "w2", startedAt: new Date(now).toISOString() }],
		});
		expect(stripAnsi(lane.render(100).join(""))).toContain("oldest 0s");
		lane.dispose();
	});

	it.each([undefined, "broken", new Date(2_000_000).toISOString()])(
		"uses observed age for missing or invalid background origin %s",
		(originAt) => {
			let now = 1_000_000;
			const lane = new ActivityLaneComponent(
				theme,
				() => {},
				2_000,
				() => now,
			);
			lane.reconcileByPrefix("background-tool:", [
				{ id: "background-tool:a", kind: "tool", label: "Build", originAt },
			]);
			now += 12_000;
			expect(stripAnsi(lane.render(100).join(""))).toContain("observed 12s");
			lane.dispose();
		},
	);

	it("preserves pre-handoff duration while rejecting malformed duration claims", () => {
		const now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		lane.reconcileByPrefix("background-tool:", [
			{
				id: "background-tool:a",
				kind: "tool",
				label: "Build",
				originAt: new Date(now - 10_000).toISOString(),
				elapsedBeforeMs: 30_000,
			},
		]);
		expect(stripAnsi(lane.render(100).join(""))).toContain("oldest 40s");
		for (const elapsedBeforeMs of [-1, NaN, Infinity]) {
			lane.reconcileByPrefix("background-tool:", [
				{
					id: `background-tool:${elapsedBeforeMs}`,
					kind: "tool",
					label: "Build",
					originAt: new Date(now).toISOString(),
					elapsedBeforeMs,
				},
			]);
			expect(stripAnsi(lane.render(100).join(""))).toContain("observed 0s");
		}
		lane.dispose();
	});

	it.each([0, 1, 8, 32])("bounds timed refresh and unchanged reconciliation for %i active entities", (count) => {
		vi.useFakeTimers();
		const render = vi.fn();
		const lane = new ActivityLaneComponent(theme, render);
		const snapshot = {
			laneRecords: Array.from({ length: count }, (_, index) => ({
				laneId: `w${index}`,
				type: "worker" as const,
				status: "running" as const,
			})),
		};
		lane.replaceCanonical("s", snapshot);
		render.mockClear();
		for (let i = 0; i < 100; i++) lane.updateCanonical("s", snapshot);
		expect(render).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(count ? 1 : 0);
		vi.advanceTimersByTime(1_000);
		expect(render).toHaveBeenCalledTimes(count ? 1 : 0);
		lane.dispose();
		vi.advanceTimersByTime(2_000);
		expect(vi.getTimerCount()).toBe(0);
		vi.useRealTimers();
	});

	const runtimeTurn = (label: string) => ({
		id: "runtime:turn",
		kind: "runtime" as const,
		label,
		status: "active" as const,
	});
	const tool = (id: string, tag: string) => ({
		id: `background-tool:${id}`,
		kind: "tool" as const,
		label: `${tag} work ${id}`,
		status: "active" as const,
		tag,
	});
	const render = (items: Parameters<typeof renderActivityLaneLine>[1], width: number) =>
		stripAnsi(renderActivityLaneLine(theme, items, width).join("\n"));

	it("puts the live turn label in the turn slot and keeps the task step in the plan slot", () => {
		const taskState = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Audit reconcile flow", activeForm: "Auditing reconcile flow", status: "in_progress" },
			"T1",
		);
		const items = [
			runtimeTurn("Confirming duplicate charge risk"),
			...projectActivityLane({ taskState, laneRecords: [] }).active,
		];
		const text = render(items, 100);

		expect(text).toMatch(/●\s+Confirming duplicate charge risk/);
		expect(text).toContain("Step 1/1 · Auditing reconcile flow");
		expect(text).not.toMatch(/●\s+working\s+Step/);
	});

	it("shows the live working message in the turn slot when no task exists", () => {
		const text = render([runtimeTurn("Confirming duplicate charge risk")], 80);
		expect(text).toMatch(/^\s*●\s+Confirming duplicate charge risk\s*$/);
		expect(text).not.toMatch(/●\s+working\s+Confirming/);
	});

	it("aggregates concurrent tools by tag with a bounded group count", () => {
		const items = [
			runtimeTurn("Working..."),
			tool("1", "bash"),
			tool("2", "bash"),
			tool("3", "python"),
			tool("4", "ruby"),
			tool("5", "node"),
		];
		const text = render(items, 100);
		expect(text).toContain("2 bash");
		expect(text).toContain("1 python");
		expect(text).toContain("+1");
		expect(text).not.toContain("tool-task");
	});

	it("separates running and queued agents in the shared counter line", () => {
		const items = projectActivityLane({
			laneRecords: [
				{ laneId: "worker-1", type: "worker", status: "running" },
				{ laneId: "worker-2", type: "worker", status: "running" },
				{ laneId: "worker-3", type: "worker", status: "queued" },
			],
		}).active;
		const text = render(items, 100);

		expect(text).toContain("2 agents running");
		expect(text).toContain("1 agent queued");
	});

	it("normalizes equivalent foreground and background tool tags through one aggregation path", () => {
		const items = [
			{ ...tool("foreground", " Read__File "), id: "tool:foreground" },
			tool("background", "read--file"),
			tool("spaced", "READ  FILE"),
		];
		const text = render(items, 100);

		expect(text).toContain("3 read file");
		expect(text).not.toContain("read_file");
	});

	it("falls back to the activity kind when tag normalization is empty", () => {
		const text = render([tool("empty", " _--_ "), tool("blank", "   ")], 100);

		expect(text).toContain("2 tool");
	});

	it("shows only the newest terminal event and keeps load-bearing runtime labels in the turn slot", () => {
		const items = [
			{ id: "e1", kind: "tool" as const, label: "Old finish", status: "success" as const },
			{ id: "e2", kind: "tool" as const, label: "New finish", status: "failure" as const },
			{ id: "runtime:retry", kind: "runtime" as const, label: "Retry 2/5 in 3s", status: "waiting" as const },
		];
		const text = render(items, 90);
		expect(text).toContain("Retry 2/5 in 3s");
		expect(text).toContain("New finish");
		expect(text).not.toContain("Old finish");
	});

	it("drops right slots before squeezing the plan slot, and never exceeds the width", () => {
		const taskState = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "A fairly long step description that needs room", status: "in_progress" },
			"T1",
		);
		const items = [
			runtimeTurn("Working..."),
			tool("1", "bash"),
			tool("2", "python"),
			{ id: "e", kind: "tool" as const, label: "Bash finished", status: "success" as const },
			...projectActivityLane({ taskState, laneRecords: [] }).active,
		];
		for (const width of [24, 32, 40, 56, 72, 120]) {
			const lines = renderActivityLaneLine(theme, items, width);
			expect(lines.length).toBeLessThanOrEqual(1);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const narrow = render(items, 40);
		expect(narrow).toContain("Step 1/1");
		expect(narrow).not.toContain("Bash finished");
	});

	it("keeps the queued-messages label visible in the right block", () => {
		const items = [
			runtimeTurn("Working..."),
			{ id: "queue:messages", kind: "queue" as const, label: "Queued 2 · 1 steering", status: "waiting" as const },
		];
		const text = render(items, 80);
		expect(text).toContain("Queued 2 · 1 steering");
	});

	it("keeps queued-message state visible beside an active plan at narrow widths", () => {
		const taskState = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "A fairly long authoritative task description", status: "in_progress" },
			"T1",
		);
		const items = [
			runtimeTurn("Working..."),
			{
				id: "queue:messages",
				kind: "queue" as const,
				label: "Queued 2 · 1 steering · Alt+Up edit",
				status: "waiting" as const,
			},
			...projectActivityLane({ taskState, laneRecords: [] }).active,
		];
		const lines = renderActivityLaneLine(theme, items, 69);
		const text = stripAnsi(lines.join("\n"));

		expect(text).toContain("Step 1/1");
		expect(text).toContain("Queued 2");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(69);
	});

	it("keeps a worker clock after the parent turn ends", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		lane.replaceCanonical("review", {
			laneRecords: [
				{
					laneId: "w1",
					type: "worker",
					status: "running",
					label: "Review",
					startedAt: new Date(now).toISOString(),
				},
			],
		});
		lane.start({ id: "runtime:turn", kind: "runtime", label: "Working..." });
		now += 60_000;
		expect(stripAnsi(lane.render(100).join("\n"))).toContain("(1m");
		lane.finish("runtime:turn", "success");
		now += 60_000;
		const text = stripAnsi(lane.render(100).join("\n"));
		expect(text).toContain("Background work");
		expect(text).toContain("oldest 2m");
		lane.dispose();
	});

	it("does not treat a pending plan as working", () => {
		const taskState = addTaskStep(createTaskStepsState("T0"), { content: "Queued work", status: "pending" }, "T1");
		const text = stripAnsi(
			renderActivityLaneLine(theme, projectActivityLane({ taskState, laneRecords: [] }).active, 80).join("\n"),
		);
		expect(text).not.toContain("Working");
		expect(text).not.toMatch(/\(\d+[smh]/);
	});

	it("preserves background-tool clocks across reconcile", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		lane.reconcileByPrefix("background-tool:", [
			{
				id: "background-tool:a",
				kind: "tool",
				label: "Long build",
				tag: "bash",
				originAt: new Date(now).toISOString(),
			},
		]);
		now += 30_000;
		lane.reconcileByPrefix("background-tool:", [
			{
				id: "background-tool:a",
				kind: "tool",
				label: "Long build",
				tag: "bash",
				originAt: new Date(now - 30_000).toISOString(),
			},
			{
				id: "background-tool:b",
				kind: "tool",
				label: "Second build",
				tag: "bash",
				originAt: new Date(now).toISOString(),
			},
		]);
		now += 10_000;
		const text = stripAnsi(lane.render(100).join("\n"));
		expect(text).toContain("oldest 40s");
		lane.dispose();
	});

	it("labels an unknown worker origin as observed", () => {
		let now = 1_000_000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2_000,
			() => now,
		);
		lane.replaceCanonical("review", {
			laneRecords: [{ laneId: "w1", type: "worker", status: "running", label: "Review" }],
		});
		now += 12_000;
		expect(stripAnsi(lane.render(100).join("\n"))).toContain("observed 12s");
		lane.dispose();
	});
});
