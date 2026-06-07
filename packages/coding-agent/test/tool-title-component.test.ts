import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import {
	renderTitleBadge,
	renderToolTitle,
	TitleBadgeComponent,
	ToolTitleComponent,
} from "../src/modes/interactive/components/tool-title.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("TitleBadgeComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders a reusable bracketed title with action and details", () => {
		const text = stripAnsi(
			renderTitleBadge(theme, {
				label: "background script",
				icon: "◆",
				action: "status",
				details: ["job-123", { text: "running", color: "success" }],
				status: "running",
			}),
		);

		expect(text).toBe("◆ [background script] status job-123 running");
	});

	test("keeps tool-title aliases for tool-specific code", () => {
		const text = stripAnsi(renderToolTitle(theme, { label: "tool", action: "start" }));
		const component = new ToolTitleComponent(theme, { label: "tool" });

		expect(text).toBe("[tool] start");
		expect(stripAnsi(component.render(80).join(""))).toBe("[tool]");
	});

	test("uses theme-balanced status colors for failure, persistent, and success states", () => {
		const failed = renderTitleBadge(theme, { label: "tool", action: "failed", status: "failed" });
		const persistent = renderTitleBadge(theme, { label: "assistant", action: "persistent", status: "persistent" });
		const success = renderTitleBadge(theme, { label: "tool", action: "done", status: "success" });

		expect(failed).toContain(theme.fg("error", theme.bold("[tool]")));
		expect(failed).toContain(theme.fg("error", "failed"));
		expect(persistent).toContain(theme.fg("warning", theme.bold("[assistant]")));
		expect(persistent).toContain(theme.fg("warning", "persistent"));
		expect(success).toContain(theme.fg("success", theme.bold("[tool]")));
		expect(success).toContain(theme.fg("success", "done"));
	});

	test("bounds rendered width to avoid TUI overflow", () => {
		const component = new TitleBadgeComponent(theme, {
			label: "background script",
			action: "logs",
			details: ["very-long-background-job-name-that-must-truncate"],
			status: "success",
		});

		const [line] = component.render(24);
		expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(24);
		expect(stripAnsi(line ?? "")).toContain("[background script]");
	});
});
