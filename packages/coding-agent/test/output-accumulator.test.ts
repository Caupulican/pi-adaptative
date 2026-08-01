import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

let tempDirectory = "";

beforeEach(() => {
	tempDirectory = mkdtempSync(join(tmpdir(), "pi-output-accumulator-"));
});

afterEach(() => {
	rmSync(tempDirectory, { recursive: true, force: true });
});

function appendLines(output: OutputAccumulator, count: number): void {
	for (let i = 0; i < count; i++) {
		output.append(Buffer.from(`line-${i}\n`, "utf-8"));
	}
}

describe("OutputAccumulator", () => {
	it("serves bounded previews from incremental tail state", () => {
		const output = new OutputAccumulator({ maxLines: 2000, maxBytes: 50 * 1024, tempDirectory });

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
		const output = new OutputAccumulator({ maxLines: 2000, maxBytes: 50 * 1024, tempDirectory });
		output.append(Buffer.from("x".repeat(10_000), "utf-8"));

		const preview = output.previewSnapshot(5, 100);

		expect(preview.content).toBe("x".repeat(100));
		expect(preview.truncation.outputBytes).toBe(100);
		expect(preview.truncation.outputLines).toBe(1);
		expect(preview.truncation.lastLinePartial).toBe(true);
	});

	it("does not count a trailing newline as an extra output line", () => {
		const output = new OutputAccumulator({ maxLines: 2, maxBytes: 1024, tempDirectory });
		output.append(Buffer.from("a\nb\nc\n", "utf-8"));

		const snapshot = output.snapshot();

		expect(snapshot.truncation.totalLines).toBe(3);
		expect(snapshot.truncation.outputLines).toBe(2);
		expect(snapshot.content).toBe("b\nc");
	});

	it("decodes UTF-8 split across chunks", () => {
		const output = new OutputAccumulator({ maxLines: 10, maxBytes: 1024, tempDirectory });
		const euro = Buffer.from("€\n", "utf-8");
		output.append(euro.subarray(0, 1));
		output.append(euro.subarray(1));

		expect(output.snapshot().content).toBe("€\n");
	});

	it("can persist all output while retaining only a bounded in-memory view", async () => {
		const output = new OutputAccumulator({
			maxLines: 10,
			maxBytes: 1024,
			tempDirectory,
			persistAllOutput: true,
		});
		output.append(Buffer.from("small output\n", "utf-8"));
		output.finish();

		const snapshot = output.snapshot();
		await output.closeTempFile();

		expect(snapshot.truncation.truncated).toBe(false);
		expect(snapshot.fullOutputPath).toBeDefined();
		expect(readFileSync(snapshot.fullOutputPath ?? "", "utf-8")).toBe("small output\n");
	});

	it("can persist a completed small output only when its final projection needs an exact handoff", async () => {
		const output = new OutputAccumulator({ maxLines: 10, maxBytes: 1024, tempDirectory });
		output.append(Buffer.from("small output\n", "utf-8"));
		output.finish();

		expect(output.snapshot().fullOutputPath).toBeUndefined();
		const snapshot = output.snapshot({ persistAlways: true });
		await output.closeTempFile();

		expect(snapshot.fullOutputPath).toBeDefined();
		expect(readFileSync(snapshot.fullOutputPath ?? "", "utf-8")).toBe("small output\n");
	});

	it("bounds explicitly persisted output and discloses discarded bytes", async () => {
		const output = new OutputAccumulator({
			maxLines: 10,
			maxBytes: 1024,
			tempDirectory,
			persistAllOutput: true,
			maxPersistedBytes: 5,
		});
		output.append(Buffer.from("0123456789", "utf-8"));
		output.finish();

		const snapshot = output.snapshot();
		await output.closeTempFile();

		expect(snapshot.persistedOutputTruncated).toBe(true);
		expect(snapshot.persistedOutputBytes).toBe(5);
		expect(readFileSync(snapshot.fullOutputPath ?? "", "utf-8")).toBe("01234");
	});
});
