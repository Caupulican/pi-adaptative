import { describe, expect, test, vi } from "vitest";
import { flushCompactionQueue } from "../src/modes/interactive/compaction-queue.ts";
import {
	handleInteractiveEvent,
	type InteractiveEventHost,
} from "../src/modes/interactive/interactive-event-controller.ts";

describe("InteractiveMode compaction events", () => {
	test.each([
		{
			name: "agent start",
			event: { type: "agent_start" as const },
		},
		{
			name: "retry end",
			event: { type: "auto_retry_end" as const, success: true, attempt: 1, finalError: undefined },
		},
	])("restores retry controls on $name", async ({ event }) => {
		const originalEscape = vi.fn();
		const dispose = vi.fn();
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			retryEscapeHandler: originalEscape as (() => void) | undefined,
			retryCountdown: { dispose } as unknown,
			defaultEditor: { onEscape: vi.fn() },
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			activityLane: { remove: vi.fn(), finish: vi.fn() },
			clearActiveToolCalls: vi.fn(),
			stopWorkingLoader: vi.fn(),
			workingVisible: false,
			showError: vi.fn(),
		};

		await handleInteractiveEvent(fakeThis as unknown as InteractiveEventHost, event);

		expect(fakeThis.defaultEditor.onEscape).toBe(originalEscape);
		expect(fakeThis.retryEscapeHandler).toBeUndefined();
		expect(fakeThis.retryCountdown).toBeUndefined();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	test("flushes queued compaction prompts as steering when the agent is still streaming", async () => {
		const prompt = vi.fn().mockResolvedValue(undefined);
		const fakeThis = {
			compactionQueuedMessages: [{ text: "verify the image", mode: "steer" as const, images: undefined }],
			session: {
				isStreaming: true,
				prompt,
				followUp: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				clearQueue: vi.fn(),
			},
			isExtensionCommand: vi.fn(() => false),
			updatePendingMessagesDisplay: vi.fn(),
			// flushCompactionQueue refreshes the footer in a fire-and-forget .finally();
			// without this stub the TypeError escapes as an unhandled rejection AFTER the
			// test resolves and fails the whole suite run.
			refreshAutonomyFooterStatus: vi.fn(),
			showError: vi.fn(),
		};
		await flushCompactionQueue(fakeThis, { willRetry: false });

		expect(prompt).toHaveBeenCalledWith("verify the image", { images: undefined, streamingBehavior: "steer" });
		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
	});

	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
		const fakeThis = {
			isInitialized: true,
			tuiHistoryLoaded: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			resetLiveTuiHistoryTrim: vi.fn(),
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			refreshAutonomyFooterStatus: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		await handleInteractiveEvent(fakeThis as unknown as InteractiveEventHost, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
				firstKeptEntryId: "entry-1",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).not.toHaveBeenCalled();
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});
});
