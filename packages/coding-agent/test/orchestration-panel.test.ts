import { visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	OrchestrationPanelComponent,
	renderOrchestrationPanelLines,
	renderOrchestrationToolResult,
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
					{ status: "partial", label: "review pending", section: "Agents" },
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
		expect(text).toContain("! review pending");
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

	it("owns partial, collapsed, and expanded tool-result projection without deciding tool policy", () => {
		const model = {
			label: "workers",
			status: "running" as const,
			rows: [{ status: "running" as const, label: "worker-1", details: ["bounded detail"] }],
		};

		expect(
			renderOrchestrationToolResult(theme, model, {
				isPartial: true,
				collapse: false,
				expanded: true,
			}).render(80),
		).toEqual([]);
		expect(
			renderOrchestrationToolResult(theme, model, {
				isPartial: false,
				collapse: true,
				expanded: true,
			}).render(80),
		).toEqual([]);

		const collapsed = stripAnsi(
			renderOrchestrationToolResult(theme, model, {
				isPartial: false,
				collapse: false,
				expanded: false,
			})
				.render(80)
				.join("\n"),
		);
		const expanded = stripAnsi(
			renderOrchestrationToolResult(theme, model, {
				isPartial: false,
				collapse: false,
				expanded: true,
			})
				.render(80)
				.join("\n"),
		);
		expect(collapsed).not.toContain("bounded detail");
		expect(expanded).toContain("bounded detail");
	});
});
