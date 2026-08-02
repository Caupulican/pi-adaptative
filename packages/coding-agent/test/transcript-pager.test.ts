import type { Component } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TranscriptPager } from "../src/modes/interactive/components/transcript-pager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark", false));

class MutableTranscript implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return [...this.lines];
	}
	invalidate(): void {}
}

function contentLines(pager: TranscriptPager): string[] {
	return pager
		.render(48)
		.slice(1, -1)
		.map((line) => stripAnsi(line).trimEnd());
}

describe("TranscriptPager", () => {
	it("keeps the viewed top stable when live output arrives after scrolling up", () => {
		const transcript = new MutableTranscript(Array.from({ length: 12 }, (_, index) => `line ${index}`));
		const pager = new TranscriptPager({
			source: transcript,
			viewportRows: () => 6,
			keybindings: new KeybindingsManager(),
			onClose: vi.fn(),
		});

		expect(contentLines(pager)).toEqual(["line 8", "line 9", "line 10", "line 11"]);
		pager.handleInput("\x1b[A");
		pager.handleInput("\x1b[A");
		expect(contentLines(pager)).toEqual(["line 6", "line 7", "line 8", "line 9"]);

		transcript.lines.push("line 12", "line 13");
		expect(contentLines(pager)).toEqual(["line 6", "line 7", "line 8", "line 9"]);
	});

	it("resumes following only after jumping to the live tail", () => {
		const transcript = new MutableTranscript(Array.from({ length: 8 }, (_, index) => `line ${index}`));
		const pager = new TranscriptPager({
			source: transcript,
			viewportRows: () => 5,
			keybindings: new KeybindingsManager(),
			onClose: vi.fn(),
		});

		pager.handleInput("\x1b[H");
		expect(contentLines(pager)).toEqual(["line 0", "line 1", "line 2"]);
		transcript.lines.push("line 8");
		expect(contentLines(pager)).toEqual(["line 0", "line 1", "line 2"]);

		pager.handleInput("\x1b[F");
		expect(contentLines(pager)).toEqual(["line 6", "line 7", "line 8"]);
		transcript.lines.push("line 9");
		expect(contentLines(pager)).toEqual(["line 7", "line 8", "line 9"]);
	});

	it("closes through the configurable transcript action", () => {
		const onClose = vi.fn();
		const pager = new TranscriptPager({
			source: new MutableTranscript([]),
			viewportRows: () => 4,
			keybindings: new KeybindingsManager(),
			onClose,
		});

		pager.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledOnce();
	});
});
