import { describe, expect, it } from "vitest";
import { type FailureCorpusFs, FailureCorpusRecorder, redactSecrets } from "../src/core/failure-corpus.ts";

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

	it("rotates oversized files to the newest 1000 records", () => {
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
		const lines = files.get(path)!.trim().split("\n");
		expect(lines).toHaveLength(1000);
		expect(JSON.parse(lines[0]) as { ts: string }).toMatchObject({ ts: "101" });
		expect(JSON.parse(lines.at(-1)!) as { message: string }).toMatchObject({ message: "latest" });
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
