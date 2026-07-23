import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import { isPlainRecord } from "./util/value-guards.ts";

export type SessionSnapshotPayload<ValueKey extends string, Value extends object> = {
	version: 1;
} & {
	[Key in ValueKey]: Value;
};

export interface SessionSnapshotCodec<Value extends object, ValueKey extends string> {
	customType: string;
	valueKey: ValueKey;
	isValue(value: unknown): value is Value;
	clone(value: Value): Value;
}

export interface SessionBranchEntrySource {
	getBranch?: () => readonly SessionEntry[];
	getEntries?: () => readonly SessionEntry[];
}

type VersionOneSnapshotPayload = Record<string, unknown> & { version: 1 };

/** Active branch when available; linear entry history only for narrow stores that expose no branch API. */
export function getActiveSessionBranchEntries(source: SessionBranchEntrySource): readonly SessionEntry[] {
	if (typeof source.getBranch === "function") return source.getBranch();
	if (typeof source.getEntries === "function") return source.getEntries();
	throw new TypeError("Session branch entry source exposes neither getBranch nor getEntries");
}

export function isVersionOneSessionSnapshotPayload(data: unknown): data is VersionOneSnapshotPayload {
	return isPlainRecord(data) && data.version === 1;
}

export function createSessionSnapshotPayload<Value extends object, ValueKey extends string>(
	codec: SessionSnapshotCodec<Value, ValueKey>,
	value: Value,
): SessionSnapshotPayload<ValueKey, Value> {
	return {
		version: 1,
		[codec.valueKey]: codec.clone(value),
	} as SessionSnapshotPayload<ValueKey, Value>;
}

export function appendSessionSnapshot<Value extends object, ValueKey extends string>(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	codec: SessionSnapshotCodec<Value, ValueKey>,
	value: Value,
): string {
	return sessionManager.appendCustomEntry(codec.customType, createSessionSnapshotPayload(codec, value));
}

export function decodeSessionSnapshotPayload<Value extends object, ValueKey extends string>(
	data: unknown,
	codec: SessionSnapshotCodec<Value, ValueKey>,
): Value | undefined {
	if (!isVersionOneSessionSnapshotPayload(data)) return undefined;
	const value = data[codec.valueKey];
	return codec.isValue(value) ? codec.clone(value) : undefined;
}

export function getSessionSnapshots<Value extends object, ValueKey extends string>(
	entries: readonly SessionEntry[],
	codec: SessionSnapshotCodec<Value, ValueKey>,
): Value[] {
	const snapshots: Value[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== codec.customType) continue;
		const snapshot = decodeSessionSnapshotPayload(entry.data, codec);
		if (snapshot !== undefined) snapshots.push(snapshot);
	}
	return snapshots;
}

export function getLatestSessionSnapshot<Value extends object, ValueKey extends string>(
	entries: readonly SessionEntry[],
	codec: SessionSnapshotCodec<Value, ValueKey>,
): Value | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== codec.customType) continue;
		const snapshot = decodeSessionSnapshotPayload(entry.data, codec);
		if (snapshot !== undefined) return snapshot;
	}
	return undefined;
}

/**
 * Resolves the newest valid snapshot on the active branch. Malformed entries are skipped while
 * walking leaf to root so they cannot hide an older valid checkpoint.
 */
export function getLatestSessionSnapshotOnBranch<Value extends object, ValueKey extends string>(
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch">,
	codec: SessionSnapshotCodec<Value, ValueKey>,
): Value | undefined {
	let fromId: string | undefined;
	for (;;) {
		const entry = sessionManager.getLatestCustomEntryOnBranch(codec.customType, fromId);
		if (!entry) return undefined;
		const snapshot = decodeSessionSnapshotPayload(entry.data, codec);
		if (snapshot !== undefined) return snapshot;
		if (entry.parentId === null) return undefined;
		fromId = entry.parentId;
	}
}
