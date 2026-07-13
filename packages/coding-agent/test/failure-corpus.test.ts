import { describe, expect, it } from "vitest";
import {
	createToolValidationFailureCorpusRecord,
	type FailureCorpusFs,
	FailureCorpusRecorder,
	redactSecrets,
} from "../src/core/failure-corpus.ts";

type Files = Map<string, string>;

function memFs(files: Files = new Map()): FailureCorpusFs {
	return {
		existsSync: (path) => files.has(path),
		mkdirSync: () => {},
		appendFileSync: (path, data) => files.set(path, `${files.get(path) ?? ""}${data}`),
		readFileSync: (path) => files.get(path) ?? "",
		writeFileSync: (path, data) => files.set(path, data),
		statSync: (path) => ({ size: Buffer.byteLength(files.get(path) ?? "", "utf-8") }),
	};
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
	it("appends the pinned record shape with a truncated message", () => {
		const files: Files = new Map();
		const recorder = new FailureCorpusRecorder({
			filePath: "/agent/state/failure-corpus.jsonl",
			fs: memFs(files),
			now: () => new Date("2026-07-05T00:00:00.000Z"),
		});
		recorder.record({
			provider: "openai",
			modelId: "gpt",
			message: "message ".repeat(100),
			classified: classified(),
		});
		const parsed = JSON.parse(files.get("/agent/state/failure-corpus.jsonl")!.trim()) as {
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
		const files: Files = new Map();
		const path = "/agent/state/failure-corpus.jsonl";
		files.set(
			path,
			`${Array.from({ length: 1100 }, (_, index) =>
				JSON.stringify({ ts: String(index), message: "x".repeat(600), reason: "unknown", retryable: false }),
			).join("\n")}\n`,
		);
		new FailureCorpusRecorder({ filePath: path, fs: memFs(files) }).record({
			message: "latest",
			classified: classified(),
		});
		const rotated = files.get(path)!;
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
		const throwingFs = {
			...memFs(),
			appendFileSync: () => {
				throw new Error("disk full");
			},
		};
		const recorder = new FailureCorpusRecorder({
			filePath: "/x/failure-corpus.jsonl",
			fs: throwingFs,
			debug: (message) => debug.push(message),
		});
		expect(() => recorder.record({ message: "m", classified: classified("unknown") })).not.toThrow();
		expect(recorder.stats()).toEqual({ total: 1, unknown: 1 });
		expect(debug[0]).toContain("failure corpus write skipped");
	});
});
