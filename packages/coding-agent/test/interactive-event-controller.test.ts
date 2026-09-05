import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session-contracts.ts";
import {
	handleInteractiveEvent,
	type InteractiveEventHost,
} from "../src/modes/interactive/interactive-event-controller.ts";

describe("interactive delegate worker events", () => {
	it("attaches a tool synchronously even when workspace observation is pending", async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const component = { updateArgs: vi.fn(), markExecutionStarted: vi.fn(), setArgsComplete: vi.fn() };
		const attach = vi.fn(() => component);
		const host = {
			isInitialized: true,
			footer: { invalidate() {} },
			session: { sessionManager: { getCwd: () => "/fixture" } },
			workbench: { beforeTool: () => pending },
			ui: { requestRender() {} },
			activeToolCalls: { getActive: () => undefined },
			attachToolExecutionComponent: attach,
			updateRuntimeStatus() {},
		} as unknown as InteractiveEventHost;
		const event = handleInteractiveEvent(host, {
			type: "tool_execution_start",
			toolName: "python",
			toolCallId: "fast",
			args: {},
		});
		try {
			expect(attach).toHaveBeenCalledOnce();
		} finally {
			release?.();
			await event;
		}
	});
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
