import { afterEach, describe, expect, it, vi } from "vitest";

describe("truncateToVisualLines", () => {
	afterEach(() => {
		vi.doUnmock("@caupulican/pi-tui");
		vi.resetModules();
	});

	it("renders only the bounded tail of massive command output", async () => {
		let renderedInput = "";
		vi.doMock("@caupulican/pi-tui", () => ({
			Text: class MockText {
				private readonly text: string;

				constructor(text: string) {
					this.text = text;
					renderedInput = text;
				}

				render() {
					return this.text.split("\n");
				}
			},
		}));

		const { truncateToVisualLines } = await import("../src/modes/interactive/components/visual-truncate.ts");
		const text = Array.from({ length: 5000 }, (_, index) => `line-${index}`).join("\n");

		const result = truncateToVisualLines(text, 5, 80);

		expect(renderedInput).toBe("line-4995\nline-4996\nline-4997\nline-4998\nline-4999");
		expect(result.visualLines).toEqual(["line-4995", "line-4996", "line-4997", "line-4998", "line-4999"]);
		expect(result.skippedCount).toBe(4995);
	});
});
