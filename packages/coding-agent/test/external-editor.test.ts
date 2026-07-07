import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalEditorHost } from "../src/modes/interactive/external-editor.ts";
import { openEditorForPath, openExternalEditor } from "../src/modes/interactive/external-editor.ts";

const spawnMock = vi.hoisted(() =>
	vi.fn(() => ({
		on(event: string, handler: (code: number | null) => void) {
			if (event === "close") queueMicrotask(() => handler(0));
			return this;
		},
	})),
);

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

const originalVisual = process.env.VISUAL;
const originalEditor = process.env.EDITOR;

afterEach(() => {
	spawnMock.mockClear();
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
