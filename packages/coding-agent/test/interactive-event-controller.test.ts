import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session-contracts.ts";
import {
	handleInteractiveEvent,
	type InteractiveEventHost,
} from "../src/modes/interactive/interactive-event-controller.ts";

describe("interactive delegate worker events", () => {
	it("lets the activity-lane refresh own the single worker-status render", async () => {
		const requestRender = vi.fn();
		const refreshActivityLane = vi.fn(() => requestRender());
		const host = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			footerDataProvider: { setExtensionStatus: vi.fn() },
			refreshActivityLane,
			ui: { requestRender },
		} as unknown as InteractiveEventHost;
		const event: AgentSessionEvent = {
			type: "delegate_workers",
			active: 0,
			queued: 0,
			running: 0,
			completedSinceFlush: 1,
			failedSinceFlush: 0,
			attentionSinceFlush: 0,
			terminalSinceFlush: [{ laneId: "worker-1", status: "succeeded" }],
		};

		await handleInteractiveEvent(host, event);

		expect(refreshActivityLane).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenCalledOnce();
	});
});
