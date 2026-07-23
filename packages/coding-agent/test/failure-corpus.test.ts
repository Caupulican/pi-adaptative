import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createToolValidationFailureCorpusRecord,
	FailureCorpusRecorder,
	redactSecrets,
} from "../src/core/failure-corpus.ts";

const cleanups: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-failure-corpus-"));
	cleanups.push(dir);
	return dir;
}

function classified(reason: "unknown" | "rate_limit" = "rate_limit") {
	return {
		reason,
		retryable: reason === "rate_limit",
		message: reason,
		shouldCompact: false,
		shouldRotateCredential: false,
		shouldFallback: false,
	} as const;
}

describe("FailureCorpusRecorder", () => {
	afterEach(() => {
		for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("appends the pinned record shape with a truncated message", () => {
		const filePath = join(tempDir(), "state", "failure-corpus.jsonl");
		const recorder = new FailureCorpusRecorder({
			filePath,
			now: () => new Date("2026-07-05T00:00:00.000Z"),
		});
		recorder.record({
			provider: "openai",
			modelId: "gpt",
			message: "message ".repeat(100),
			classified: classified(),
		});
		const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim()) as {
			message: string;
			ts: string;
		};
		expect(parsed).toMatchObject({
			ts: "2026-07-05T00:00:00.000Z",
			provider: "openai",
			modelId: "gpt",
			reason: "rate_limit",
			retryable: true,
		});
		expect(parsed.message).toHaveLength(500);
	});

	it("redacts API keys, bearer tokens, and long base64-like secrets", () => {
		expect(
			redactSecrets(
				"sk-123456789abcdef Bearer abcdefghijklmnopqrstuvwxyz0123456789 abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN==",
			),
		).toBe("[REDACTED] [REDACTED] [REDACTED]");
	});

	it("redacts separator-bearing provider API key formats", () => {
		expect(redactSecrets("openai sk-proj-abcd_efgh-ijklmnop anthropic sk-ant-api03-abcd-efgh_ijklmnop")).toBe(
			"openai [REDACTED] anthropic [REDACTED]",
		);
	});

	it("rotates oversized files below a byte low-water mark while retaining newest records", () => {
		const filePath = join(tempDir(), "failure-corpus.jsonl");
		writeFileSync(
			filePath,
			`${Array.from({ length: 1100 }, (_, index) =>
				JSON.stringify({ ts: String(index), message: "x".repeat(600), reason: "unknown", retryable: false }),
			).join("\n")}\n`,
			"utf-8",
		);
		new FailureCorpusRecorder({ filePath }).record({
			message: "latest",
			classified: classified(),
		});
		const rotated = readFileSync(filePath, "utf-8");
		const lines = rotated.trim().split("\n");
		expect(Buffer.byteLength(rotated, "utf-8")).toBeLessThanOrEqual(Math.floor(512 * 1024 * 0.75));
		expect(lines.length).toBeLessThan(1000);
		expect(JSON.parse(lines.at(-1)!) as { message: string }).toMatchObject({ message: "latest" });
	});

	it("bounds direct tool-validation corpus details before persistence", () => {
		const record = createToolValidationFailureCorpusRecord({
			ts: "2026-07-13T00:00:00Z",
			tool: "t".repeat(300),
			failureModes: Array.from({ length: 60 }, (_, index) => `${index}-${"m".repeat(300)}`),
			shape: Array.from({ length: 60 }, (_, index) => ({
				path: `${index}-${"p".repeat(300)}`,
				expectedType: "e".repeat(300),
				receivedType: "r".repeat(300),
			})),
			errorKeywords: Array.from({ length: 60 }, (_, index) => `${index}-${"k".repeat(300)}`),
		});

		expect(record.tool.length).toBeLessThanOrEqual(256);
		expect(record.failureModes).toHaveLength(50);
		expect(record.shape).toHaveLength(50);
		expect(record.errorKeywords).toHaveLength(50);
		expect(record.shape.every((entry) => entry.path.length <= 256)).toBe(true);
	});

	it("counts unknown classifications and swallows recorder write failures with a debug note", () => {
		const debug: string[] = [];
		const dir = tempDir();
		const blockedParent = join(dir, "not-a-directory");
		writeFileSync(blockedParent, "file", "utf-8");
		const recorder = new FailureCorpusRecorder({
			filePath: join(blockedParent, "failure-corpus.jsonl"),
			debug: (message) => debug.push(message),
		});
		expect(() => recorder.record({ message: "m", classified: classified("unknown") })).not.toThrow();
		expect(recorder.stats()).toEqual({ total: 1, unknown: 1 });
		expect(debug[0]).toContain("failure corpus write skipped");
	});
});
