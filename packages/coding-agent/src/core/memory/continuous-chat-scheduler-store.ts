import { createHash } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import { copyFile, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMissingFileError } from "../util/atomic-file.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import {
	ContinuousChatCorruptError,
	ensureDurableDirectory,
	fsyncDirectory,
	writeDurableAtomic,
} from "./continuous-chat-index.ts";
import { importLegacyQueue, type LegacyQueueEntry } from "./continuous-chat-queue-import.ts";
import { checkpointContinuousChatRecovery } from "./continuous-chat-recovery.ts";
import { ContinuousChatScheduler } from "./continuous-chat-scheduler.ts";
import type { ContinuousChatWorkItem } from "./continuous-chat-work-queue.ts";

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
	const hash = createHash("sha256");
	for await (const part of createReadStream(path, { signal })) {
		signal?.throwIfAborted();
		hash.update(part);
	}
	signal?.throwIfAborted();
	return hash.digest("hex");
}

/** Queue marker is small. A large file can only be a legacy queue, and is parsed as a bounded stream. */
async function authority(path: string, signal?: AbortSignal): Promise<"absent" | "legacy" | "sqlite"> {
	signal?.throwIfAborted();
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch (error) {
		signal?.throwIfAborted();
		if (isMissingFileError(error)) return "absent";
		throw error;
	}
	signal?.throwIfAborted();
	if (size > 4096) return "legacy";
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
	} catch {
		signal?.throwIfAborted();
		throw new ContinuousChatCorruptError(path, "Invalid queue authority");
	}
	if (isPlainRecord(value) && value.schemaVersion === 3) {
		if (!hasOnlyKeys(value, ["schemaVersion", "storage"]) || value.storage !== "sqlite")
			throw new ContinuousChatCorruptError(path, "Invalid queue authority marker");
		return "sqlite";
	}
	return "legacy";
}

/** Called only under the chat writer lease and lock. Provisional state is never a read fallback. */
export async function openContinuousChatScheduler(
	queuePath: string,
	published: number,
	nodeExists: (item: ContinuousChatWorkItem) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<ContinuousChatScheduler> {
	const root = dirname(queuePath),
		databasePath = join(root, "queue.sqlite");
	const mode = await authority(queuePath, signal);
	signal?.throwIfAborted();
	if (mode === "sqlite" || existsSync(databasePath)) {
		const store = ContinuousChatScheduler.open(databasePath, false);
		try {
			const snapshot = store.snapshot();
			if (snapshot.totalMessages > published)
				throw new ContinuousChatCorruptError(databasePath, "Scheduler is ahead of the log");
			if (mode === "legacy" && (await hashFile(queuePath, signal)) !== snapshot.sourceDigest)
				throw new ContinuousChatCorruptError(queuePath, "Legacy authority disagrees with migrated scheduler");
			signal?.throwIfAborted();
			if (mode !== "sqlite")
				await writeDurableAtomic(queuePath, `${JSON.stringify({ schemaVersion: 3, storage: "sqlite" })}\n`);
			signal?.throwIfAborted();
			return store;
		} catch (error) {
			store.close();
			throw error;
		}
	}
	await ensureDurableDirectory(root);
	signal?.throwIfAborted();
	const provisional = join(root, "queue.migrating.sqlite");
	for (const suffix of ["", "-wal", "-shm"]) {
		signal?.throwIfAborted();
		await rm(`${provisional}${suffix}`, { force: true });
	}
	signal?.throwIfAborted();
	const store = ContinuousChatScheduler.open(provisional, true);
	try {
		store.beginImport();
		if (mode === "legacy") {
			const digest = await hashFile(queuePath, signal);
			let batch: LegacyQueueEntry[] = [];
			let sequence = 0;
			let running = 0;
			let firstPendingLeaf = Number.POSITIVE_INFINITY;
			const flush = (): void => {
				store.importBatch(batch, sequence);
				sequence += batch.length;
				batch = [];
			};
			const header = await importLegacyQueue(
				queuePath,
				(entry) => {
					if (entry.list !== "halfBuilt" && entry.item.level === 0)
						firstPendingLeaf = Math.min(firstPendingLeaf, entry.item.ordinal);
					if (entry.list === "running" && ++running > 8)
						throw new ContinuousChatCorruptError(queuePath, "Too many legacy claims");
					batch.push(entry);
					if (batch.length === 256) flush();
				},
				signal,
			);
			flush();
			if (header.totalMessages > published)
				throw new ContinuousChatCorruptError(queuePath, "Legacy queue exceeds log");
			let visited = 0;
			for (const item of store.importCoordinates(true)) {
				await checkpointContinuousChatRecovery(signal, visited++);
				if (!(await nodeExists(item)))
					throw new ContinuousChatCorruptError(queuePath, "Legacy half-built node is absent");
			}
			signal?.throwIfAborted();
			store.finishImport(header, sequence, digest);
			if (store.snapshot().builtLeafPrefix !== Math.min(header.nextLeaf, firstPendingLeaf))
				throw new ContinuousChatCorruptError(queuePath, "Migration changed the causal prefix");
			if ((await hashFile(queuePath, signal)) !== digest)
				throw new ContinuousChatCorruptError(queuePath, "Legacy queue changed during migration");
			const backup = join(root, `queue.legacy.${digest}.json`);
			try {
				await copyFile(queuePath, backup, constants.COPYFILE_EXCL);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			if ((await hashFile(backup, signal)) !== digest)
				throw new ContinuousChatCorruptError(backup, "Legacy queue backup conflicts");
			const handle = await open(backup, "r+");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		} else {
			store.initialize(published);
			let batch: ContinuousChatWorkItem[] = [];
			for (let ordinal = 0; ordinal < published; ordinal++) {
				await checkpointContinuousChatRecovery(signal, ordinal);
				const item = { level: 0, ordinal };
				if (!(await nodeExists(item))) batch.push(item);
				else {
					let node = item;
					while (node.level < 52) {
						const sibling = {
							level: node.level,
							ordinal: node.ordinal % 2 === 0 ? node.ordinal + 1 : node.ordinal - 1,
						};
						if (!(await nodeExists(sibling))) break;
						const parent = { level: node.level + 1, ordinal: Math.floor(node.ordinal / 2) };
						if (!(await nodeExists(parent))) {
							batch.push(parent);
							break;
						}
						node = parent;
					}
				}
				if (batch.length === 256) {
					store.enqueue(batch);
					batch = [];
				}
			}
			store.enqueue(batch);
		}
		// Once promotion starts, finish the database and authority marker as one publication unit.
		signal?.throwIfAborted();
		store.prepareMigrationMove();
		store.close();
		await rename(provisional, databasePath);
		await fsyncDirectory(root);
		await writeDurableAtomic(queuePath, `${JSON.stringify({ schemaVersion: 3, storage: "sqlite" })}\n`);
		signal?.throwIfAborted();
		return ContinuousChatScheduler.open(databasePath, false);
	} catch (error) {
		try {
			store.close();
		} catch {}
		throw error;
	}
}
