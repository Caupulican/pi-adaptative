import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../src/kernel/session/session-entries.ts";
import { visitSessionEntriesAsync } from "../src/kernel/session/session-file-reading.ts";

function transcript(tail: string | Buffer = "") {
	const directory = mkdtempSync(join(tmpdir(), "pi-session-recovery-reader-"));
	const file = join(directory, "session.jsonl");
	const header = {
		type: "session",
		version: 3,
		id: randomUUID(),
		timestamp: "2026-11-12T00:00:00.000Z",
		cwd: directory,
	};
	const receipt = {
		type: "custom",
		id: "receipt-row",
		parentId: null,
		timestamp: header.timestamp,
		customType: "selected",
		data: { reportId: "receipt-token" },
	};
	const prefix = `${JSON.stringify(header)}\n${JSON.stringify(receipt)}\n`;
	writeFileSync(file, Buffer.concat([Buffer.from(prefix), Buffer.from(tail)]));
	return { directory, file, header, receipt, prefix };
}

const selected = (line: string) => line.includes('"customType":"selected"');

describe("strict asynchronous recovery snapshots", () => {
	it.each([
		{ name: "malformed excluded row", tail: "{not-json}\n", error: /malformed JSONL/ },
		{ name: "incomplete excluded tail", tail: '{"type":"custom","customType":"other"}', error: /incomplete JSONL/ },
		{ name: "non-object excluded row", tail: "7\n", error: /non-object JSONL/ },
		{ name: "invalid UTF-8 excluded row", tail: Buffer.from([0xc3, 0x28, 0x0a]), error: /encoding|encoded|UTF-8/i },
		{ name: "oversized excluded row", tail: `${"x".repeat(513)}\n`, error: /limit|exceed|line|bound/i },
	])("refuses a valid candidate followed by $name", async ({ tail, error }) => {
		const fixture = transcript(tail);
		let published = false;
		try {
			const readThenPublish = async () => {
				const candidates: SessionEntry[] = [];
				await visitSessionEntriesAsync(fixture.file, selected, (entry) => candidates.push(entry), {
					requireComplete: true,
					maxLineChars: 512,
				});
				published = true;
				return candidates;
			};
			await expect(readThenPublish()).rejects.toThrow(error);
			expect(published).toBe(false);
		} finally {
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	it("returns the descriptor header and complete selected rows on a stable valid snapshot", async () => {
		const fixture = transcript();
		try {
			const rows: SessionEntry[] = [];
			const header = await visitSessionEntriesAsync(fixture.file, selected, (entry) => rows.push(entry), {
				requireComplete: true,
				maxLineChars: 512,
			});
			expect(header).toEqual(fixture.header);
			expect(rows).toEqual([fixture.receipt]);
		} finally {
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	it("refuses an invalid header before accepting selected rows", async () => {
		const fixture = transcript();
		try {
			writeFileSync(
				fixture.file,
				`${JSON.stringify({ type: "session", id: "invalid/session" })}\n${JSON.stringify(fixture.receipt)}\n`,
			);
			await expect(
				visitSessionEntriesAsync(fixture.file, selected, () => {}, { requireComplete: true }),
			).rejects.toThrow(/header is invalid/);
		} finally {
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	it("refuses a transcript that changes while its candidate is being visited", async () => {
		const fixture = transcript();
		try {
			await expect(
				visitSessionEntriesAsync(fixture.file, selected, () => appendFileSync(fixture.file, "\n"), {
					requireComplete: true,
				}),
			).rejects.toThrow(/changed|scan bound/);
		} finally {
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	it.each([false, true])("parses excluded records only when strict=%s", async (strict) => {
		const marker = "do-not-parse-unless-strict";
		const fixture = transcript(`${JSON.stringify({ type: "custom", customType: marker, data: {} })}\n`);
		const parser = vi.spyOn(JSON, "parse");
		try {
			const rows: SessionEntry[] = [];
			await visitSessionEntriesAsync(fixture.file, selected, (entry) => rows.push(entry), {
				requireComplete: strict,
			});
			expect(rows).toEqual([fixture.receipt]);
			expect(parser.mock.calls.some(([line]) => String(line).includes(marker))).toBe(strict);
		} finally {
			parser.mockRestore();
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	it("keeps permissive viewing available while enforcing explicit recovery byte bounds", async () => {
		const fixture = transcript("{bad excluded row}\n");
		try {
			const rows: SessionEntry[] = [];
			await visitSessionEntriesAsync(fixture.file, selected, (entry) => rows.push(entry));
			expect(rows).toEqual([fixture.receipt]);
			await expect(
				visitSessionEntriesAsync(fixture.file, selected, () => {}, {
					requireComplete: true,
					maxBytes: Buffer.byteLength(fixture.prefix) - 1,
				}),
			).rejects.toThrow(/scan bound/);
		} finally {
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});
});
