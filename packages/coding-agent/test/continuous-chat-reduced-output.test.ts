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
import { reductionZoomDetails } from "../src/core/memory/continuous-chat-tool-output.ts";
import { createLookupToolDefinition } from "../src/core/tools/lookup.ts";
import { readSchema } from "../src/core/tools/schemas/read.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

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

	it("advertises only admitted lookup operations on restricted surfaces", () => {
		const host = {
			resolveTool: () => undefined,
			admit: async () => ({ kind: "refused" as const, reason: "unavailable" }),
		};
		const surface = (names: string[]) => createLookupToolDefinition(host, names).parameters.properties.requests.items;
		expect(surface(["read"])).toMatchObject({ anyOf: [{ required: ["read"] }, { required: ["list"] }] });
		expect(surface(["grep"])).toMatchObject({ required: ["search"] });
	});

	it("persists the lookup's own cut and only the finalized producer evidence", async () => {
		const source = Array.from({ length: 1800 }, (_, i) => `source ${100 + i} abcdefghijklmnop`).join("\n");
		const lookup = wrapToolDefinition(
			createLookupToolDefinition({
				resolveTool: () => ({
					name: "read",
					label: "read",
					description: "read",
					parameters: readSchema,
					execute: async () => ({
						content: [{ type: "text", text: source }],
						details: { privateValue: "do not forward" },
					}),
				}),
				admit: async (_parent, child) => ({
					kind: "admitted",
					start() {},
					abandon() {},
					consume() {},
					finish: async (result, isError) =>
						child.args.path === "a"
							? {
									content: result.content,
									details: { nextOffset: 1900, sourceLines: { first: 100, count: 1800 } },
									isError,
								}
							: { content: [{ type: "text", text: "rewritten" }], details: {}, isError },
				}),
			}),
		);
		const result = await lookup.execute("batch", {
			requests: [{ read: { path: "a", offset: 100 } }, { read: { path: "b" } }],
		});
		const body = result.content[0];
		if (body?.type !== "text" || !result.details) throw new Error("Expected lookup text and sections");
		const shown = body.text.split("\n").filter((line) => line.startsWith("source "));
		expect(shown).toEqual(source.split("\n").slice(0, shown.length));
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.length).toBeLessThan(1800);
		const next = `read it again with offset=${100 + shown.length}`;
		expect(body.text).toContain(next);
		const record = capture("lookup", result.details, body.text);
		expect(record.toolOutput?.sections).toEqual([
			{ index: 1, label: "read a", truncated: true, continuation: next, producer: { clipped: true } },
		]);
		expect(reductionZoomDetails(record.toolOutput).join("\n")).toContain(next);
		expect(JSON.stringify(result.details)).not.toContain("privateValue");
		expect(capture("lookup", { sections: [{ label: "old", truncated: true }] }, "old").toolOutput?.sections).toEqual([
			{ index: 1, label: "old", truncated: true },
		]);
	});

	it("renders the same bounded range before and after publishing a tool leaf and keeps exact message zoom", async () => {
		const record = capture(
			"lookup",
			{ sections: [{ label: "repo diff", truncated: false, producer: { outputReduction: counts } }] },
			"abcdef".repeat(4500),
		);
		const following = { ...capture("read", {}, "small"), id: 1 };
		let published = false;
		const nav = new ContinuousChatNavigator({
			readNode: async (coordinate) =>
				published && coordinate.level === 0
					? continuousChatNoCallNode({ kind: "leaf", record: coordinate.ordinal === 0 ? record : following })
					: undefined,
			readMessageDate: async () => record.date,
			readMessageById: async (id) => (id === 0 ? record : following),
			readImage: async () => {
				throw new Error("Unexpected image read");
			},
		});
		const range = { tool: "zoom", kind: "node", id: 0, n: 2, page: 0 } as const;
		const pending = await nav.execute(range);
		if (pending.status !== "range") throw new Error(pending.status);
		expect(pending.lines[0]).toContain("partial lookup output");
		expect(pending.lines[0]).toContain("zoom({id:0,n:1,page:0})");
		expect(Buffer.byteLength(pending.lines[0]!)).toBeLessThan(700);
		published = true;
		expect(await nav.execute(range)).toEqual(pending);
		const exact = await nav.execute({ ...range, n: 1 });
		if (exact.status !== "message") throw new Error(exact.status);
		expect(exact.text).toBe(record.text);
		expect(exact.reductionDetails).toContain("[1] repo diff: producer reduced");
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

	it("uses each Python stream's display clipping when available and raw truncation for legacy streams", () => {
		const rawTruncation = { truncated: true };
		const complete = {
			stdoutTruncation: rawTruncation,
			stderrTruncation: rawTruncation,
			outputReduction: counts,
			stderrReduction: counts,
			stdoutReducedDisplayTruncated: false,
			stderrReducedDisplayTruncated: false,
		};
		const record = capture("python", complete, "complete reduced streams");
		expect(record.toolOutput).toEqual({ outputReduction: counts, stderrReduction: counts });
		expect(
			capture("python", { ...complete, stderrReducedDisplayTruncated: true }, "clipped stderr").toolOutput?.clipped,
		).toBe(true);
		expect(
			capture("python", { ...complete, stderrReducedDisplayTruncated: undefined }, "legacy stderr").toolOutput
				?.clipped,
		).toBe(true);
		expect(
			capture("python", { ...complete, stdoutTruncation: undefined, stdoutReducedDisplayTruncated: true }, "cut")
				.toolOutput?.clipped,
		).toBe(true);
	});
});
