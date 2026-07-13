import { describe, expect, it } from "vitest";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolPanelRegistry } from "../src/modes/interactive/components/tool-panel-registry.ts";

function panel(id: number): ToolExecutionComponent {
	return { id } as unknown as ToolExecutionComponent;
}

describe("ToolPanelRegistry retention", () => {
	it("evicts old reusable panels instead of retaining every long-session action", () => {
		const registry = new ToolPanelRegistry();
		let newest: ToolExecutionComponent | undefined;
		for (let index = 0; index < 257; index++) {
			newest = panel(index);
			registry.register(`call-${index}`, newest, `action-${index}`);
			registry.finish(`call-${index}`);
		}

		expect(registry.getReusable("action-0")).toBeUndefined();
		expect(registry.getReusable("action-256")).toBe(newest);
	});

	it("keeps recently reused panels when the retention bound evicts an entry", () => {
		const registry = new ToolPanelRegistry();
		const first = panel(0);
		for (let index = 0; index < 256; index++) {
			const current = index === 0 ? first : panel(index);
			registry.register(`call-${index}`, current, `action-${index}`);
			registry.finish(`call-${index}`);
		}
		expect(registry.getReusable("action-0")).toBe(first);

		registry.register("call-new", panel(256), "action-new");
		registry.finish("call-new");

		expect(registry.getReusable("action-0")).toBe(first);
		expect(registry.getReusable("action-1")).toBeUndefined();
	});
});
