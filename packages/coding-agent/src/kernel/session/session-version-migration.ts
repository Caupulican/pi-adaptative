/** Session transcript format versions: the current version constants and the ordered migrations that upgrade entries from older formats to the current one. */
import type { CompactionEntry, SessionMessageEntry } from "./session-entries.ts";
import type { SessionHeader } from "./session-header.ts";
import { generateId } from "./session-id-generation.ts";
import type { FileEntry } from "./session-manager-types.ts";

export const CURRENT_SESSION_VERSION = 4;
/** First session format version whose entries all carry `id`/`parentId`; earlier files get random ids when migrated. */
export const FIRST_SESSION_VERSION_WITH_ENTRY_IDS = 2;

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		ids.add(entry.id);
		entry.parentId = prevId;
		prevId = entry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// Update message entries with hookMessage role
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/** Migrate v3 → v4: reserve the version for the typed lifecycle ledger. */
function migrateV3ToV4(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 4;
	}
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
export function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < FIRST_SESSION_VERSION_WITH_ENTRY_IDS) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);
	if (version < 4) migrateV3ToV4(entries);

	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}
