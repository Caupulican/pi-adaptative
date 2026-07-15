import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalEditorHost } from "../src/modes/interactive/external-editor.ts";
import { openEditorForPath, openExternalEditor } from "../src/modes/interactive/external-editor.ts";
import { parseExternalEditorCommand } from "../src/utils/external-editor-command.ts";

const spawnMock = vi.hoisted(() => vi.fn(() => ({})));
const waitForChildProcessMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("../src/utils/child-process.ts", () => ({
	spawnProcess: spawnMock,
	waitForChildProcess: waitForChildProcessMock,
}));

const originalVisual = process.env.VISUAL;
const originalEditor = process.env.EDITOR;

afterEach(() => {
	spawnMock.mockClear();
	waitForChildProcessMock.mockClear();
	if (originalVisual === undefined) {
		delete process.env.VISUAL;
	} else {
		process.env.VISUAL = originalVisual;
	}
	if (originalEditor === undefined) {
		delete process.env.EDITOR;
	} else {
		process.env.EDITOR = originalEditor;
	}
});

function createHost(): ExternalEditorHost {
	return {
		editor: {
			getText: () => "body",
			getExpandedText: () => "body",
			setText: vi.fn(),
		} as unknown as ExternalEditorHost["editor"],
		ui: {
			stop: vi.fn(),
			start: vi.fn(),
			requestRender: vi.fn(),
		},
		showWarning: vi.fn(),
	};
}

describe("external editor resolution", () => {
	it("preserves quoted Windows executable paths and backslashes", () => {
		expect(parseExternalEditorCommand('"C:\\Program Files\\Microsoft VS Code\\Code.exe" --wait')).toEqual({
			command: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
			args: ["--wait"],
		});
	});

	it("rejects an unterminated quoted command", () => {
		expect(parseExternalEditorCommand('"C:\\Program Files\\Code.exe --wait')).toBeUndefined();
	});

	it("uses VISUAL before EDITOR for the buffer editor", async () => {
		process.env.VISUAL = "visual-editor --wait";
		process.env.EDITOR = "editor-editor --wait";

		await openExternalEditor(createHost());

		expect(spawnMock).toHaveBeenCalledWith("visual-editor", expect.arrayContaining(["--wait"]), expect.any(Object));
	});

	it("uses VISUAL before EDITOR for path editing", async () => {
		process.env.VISUAL = "visual-editor --wait";
		process.env.EDITOR = "editor-editor --wait";

		await expect(openEditorForPath(createHost(), "/tmp/file.txt")).resolves.toBe(true);

		expect(spawnMock).toHaveBeenCalledWith(
			"visual-editor",
			expect.arrayContaining(["--wait", "/tmp/file.txt"]),
			expect.any(Object),
		);
	});
});
