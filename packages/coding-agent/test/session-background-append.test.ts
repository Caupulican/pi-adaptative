import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

it.skipIf(process.platform !== "linux")(
	"publishes a worker append before a synchronous mutation prepares its parent",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-background-append-"));
		try {
			const roots = ownerSessionStorageRoots(directory);
			const manager = SessionManager.create(directory, roots);
			manager.flushBufferedEntries();
			manager.enableBackgroundAppends();
			const publish = (content: string) => {
				let ids: string[] = [];
				return manager.appendMessageBatchAwaitable(
					[
						[{ kind: "message", message: { role: "user", content, timestamp: 1 } }],
						(receipt) => {
							ids = receipt.entries.map((entry) => entry.id);
						},
					],
					(failure) => {
						if (failure) throw failure.error;
						return ids;
					},
				);
			};

			let nested: Promise<string[]> | undefined;
			manager.onEntriesPersisted(() => {
				nested ??= publish("from publication");
			});
			const first = publish("first");
			const second = publish("queued before the synchronous mutation");
			const sync = manager.appendCustomEntry("sync-after-worker");
			const [[firstId], [secondId], [nestedId]] = await Promise.all([first, second, nested!]);
			expect(manager.getEntry(secondId!)?.parentId).toBe(firstId);
			expect(manager.getEntry(nestedId!)?.parentId).toBe(secondId);
			expect(manager.getEntry(sync)?.parentId).toBe(nestedId);

			const tail = publish("during shutdown");
			await manager.settleBackgroundAppends();
			const [tailId] = await tail;
			expect(manager.getEntry(tailId!)?.parentId).toBe(sync);
			const reopened = SessionManager.openReadOnly(manager.getSessionFile()!, roots);
			expect(reopened.getBranch().map((entry) => entry.id)).toEqual([firstId, secondId, nestedId, sync, tailId]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
