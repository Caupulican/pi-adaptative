import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode compaction events", () => {
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
		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

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

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
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
