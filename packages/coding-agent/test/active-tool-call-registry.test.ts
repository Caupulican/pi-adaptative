import { describe, expect, it } from "vitest";
import { ActiveToolCallRegistry } from "../src/modes/interactive/components/active-tool-call-registry.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";

function panel(id: number): ToolExecutionComponent {
	return { id } as unknown as ToolExecutionComponent;
}

describe("ActiveToolCallRegistry", () => {
	it("tracks concurrent calls independently and forgets only the finished call", () => {
		const registry = new ActiveToolCallRegistry();
		const first = panel(1);
		const second = panel(2);
		registry.register("call-1", first);
		registry.register("call-2", second);

		expect(registry.getActive("call-1")).toBe(first);
		expect(registry.getActive("call-2")).toBe(second);
		expect([...registry.activeEntries()]).toEqual([
			["call-1", first],
			["call-2", second],
		]);

		registry.finish("call-1");
		expect(registry.getActive("call-1")).toBeUndefined();
		expect(registry.getActive("call-2")).toBe(second);
	});

	it("clears all active identities without retaining completed presentation state", () => {
		const registry = new ActiveToolCallRegistry();
		registry.register("call-1", panel(1));
		registry.register("call-2", panel(2));

		registry.clearActive();
		expect([...registry.activeEntries()]).toEqual([]);
	});
});
