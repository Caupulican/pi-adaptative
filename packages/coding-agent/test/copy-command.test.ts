import { describe, expect, it, vi } from "vitest";

const copyToClipboardMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/utils/clipboard.ts", () => ({ copyToClipboard: copyToClipboardMock }));

const { handleCopyCommand } = await import("../src/modes/interactive/session-io-commands.ts");

describe("handleCopyCommand (P1h/P1k)", () => {
	it("copies the last assistant message when no selection override is supplied", async () => {
		copyToClipboardMock.mockClear();
		const showStatus = vi.fn();
		const showError = vi.fn();

		await handleCopyCommand({
			session: { getLastAssistantText: () => "last answer" },
			showError,
			showStatus,
		});

		expect(copyToClipboardMock).toHaveBeenCalledWith("last answer");
		expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});

	it("copies the active selection instead of the last assistant message when one is present", async () => {
		copyToClipboardMock.mockClear();
		const showStatus = vi.fn();

		await handleCopyCommand({
			session: { getLastAssistantText: () => "last answer" },
			showError: vi.fn(),
			showStatus,
			getSelectionText: () => "the highlighted /tree entry",
		});

		expect(copyToClipboardMock).toHaveBeenCalledWith("the highlighted /tree entry");
		expect(showStatus).toHaveBeenCalledWith("Copied selection to clipboard");
	});

	it("falls back to the last assistant message when the selection getter returns undefined", async () => {
		copyToClipboardMock.mockClear();
		const showStatus = vi.fn();

		await handleCopyCommand({
			session: { getLastAssistantText: () => "last answer" },
			showError: vi.fn(),
			showStatus,
			getSelectionText: () => undefined,
		});

		expect(copyToClipboardMock).toHaveBeenCalledWith("last answer");
		expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
	});

	it("shows an error and copies nothing when there is neither a selection nor a last assistant message", async () => {
		copyToClipboardMock.mockClear();
		const showError = vi.fn();

		await handleCopyCommand({
			session: { getLastAssistantText: () => undefined },
			showError,
			showStatus: vi.fn(),
			getSelectionText: () => undefined,
		});

		expect(copyToClipboardMock).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("No agent messages to copy yet.");
	});
});
