import type { SessionManager } from "../kernel/session/session-manager.ts";
import { isPlainRecord } from "./util/value-guards.ts";

export const MAX_PERSISTED_CUSTOM_ENTRY_BYTES = 64 * 1024;

/** Confirm an exact canonical JSONL row, rather than a buffered in-memory append. */
export function classifyCustomEntryPersisted(
	session: Pick<SessionManager, "readEntryJsonPrefix">,
	entryId: string,
	customType: string,
	matches: (data: unknown) => boolean,
): "persisted" | "pending" | "conflict" {
	const json = session.readEntryJsonPrefix(entryId, MAX_PERSISTED_CUSTOM_ENTRY_BYTES);
	if (json === undefined) return "pending";
	let persisted: unknown;
	try {
		persisted = JSON.parse(json);
	} catch (error) {
		if (error instanceof SyntaxError) return "pending";
		throw error;
	}
	if (
		!isPlainRecord(persisted) ||
		persisted.id !== entryId ||
		persisted.type !== "custom" ||
		persisted.customType !== customType ||
		!matches(persisted.data)
	)
		return "conflict";
	return "persisted";
}
