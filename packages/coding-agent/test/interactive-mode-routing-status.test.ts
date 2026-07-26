import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

/**
 * routing_start/routing_end bracket the
 * gap between the prompt painting and the turn actually starting to stream (see agent-session.ts).
 * These tests drive InteractiveMode.prototype.handleEvent directly against a fake `this`, mirroring
 * the established pattern in interactive-mode-compaction.test.ts, so they don't need a full
 * terminal/theme stack.
 */
describe("InteractiveMode routing_start/routing_end status lane", () => {
	function callHandleEvent(fakeThis: unknown, event: { type: "routing_start" } | { type: "routing_end" }) {
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "routing_start" } | { type: "routing_end" },
		) => Promise<void>;
		return handleEvent.call(fakeThis, event);
	}

	test("routing_start reports through the shared activity lane by default", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: { isStreaming: false },
			loadingAnimation: undefined as { stop: () => void } | undefined,
			workingVisible: true,
			workingIndicatorOptions: undefined,
			activityLane: { start: vi.fn() },
			createWorkingLoader: vi.fn(() => ({ stop: vi.fn() })),
			statusContainer: { addChild: vi.fn(), clear: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		await callHandleEvent(fakeThis, { type: "routing_start" });

		expect(fakeThis.activityLane.start).toHaveBeenCalledWith({
			id: "runtime:routing",
			kind: "runtime",
			label: "Routing",
		});
		expect(fakeThis.createWorkingLoader).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
	});

	test("routing_start preserves an extension-provided custom working indicator", async () => {
		const loader = { stop: vi.fn() };
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: { isStreaming: false },
			loadingAnimation: undefined as { stop: () => void } | undefined,
			workingVisible: true,
			workingIndicatorOptions: {},
			activityLane: { start: vi.fn() },
			createWorkingLoader: vi.fn(() => loader),
			statusContainer: { addChild: vi.fn(), clear: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		await callHandleEvent(fakeThis, { type: "routing_start" });

		expect(fakeThis.statusContainer.addChild).toHaveBeenCalledWith(loader);
		expect(fakeThis.loadingAnimation).toBe(loader);
		expect(fakeThis.activityLane.start).not.toHaveBeenCalled();
	});

	test("routing_start does not start a second loader when one is already showing (no double-spinner)", async () => {
		const existingLoader = { stop: vi.fn() };
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: { isStreaming: false },
			loadingAnimation: existingLoader as { stop: () => void } | undefined,
			workingVisible: true,
			workingIndicatorOptions: undefined,
			activityLane: { start: vi.fn() },
			createWorkingLoader: vi.fn(() => ({ stop: vi.fn() })),
			statusContainer: { addChild: vi.fn(), clear: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		await callHandleEvent(fakeThis, { type: "routing_start" });

		expect(fakeThis.createWorkingLoader).not.toHaveBeenCalled();
		expect(fakeThis.activityLane.start).not.toHaveBeenCalled();
		expect(fakeThis.loadingAnimation).toBe(existingLoader);
	});

	test("routing_start respects workingVisible=false (user has hidden the working indicator)", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: { isStreaming: false },
			loadingAnimation: undefined as { stop: () => void } | undefined,
			workingVisible: false,
			workingIndicatorOptions: undefined,
			activityLane: { start: vi.fn() },
			createWorkingLoader: vi.fn(() => ({ stop: vi.fn() })),
			statusContainer: { addChild: vi.fn(), clear: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		await callHandleEvent(fakeThis, { type: "routing_start" });

		expect(fakeThis.createWorkingLoader).not.toHaveBeenCalled();
		expect(fakeThis.activityLane.start).not.toHaveBeenCalled();
		expect(fakeThis.loadingAnimation).toBeUndefined();
	});

	test("routing_end stops the working loader unconditionally", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			stopWorkingLoader: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await callHandleEvent(fakeThis, { type: "routing_end" });

		expect(fakeThis.stopWorkingLoader).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
	});
});
