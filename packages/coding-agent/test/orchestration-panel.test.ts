import { visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { addTaskStep, createTaskStepsState } from "../src/core/tasks/task-state.ts";
import {
	createOrchestrationActivityModel,
	OrchestrationPanelComponent,
	renderOrchestrationPanelLines,
} from "../src/core/tools/orchestration-panel.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("orchestration panel", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders task and worker state through one compact visual hierarchy", () => {
		const lines = renderOrchestrationPanelLines(
			theme,
			{
				label: "workers",
				action: "status",
				status: "running",
				summary: ["1 running", "1 queued"],
				rows: [
					{ status: "running", label: "implementer", section: "Agents", meta: ["profile fast-worker"] },
					{ status: "queued", label: "verifier", section: "Agents" },
				],
				notices: [{ status: "warning", text: "1 mutation awaiting parent review." }],
			},
			80,
		);
		const text = stripAnsi(lines.join("\n"));

		expect(text).toContain("[workers] status");
		expect(text).toContain("1 running · 1 queued");
		expect(text).toContain("Agents");
		expect(text).toContain("● implementer");
		expect(text).toContain("◌ verifier");
		expect(text).toContain("awaiting parent review");
	});

	it("keeps detail progressive and every line inside the available width", () => {
		const model = {
			label: "task steps",
			action: "update",
			status: "warning" as const,
			rows: [
				{
					status: "blocked" as const,
					label: "A long blocked step that must not overflow the terminal viewport",
					meta: ["high priority", "@implementer"],
					details: ["blocker: waiting for a deliberately long external dependency explanation"],
				},
			],
		};
		const collapsed = new OrchestrationPanelComponent(theme, model).render(34);
		const expanded = new OrchestrationPanelComponent(theme, model, true).render(34);

		expect(stripAnsi(collapsed.join("\n"))).not.toContain("blocker:");
		expect(stripAnsi(expanded.join("\n"))).toContain("blocker:");
		for (const line of [...collapsed, ...expanded]) expect(visibleWidth(line)).toBeLessThanOrEqual(34);
	});

	it("builds one event-driven activity view and stays absent when orchestration is idle", () => {
		const empty = createOrchestrationActivityModel(createTaskStepsState("T0"), [
			{ laneId: "worker-old", type: "worker", status: "succeeded" },
		]);
		expect(empty).toBeUndefined();

		let state = addTaskStep(createTaskStepsState("T0"), { content: "Inspect", status: "in_progress" }, "T1");
		state = addTaskStep(state, { content: "Implement" }, "T2");
		const active = createOrchestrationActivityModel(state, [
			{
				laneId: "worker-2",
				type: "worker",
				status: "running",
				label: "Implement clipboard image support",
				profileId: "fast-worker",
			},
		]);
		const text = stripAnsi(
			new OrchestrationPanelComponent(theme, active ?? { label: "missing" }).render(80).join("\n"),
		);

		expect(text).toContain("[work] active");
		expect(text).toContain("2 steps · 1 agent");
		expect(text).toContain("Steps");
		expect(text).toContain("Agents");
		expect(text).toContain("● Inspect");
		expect(text).toContain("● Implement clipboard image support");
		expect(text).toContain("worker-2 · profile fast-worker");
	});
});
