import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@caupulican/pi-agent-core/truncate";
import { StreamingLineDecoder } from "@caupulican/pi-ai/streaming-lines";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(text: string) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-line-window-"));
	directories.push(cwd);
	const path = join(cwd, "literal $(not-a-command) é.txt");
	await writeFile(path, text);
	return { cwd, path };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("bounded read line windows", () => {
	it.each([1, 16 * 1024 * 1024])(
		"recovers a long line with lossless same-tool continuation (budget %i)",
		async (budget) => {
			const source = "🙂é".repeat(20_000);
			const { cwd, path } = await fixture(`${source}\nlast\n`);
			const tool = createReadTool(cwd, { maxTextReadBytes: budget });
			let column: number | undefined;
			let restored = "";
			for (let step = 0; step < 10; step++) {
				const result = await tool.execute(`window-${step}`, { path, offset: 1, limit: 1, column });
				const detail = result.details as {
					lineWindow?: { nextColumn?: number; startColumn: number; totalColumns: number };
				};
				expect(detail.lineWindow).toBeDefined();
				expect(detail.lineWindow?.totalColumns).toBe(source.length);
				const text = textOf(result);
				expect(text).not.toContain("Use bash:");
				expect(Buffer.byteLength(text)).toBeLessThan(DEFAULT_MAX_BYTES);
				const payload = text.split("\n\n[Line ")[0];
				expect(payload.isWellFormed()).toBe(true);
				restored += payload;
				column = detail.lineWindow?.nextColumn;
				if (column === undefined) break;
			}
			expect(restored).toBe(source);
			expect(await readFile(path, "utf8")).toBe(`${source}\nlast\n`);
		},
	);

	it("bounds retained line memory and keeps later offsets and tail counts exact", async () => {
		const { cwd, path } = await fixture(`${"x".repeat(4 * 1024 * 1024)}\n\nlast\n`);
		let retainedPeak = 0;
		const push = StreamingLineDecoder.prototype.pushRecords;
		vi.spyOn(StreamingLineDecoder.prototype, "pushRecords").mockImplementation(function (
			this: StreamingLineDecoder,
			text,
		) {
			const result = push.call(this, text);
			const parts = (this as unknown as { parts: string[] }).parts;
			retainedPeak = Math.max(
				retainedPeak,
				parts.reduce((sum, part) => sum + part.length, 0),
			);
			return result;
		});
		const tool = createReadTool(cwd, { maxTextReadBytes: 1 });
		expect(textOf(await tool.execute("offset", { path, offset: 3, limit: 1, lineNumbers: true }))).toBe("3: last");
		expect(textOf(await tool.execute("tail", { path, tail: 1, lineNumbers: true }))).toBe("3: last");
		expect(retainedPeak).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 3);
	});

	it("moves an explicit column back to the start of a surrogate pair", async () => {
		const { cwd, path } = await fixture("a🙂b\n");
		const result = await createReadTool(cwd).execute("pair", { path, column: 3 });
		expect(textOf(result)).toContain("🙂b");
		expect(result.details).toMatchObject({ lineWindow: { startColumn: 2 } });
	});

	it.each([
		{ column: 0 },
		{ column: 1.5 },
		{ column: Number.NaN },
		{ column: 1, tail: 1 },
		{ column: 1, limit: 2 },
		{ column: 1, mode: "outline" as const },
	])("rejects invalid window options before backend access: %j", async (params) => {
		const access = vi.fn(async () => {});
		const read = vi.fn(async () => Buffer.from("fixture"));
		const tool = createReadTool("/fixture", {
			pathOptions: { flavor: "posix" },
			operations: { access, readFile: read },
		});
		await expect(tool.execute("invalid", { path: "file.txt", ...params })).rejects.toThrow(/column/);
		expect(access).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
	});

	it("preserves backend authority and exact character positions without native file access", async () => {
		const source = "a🙂b";
		const read = vi.fn(async () => Buffer.from(source));
		const tool = createReadTool("C:\\fixture", {
			pathOptions: { flavor: "win32" },
			operations: { access: async () => {}, readFile: read },
		});
		const result = await tool.execute("remote-window", { path: "file.txt", column: 3 });
		expect(textOf(result)).toContain("🙂b");
		expect(result.details).toMatchObject({ lineWindow: { startColumn: 2, endColumn: 4, totalColumns: 4 } });
		expect(read).toHaveBeenCalledWith("C:\\fixture\\file.txt");
		await expect(tool.execute("past-end", { path: "file.txt", column: 6 })).rejects.toThrow(/beyond line/);
	});

	it("keeps outline declaration positions after an oversized source line", async () => {
		const { cwd, path } = await fixture("unused");
		const sourcePath = `${path}.ts`;
		await writeFile(sourcePath, `// ${"x".repeat(100_000)}\nexport function afterLongLine() {}\n`);
		const result = await createReadTool(cwd, { maxTextReadBytes: 1 }).execute("outline", {
			path: sourcePath,
			mode: "outline",
		});
		expect(textOf(result)).toContain("2:");
		expect(textOf(result)).toContain("afterLongLine");
		expect(textOf(result)).toContain("offset=1 column=1");
	});

	it("never projects a partial oversized session record as raw text", async () => {
		const tool = createReadTool("/fixture", {
			pathOptions: { flavor: "posix" },
			maxTextReadBytes: 1,
			operations: {
				access: async () => {},
				readFile: async () => {
					throw new Error("Unexpected whole-file read");
				},
				stat: async () => ({ size: 100 }),
				readLineSlice: async () => ({
					lines: [
						{
							text: "PRIVATE_FIXTURE_PARTIAL",
							originalIndex: 1,
							window: { startColumn: 0, totalChars: 100_000_000 },
						},
					],
					reachedEnd: true,
				}),
			},
		});
		const result = await tool.execute("partial-session", { path: ".pi/agent/sessions/synthetic.jsonl" });
		expect(textOf(result)).toContain("raw payload withheld");
		expect(textOf(result)).not.toContain("PRIVATE_FIXTURE_PARTIAL");
	});

	it("does not expose raw session payloads through outline fallback", async () => {
		const path = "/fixture/.pi/agent/sessions/synthetic.jsonl";
		const bytes = Buffer.from(
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "PRIVATE_FIXTURE_THINKING" },
						{ type: "text", text: "Visible fixture reply" },
					],
				},
			}),
		);
		const tool = createReadTool("/fixture", {
			pathOptions: { flavor: "posix" },
			operations: {
				access: async () => {},
				readFile: async () => bytes,
			},
		});
		const result = await tool.execute("outline-session", { path, mode: "outline" });
		expect(textOf(result)).toContain("ASSISTANT Visible fixture reply");
		expect(textOf(result)).not.toContain("PRIVATE_FIXTURE_THINKING");
		await expect(tool.execute("column-session", { path, column: 1 })).rejects.toThrow(/projected labels/);
	});
});
