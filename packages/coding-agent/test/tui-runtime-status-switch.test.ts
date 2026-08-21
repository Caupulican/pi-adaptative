import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { Container, type Loader, type TUI } from "@caupulican/pi-tui";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	RuntimeStatusController,
	type RuntimeStatusControllerHost,
} from "../src/modes/interactive/runtime-status-controller.ts";

type RuntimeSwitchFixture = {
	controller: RuntimeStatusController;
	activityLane: {
		remove(id: string): void;
		start(options: { id: string; kind: string; label: string }): void;
		update(id: string, label: string): void;
	};
};

function createHost(): RuntimeSwitchFixture {
	const loader = { stop: vi.fn() };
	const activityLane = { remove: vi.fn(), start: vi.fn(), update: vi.fn() };
	const host: RuntimeStatusControllerHost = {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		statusContainer: new Container(),
		activityLane: activityLane as unknown as RuntimeStatusControllerHost["activityLane"],
		hasHumanAudience: true,
		isStreaming: () => true,
		isThinkingHidden: () => true,
	};
	const controller = new RuntimeStatusController(host);
	controller.createWorkingLoader = vi.fn(() => loader as unknown as Loader);
	controller.updateRuntimeStatus(fauxAssistantMessage([{ type: "thinking", thinking: "private reasoning" }]));
	return { controller, activityLane };
}

describe("InteractiveMode runtime status renderer switches", () => {
	let fixture: RuntimeSwitchFixture;

	beforeEach(() => {
		fixture = createHost();
	});

	test("preserves hidden-thinking status when switching to a loader and back", () => {
		fixture.controller.setWorkingIndicator({ frames: [] });

		expect(fixture.activityLane.remove).toHaveBeenCalledWith("runtime:turn");

		fixture.controller.setWorkingIndicator(undefined);

		expect(fixture.activityLane.start).toHaveBeenCalledWith({
			id: "runtime:turn",
			kind: "runtime",
			label: "Thinking...",
		});
	});

	test("preserves the current status while hiding and restoring the activity lane", () => {
		fixture.controller.setWorkingVisible(false);

		fixture.controller.setWorkingVisible(true);

		expect(fixture.activityLane.start).toHaveBeenCalledWith({
			id: "runtime:turn",
			kind: "runtime",
			label: "Thinking...",
		});
	});
});
