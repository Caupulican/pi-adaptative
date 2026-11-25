import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { SessionMessageEntry } from "../src/kernel/session/session-entries.ts";
import { readSessionHistoryPage } from "../src/kernel/session/session-history-page.ts";

function userEntry(id: string, parentId: string | null, content = id): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-24T00:00:00Z",
		message: { role: "user", content, timestamp: 1 },
	};
}

it("walks only the selected ancestry and detaches the admitted hot message", async () => {
	const root = userEntry("root", null);
	const selected = userEntry("selected", root.id);
	const sibling = userEntry("sibling", root.id);
	const entries = new Map([root, selected, sibling].map((entry) => [entry.id, entry]));
	const page = await readSessionHistoryPage(
		{
			entry: (id) => entries.get(id),
			isCold: () => false,
			location: () => undefined,
			assertCurrent: () => undefined,
		},
		selected.id,
	);
	Object.defineProperty(selected.message, "content", {
		get: () => {
			throw new Error("released payload");
		},
	});

	expect(page.records.map(({ id }) => id)).toEqual([root.id, selected.id]);
	expect(page.records.at(-1)?.message).toMatchObject({ content: "selected" });
	expect(page.older).toBeNull();
});

it("uses the saved position for a cold payload and skips oversized records without touching their getter", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-history-page-"));
	try {
		const file = join(dir, "history.jsonl");
		const older = userEntry("older", null, "x".repeat(200 * 1024));
		const latest = userEntry("latest", older.id, "saved");
		const rows = [older, latest].map((entry) => JSON.stringify(entry));
		await writeFile(file, `${rows.join("\n")}\n`);
		const olderBytes = Buffer.byteLength(rows[0]!);
		const locations = new Map([
			[older.id, { offset: 0, length: olderBytes }],
			[latest.id, { offset: olderBytes + 1, length: Buffer.byteLength(rows[1]!) }],
		]);
		for (const entry of [older, latest]) {
			Object.defineProperty(entry.message, "content", {
				get: () => {
					throw new Error("synchronous read");
				},
			});
		}
		const page = await readSessionHistoryPage(
			{
				entry: (id) => (id === older.id ? older : id === latest.id ? latest : undefined),
				isCold: () => true,
				location: (id) => locations.get(id),
				file,
				revision: await stat(file),
				assertCurrent: () => undefined,
			},
			latest.id,
		);

		expect(page.records[0]).toEqual({ id: older.id, oversized: true });
		expect(page.records[1]?.message).toMatchObject({ content: "saved" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
