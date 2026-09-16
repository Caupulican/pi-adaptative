import { Container, Text } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ActiveToolCallRegistry } from "../src/modes/interactive/components/active-tool-call-registry.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { WorkbenchComponent } from "../src/modes/interactive/components/workbench.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { WorkbenchController } from "../src/modes/interactive/workbench-controller.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { workbenchToolObservation } from "./fixtures/session-failures.ts";

function fixture() {
	const view = new WorkbenchComponent({
		conversation: new Container(),
		editor: new Container(),
		dock: [],
		brand: "pi",
		viewportRows: () => 30,
	});
	let backgroundCount = 0;
	const registry = new ActiveToolCallRegistry(() => controller.refreshExecution());
	const controller = new WorkbenchController(view, {
		keybindings: new KeybindingsManager(),
		isInteractive: () => true,
		requestRender() {},
		messages: () => [],
		copy: async () => {},
		notice() {},
		activeForegroundCount: () => registry.size,
		activeBackgroundCount: () => backgroundCount,
	});
	return {
		controller,
		registry,
		text: () => stripAnsi(view.render(120).join("\n")),
		setBackground: (count: number) => {
			backgroundCount = count;
			controller.refreshExecution();
		},
	};
}

describe("Workbench lifecycle accounting", () => {
	beforeAll(() => initTheme("dark"));
	it("shows in-flight-only work immediately and removes it on cancellation", () => {
		const f = fixture();
		f.controller.beginCycle(undefined, 1);
		f.registry.register("call", {} as ToolExecutionComponent);
		expect(f.text()).toContain("In flight: 1");
		expect(f.text()).toContain("Completed: 0");
		f.registry.clearActive();
		expect(f.text()).not.toContain("In flight:");
		f.controller.dispose();
	});
	it("labels retained previews as previous while keeping new turn counters current", () => {
		const f = fixture();
		f.controller.beginCycle(undefined, 1);
		f.controller.record(new Text("old evidence"), workbenchToolObservation("old"));
		f.controller.beginCycle(undefined, 2);
		f.registry.register("new", {} as ToolExecutionComponent);
		expect(f.text()).toContain("Previous turn");
		expect(f.text()).toContain("In flight: 1");
		expect(f.text()).toContain("Completed: 0");
		f.controller.dispose();
	});
	it("resets epoch ownership on session reset", () => {
		const f = fixture();
		f.controller.beginCycle(undefined, 1);
		f.controller.reset();
		f.controller.record(new Text("historical"), workbenchToolObservation("history"));
		f.controller.beginCycle(undefined, 1);
		expect(f.text()).toContain("Completed: 0");
		f.controller.dispose();
	});
	it("keeps session background activity visible across submission cycles", () => {
		const f = fixture();
		f.controller.beginCycle(undefined, 1);
		f.setBackground(2);
		f.controller.beginCycle(undefined, 2);
		expect(f.text()).toContain("Background: 2");
		expect(f.text()).toContain("Completed: 0");
		f.setBackground(0);
		expect(f.text()).not.toContain("Background:");
		f.controller.dispose();
	});
});
