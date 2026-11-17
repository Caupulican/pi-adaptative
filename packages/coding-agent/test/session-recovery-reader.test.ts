import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_RETAINED_TOOL_RESULT_DETAILS_BYTES } from "../src/kernel/session/message-retention.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import type { SessionEntry } from "../src/kernel/session/session-entries.ts";
import { retainedStringChars, visitSessionEntriesAsync } from "../src/kernel/session/session-file-reading.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";
import { CURRENT_SESSION_VERSION } from "../src/kernel/session/session-version-migration.ts";

function transcript(tail: string | Buffer = "") {
	const directory = mkdtempSync(join(tmpdir(), "pi-session-recovery-reader-"));
	const file = join(directory, "session.jsonl");
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
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

describe("cold session payload retention", () => {
	it("opens and restores a wide message payload", () => {
		const fixture = transcript();
		const blockCount = 256 * 1024;
		const entry = {
			type: "message",
			id: "wide-message",
			parentId: fixture.receipt.id,
			timestamp: fixture.header.timestamp,
			message: {
				role: "user",
				content: Array.from({ length: blockCount }, () => ({ type: "text", text: "x" })),
				timestamp: Date.parse(fixture.header.timestamp),
			},
		};
		try {
			appendFileSync(fixture.file, `${JSON.stringify(entry)}\n`);
			const loaded = SessionManager.openReadOnly(fixture.file, ownerSessionStorageRoots(fixture.directory)).getEntry(
				entry.id,
			);
			if (loaded?.type !== "message") throw new Error("Missing wide message");
			expect(Object.getOwnPropertyDescriptor(loaded.message, "content")?.get).toBeTypeOf("function");
			expect((loaded.message as { content?: unknown }).content).toHaveLength(blockCount);
		} finally {
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	it("bounds deeply nested details from a persisted tool result", () => {
		const fixture = transcript();
		const depth = MAX_RETAINED_TOOL_RESULT_DETAILS_BYTES / 2 + 1;
		const details = `${"[".repeat(depth)}null${"]".repeat(depth)}`;
		try {
			appendFileSync(
				fixture.file,
				`{"type":"message","id":"deep-result","parentId":"${fixture.receipt.id}","timestamp":"${fixture.header.timestamp}",` +
					`"message":{"role":"toolResult","toolCallId":"tool-call","toolName":"read","content":[],"isError":false,` +
					`"timestamp":${Date.parse(fixture.header.timestamp)},"details":${details}}}\n`,
			);
			const loaded = SessionManager.openReadOnly(fixture.file, ownerSessionStorageRoots(fixture.directory)).getEntry(
				"deep-result",
			);
			if (loaded?.type !== "message" || loaded.message.role !== "toolResult") throw new Error("Missing tool result");
			expect(loaded.message.details).toMatchObject({
				piToolResultDetailsTruncated: true,
				minimumBytes: MAX_RETAINED_TOOL_RESULT_DETAILS_BYTES + 2,
			});
		} finally {
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	it("counts a wide object's own strings and visits shared or circular objects once", () => {
		const blockCount = 256 * 1024;
		const record: Record<string, unknown> = {};
		const shared = { text: "xyz", parent: record };
		for (let index = 0; index < blockCount; index++) record[index] = index === 0 ? shared : "x";
		record.shared = shared;
		expect(retainedStringChars(record, Infinity)).toBe(blockCount + 2);
	});
});

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
