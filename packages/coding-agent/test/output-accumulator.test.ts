import { describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

function appendLines(output: OutputAccumulator, count: number): void {
	for (let i = 0; i < count; i++) {
		output.append(Buffer.from(`line-${i}\n`, "utf-8"));
	}
}

describe("OutputAccumulator", () => {
	it("serves bounded previews from incremental tail state", () => {
		const output = new OutputAccumulator({ maxLines: 2000, maxBytes: 50 * 1024 });

		appendLines(output, 5000);

		const preview = output.preview(5, 1024);
		expect(preview.content).toBe("line-4995\nline-4996\nline-4997\nline-4998\nline-4999");
		expect(preview.skippedLines).toBe(4995);

		const snapshot = output.snapshot();
		expect(snapshot.truncation.totalLines).toBe(5000);
		expect(snapshot.truncation.outputLines).toBe(2000);
		expect(snapshot.content.startsWith("line-3000\n")).toBe(true);
		expect(snapshot.content.endsWith("line-4999")).toBe(true);
	});

	it("keeps preview bytes bounded for a huge unterminated line", () => {
		const output = new OutputAccumulator({ maxLines: 2000, maxBytes: 50 * 1024 });
		output.append(Buffer.from("x".repeat(10_000), "utf-8"));

		const preview = output.previewSnapshot(5, 100);

		expect(preview.content).toBe("x".repeat(100));
		expect(preview.truncation.outputBytes).toBe(100);
		expect(preview.truncation.outputLines).toBe(1);
		expect(preview.truncation.lastLinePartial).toBe(true);
	});

	it("does not count a trailing newline as an extra output line", () => {
		const output = new OutputAccumulator({ maxLines: 2, maxBytes: 1024 });
		output.append(Buffer.from("a\nb\nc\n", "utf-8"));

		const snapshot = output.snapshot();

		expect(snapshot.truncation.totalLines).toBe(3);
		expect(snapshot.truncation.outputLines).toBe(2);
		expect(snapshot.content).toBe("b\nc");
	});

	it("decodes UTF-8 split across chunks", () => {
		const output = new OutputAccumulator({ maxLines: 10, maxBytes: 1024 });
		const euro = Buffer.from("€\n", "utf-8");
		output.append(euro.subarray(0, 1));
		output.append(euro.subarray(1));

		expect(output.snapshot().content).toBe("€\n");
	});
});
