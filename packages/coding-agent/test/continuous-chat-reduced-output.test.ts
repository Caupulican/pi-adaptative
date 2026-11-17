import { describe, expect, it } from "vitest";
import { continuousChatNoCallNode } from "../src/core/memory/continuous-chat-compaction.ts";
import {
	normalizeContinuousChatAppend,
	parseContinuousChatRecord,
} from "../src/core/memory/continuous-chat-contracts.ts";
import { continuousChatMessageParts } from "../src/core/memory/continuous-chat-ingest.ts";
import {
	ContinuousChatNavigator,
	renderContinuousChatNavigationResult,
} from "../src/core/memory/continuous-chat-navigation.ts";

const counts = { inputBytes: 900, outputBytes: 100, omittedLines: 0 };

function capture(toolName: string, details: object, text: string) {
	const [part] = continuousChatMessageParts({
		role: "toolResult",
		toolName,
		toolCallId: "call",
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: 0,
	});
	const [unit] = normalizeContinuousChatAppend({
		...part!,
		kind: "echo",
		date: new Date(0).toISOString(),
		sourceKey: "test",
	});
	const record = parseContinuousChatRecord(JSON.parse(JSON.stringify({ ...unit, id: 0, schemaVersion: 1 })));
	expect(record).toBeDefined();
	return record!;
}

describe("reduced tool output in continuous chat", () => {
	it.each([12, 800])("keeps transient paths out of a %i-character deterministic summary", (size) => {
		const leaf = (path: string) => {
			const record = capture(
				"bash",
				{ outputProjection: counts, fullOutputPath: path },
				`${"x".repeat(size)}\nFull output: ${path}`,
			);
			return continuousChatNoCallNode({ kind: "leaf", record })?.text;
		};
		const first = leaf("/tmp/run-one/raw");
		expect(first).toContain("reduced tool output");
		expect(first).not.toContain("/tmp/");
		expect(leaf("/tmp/a-much-longer-session-directory/raw")).toBe(first);
	});

	it("keeps both stream receipts through persistence and bounded zoom without reading a spill file", async () => {
		const rawPath = "/tmp/expired-session/stdout";
		const record = capture(
			"python",
			{
				outputReduction: { ...counts, rawPath, omittedItems: 6, clippedStrings: 1 },
				stderrReduction: { ...counts, omittedLines: 3, persistRaw: true },
			},
			"kept",
		);
		const navigator = new ContinuousChatNavigator(
			{
				readMessageById: async () => record,
				readMessageDate: async () => record.date,
				readImage: async () => {
					throw new Error("unexpected read");
				},
				readNode: async () => undefined,
			},
			undefined,
			128,
		);
		let evidence = "";
		let body = "";
		for (let page = 0; ; page++) {
			const result = await navigator.execute({ tool: "zoom", kind: "node", id: 0, n: 1, page });
			if (result.status !== "message") throw new Error(result.status);
			expect(renderContinuousChatNavigationResult(result)).toContain("reduced tool output");
			expect(Buffer.byteLength((result.reductionDetails ?? "") + result.text)).toBeLessThanOrEqual(128);
			evidence += result.reductionDetails ?? "";
			body += result.text;
			if (page + 1 === result.pageCount) break;
		}
		expect(body).toBe("kept");
		expect(evidence).toContain(rawPath);
		expect(evidence).toContain("6 JSON items omitted, 1 JSON string clipped");
		expect(evidence).toContain("3 lines omitted. No session file recorded.");
	});

	it("preserves legacy and unrelated results and ignores unstructured recovery instructions", () => {
		expect(capture("repo_read", { outputReduction: counts }, "summary").toolOutput?.outputReduction).toEqual(counts);
		expect(capture("bash", {}, "Full output: /tmp/claimed").toolOutput).toBeUndefined();
		expect(capture("custom", { outputReduction: counts }, "report").toolOutput).toBeUndefined();
		expect(
			capture("python", { stderrReduction: { ...counts, rawPath: "/tmp/a\nextra" } }, "error").toolOutput
				?.stderrReduction,
		).toEqual(counts);
		expect(capture("grep", { truncated: true }, "partial").toolOutput).toEqual({ clipped: true });
	});
});
