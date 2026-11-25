import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { appendQueuedInputRecord, readQueuedInputRecord } from "../src/core/queued-input-record.ts";
import { SessionMutationBusyError } from "../src/kernel/session/session-append-order.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

it("persists the first queued input before any user or assistant message exists", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-queued-input-first-write-"));
	try {
		const roots = ownerSessionStorageRoots(directory);
		const manager = SessionManager.create(directory, roots);
		expect(manager.hasDurableSessionFile()).toBe(false);
		const input = { id: "accepted-input", kind: "followUp", text: "held on a fresh session" } as const;
		appendQueuedInputRecord(manager, undefined, [input], undefined, "borrowed");
		const reopened = SessionManager.openReadOnly(manager.getSessionFile()!, roots);
		expect(readQueuedInputRecord(reopened, undefined)?.inputs).toMatchObject([input]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it.skipIf(process.platform !== "linux")(
	"publishes background receipts before queued mutations and refuses an overlapping synchronous write",
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
			expect(() => manager.appendCustomEntry("must-not-overtake")).toThrow(SessionMutationBusyError);
			const replacement = { key: {}, superseded: undefined };
			const superseded = manager.queueMutation(() => manager.appendCustomEntry("superseded"), replacement);
			const beforeBarrier = manager.queueMutation(() => manager.appendCustomEntry("before-barrier"), replacement);
			const queued = manager.queueMutation(() => manager.appendCustomEntry("after-worker"));
			const afterBarrier = manager.queueMutation(() => manager.appendCustomEntry("after-barrier"), replacement);
			const [[firstId], [secondId], skipped, beforeId, queuedId, afterId] = await Promise.all([
				first,
				second,
				superseded,
				beforeBarrier,
				queued,
				afterBarrier,
			]);
			const [nestedId] = await nested!;
			expect(manager.getEntry(secondId!)?.parentId).toBe(firstId);
			expect(skipped).toBeUndefined();
			expect(manager.getEntry(beforeId!)?.parentId).toBe(secondId);
			expect(manager.getEntry(queuedId)?.parentId).toBe(beforeId);
			expect(manager.getEntry(afterId!)?.parentId).toBe(queuedId);
			expect(manager.getEntry(nestedId!)?.parentId).toBe(afterId);

			const tail = publish("during shutdown");
			await manager.settleBackgroundAppends();
			const [tailId] = await tail;
			expect(manager.getEntry(tailId!)?.parentId).toBe(nestedId);
			const reopened = SessionManager.openReadOnly(manager.getSessionFile()!, roots);
			expect(reopened.getBranch().map((entry) => entry.id)).toEqual([
				firstId,
				secondId,
				beforeId,
				queuedId,
				afterId,
				nestedId,
				tailId,
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
