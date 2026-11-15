/**
 * What a home's session tombstones (`deletions/<session-key>.json`, `session-bundle-lifecycle.ts`) record beside their
 * schema-3 marker, in files of their own, so a build that reads only the marker reads every tombstone as before:
 * - `<session-key>.removing`: the retention's remover may have begun removing the bundle. Created under the tombstone's
 *   lock just before the first removal, removed with the tombstone.
 * - `pending/<session-key>` (its content the session id): the index of the retention tombstones in flight, created
 *   before such a marker is written and removed after the tombstone goes, under the same lock. A startup lists the
 *   retentions it resumes from it without reading every tombstone (the permanent ones accumulate). An entry whose
 *   tombstone is gone, or is no longer a retention, is stale and is pruned by whoever reads it under the lock.
 * - `pending.indexed`: the index also holds every retention tombstone written before it existed (one scan per home,
 *   which writes its entries without the tombstones' locks: an entry it writes for a tombstone settled meanwhile is
 *   stale, and pruned as above).
 * Only the lifecycle writes them.
 */
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { isMissingFileError, writeFileAtomicSync } from "../storage/atomic-file.ts";
import { readOptionalBoundedTextFileSync } from "../storage/bounded-file.ts";
import {
	type OrchestrationHome,
	orchestrationSessionDeletionFile,
	orchestrationSessionDeletionsDir,
} from "./session-bundle-paths.ts";
import { isValidSessionId } from "./session-identity.ts";

/** A session key ends with its digest; anything else in the index directory (a temporary file) is not an entry. */
const SESSION_KEY_PATTERN = /-[0-9a-f]{16}$/;
const MAX_ENTRY_BYTES = 1024;

function sessionKey(home: OrchestrationHome, parentSessionId: string): string {
	return basename(orchestrationSessionDeletionFile(home, parentSessionId), ".json");
}

function removalFile(home: OrchestrationHome, parentSessionId: string): string {
	return join(orchestrationSessionDeletionsDir(home), `${sessionKey(home, parentSessionId)}.removing`);
}

function indexDir(home: OrchestrationHome): string {
	return join(orchestrationSessionDeletionsDir(home), "pending");
}

function indexEntry(home: OrchestrationHome, parentSessionId: string): string {
	return join(indexDir(home), sessionKey(home, parentSessionId));
}

function indexedFile(home: OrchestrationHome): string {
	return join(orchestrationSessionDeletionsDir(home), "pending.indexed");
}

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (isMissingFileError(error)) return false;
		throw error;
	}
}

/** Whether the session's retention remover may have begun removing its bundle in `home`. */
export function removalBegun(home: OrchestrationHome, parentSessionId: string): boolean {
	return exists(removalFile(home, parentSessionId));
}

export function recordRemovalBegun(home: OrchestrationHome, parentSessionId: string): void {
	writeFileAtomicSync(removalFile(home, parentSessionId), "");
}

export function forgetRemovalBegun(home: OrchestrationHome, parentSessionId: string): void {
	rmSync(removalFile(home, parentSessionId), { force: true });
}

export function recordRetentionInFlight(home: OrchestrationHome, parentSessionId: string): void {
	const entry = indexEntry(home, parentSessionId);
	if (exists(entry)) return;
	mkdirSync(indexDir(home), { recursive: true });
	writeFileAtomicSync(entry, `${parentSessionId}\n`);
}

export function forgetRetentionInFlight(home: OrchestrationHome, parentSessionId: string): void {
	rmSync(indexEntry(home, parentSessionId), { force: true });
}

/** Whether the index already holds the retention tombstones written before it existed. */
export function retentionIndexComplete(home: OrchestrationHome): boolean {
	return exists(indexedFile(home));
}

export function markRetentionIndexComplete(home: OrchestrationHome): void {
	writeFileAtomicSync(indexedFile(home), "");
}

/**
 * The sessions the index names in `home` (read without the lock: each is confirmed under it), and how many entries do
 * not name a session whose key they carry.
 */
export function readRetentionIndex(home: OrchestrationHome): { sessionIds: string[]; unreadable: number } {
	const dir = indexDir(home);
	if (!exists(dir)) return { sessionIds: [], unreadable: 0 };
	const sessionIds: string[] = [];
	let unreadable = 0;
	for (const name of readdirSync(dir).sort()) {
		if (!SESSION_KEY_PATTERN.test(name)) continue;
		const id = readOptionalBoundedTextFileSync(
			join(dir, name),
			MAX_ENTRY_BYTES,
			"Session retention index entry",
		)?.trim();
		if (id !== undefined && isValidSessionId(id) && sessionKey(home, id) === name) sessionIds.push(id);
		else unreadable++;
	}
	return { sessionIds, unreadable };
}
