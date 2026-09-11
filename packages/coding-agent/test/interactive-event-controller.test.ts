import type { AssistantMessage, AssistantMessageEvent } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session-contracts.ts";
import {
	handleInteractiveEvent,
	type InteractiveEventHost,
} from "../src/modes/interactive/interactive-event-controller.ts";

describe("interactive delegate worker events", () => {
	it("passes invocation identity and evidence, not only a display error flag, to reporting", async () => {
		const record = vi.fn();
		const details = {
			piToolInvocation: { version: 1, requestId: "fixture", execution: "unknown", postprocessingFailures: [] },
		};
		const host = {
			isInitialized: true,
			footer: { invalidate() {} },
			ui: { requestRender() {} },
			workbench: { record, afterTool: vi.fn() },
			activeToolCalls: { getActive: () => undefined },
		} as unknown as InteractiveEventHost;
		await handleInteractiveEvent(host, {
			type: "tool_execution_end",
			toolName: "fixture",
			toolCallId: "fixture-call",
			isError: true,
			result: { content: [], details },
		});
		expect(record).toHaveBeenCalledExactlyOnceWith(undefined, { toolCallId: "fixture-call", isError: true, details });
	});

	it("routes a background terminal custom message through the same report owner", async () => {
		const recordBackground = vi.fn();
		const message = {
			role: "custom" as const,
			customType: "background-tool-completion",
			content: "fixture",
			display: true,
			timestamp: 0,
			details: {},
		};
		const host = {
			isInitialized: true,
			footer: { invalidate() {} },
			ui: { requestRender() {} },
			workbench: { recordBackground },
			addMessageToChat: vi.fn(),
		} as unknown as InteractiveEventHost;
		await handleInteractiveEvent(host, { type: "message_start", message });
		expect(recordBackground).toHaveBeenCalledExactlyOnceWith(message);
	});
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

	/**
	 * Time-to-first-token is the operator's only way to tell "the provider has not answered" from
	 * "it is writing". The mark must land on the first event that carries produced content and on
	 * nothing else - a framing event or an empty delta would report a token that never arrived.
	 */
	it("marks the turn's first token on the first content delta and never on framing events", async () => {
		const markFirstToken = vi.fn();
		const host = {
			isInitialized: true,
			footer: { invalidate() {} },
			ui: { requestRender() {} },
			activityLane: { markFirstToken },
			streamingComponent: undefined,
		} as unknown as InteractiveEventHost;
		const partial = { role: "assistant" as const, content: [] } as unknown as AssistantMessage;
		const update = (assistantMessageEvent: AssistantMessageEvent): AgentSessionEvent =>
			({ type: "message_update", message: partial, assistantMessageEvent }) as AgentSessionEvent;

		await handleInteractiveEvent(host, update({ type: "text_start", contentIndex: 0, partial }));
		await handleInteractiveEvent(host, update({ type: "text_delta", contentIndex: 0, delta: "", partial }));
		expect(markFirstToken).not.toHaveBeenCalled();

		await handleInteractiveEvent(host, update({ type: "text_delta", contentIndex: 0, delta: "he", partial }));
		await handleInteractiveEvent(host, update({ type: "thinking_delta", contentIndex: 0, delta: "llo", partial }));

		// Marking on every delta is deliberate: the lane itself keeps the first stamp, so the
		// controller never has to remember whether this turn has already been marked.
		expect(markFirstToken.mock.calls).toEqual([["runtime:turn"], ["runtime:turn"]]);
	});

	it("leaves a user-message update alone", async () => {
		const markFirstToken = vi.fn();
		const host = {
			isInitialized: true,
			footer: { invalidate() {} },
			ui: { requestRender() {} },
			activityLane: { markFirstToken },
		} as unknown as InteractiveEventHost;
		const partial = { role: "user" as const, content: [] } as unknown as AssistantMessage;
		await handleInteractiveEvent(host, {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial },
		} as AgentSessionEvent);
		expect(markFirstToken).not.toHaveBeenCalled();
	});
});
