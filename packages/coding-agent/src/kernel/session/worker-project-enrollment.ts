import { isPlainRecord } from "../utils/value-guards.ts";
import { MAX_SESSION_ENTRY_VISIT_COUNT } from "./session-entry-limits.ts";
import type { ReadonlySessionManager } from "./session-manager.ts";

export const WORKER_PROJECT_ENROLLMENT_CUSTOM_TYPE = "worker-project-enrollment-v1";

const projectEnrollmentIndices = new WeakMap<
	ReadonlySessionManager,
	{ header: object | null; count: number; key?: string }
>();

/** Append-only enrollment makes dropping the metadata envelope a refusal, never a legacy fallback. */
export function projectEnrollmentKey(session: ReadonlySessionManager): string | undefined {
	let index = projectEnrollmentIndices.get(session);
	const header = session.getHeader();
	if (!index || index.header !== header || index.count > session.getEntryCount()) index = { header, count: 0 };
	const current = index;
	const visit = (entry: ReturnType<ReadonlySessionManager["getEntries"]>[number]) => {
		if (entry.type !== "custom" || entry.customType !== WORKER_PROJECT_ENROLLMENT_CUSTOM_TYPE) return;
		if (
			current.key ||
			!isPlainRecord(entry.data) ||
			typeof entry.data.specializationKey !== "string" ||
			Object.keys(entry.data).length !== 1 ||
			!/^[a-f0-9]{64}$/.test(entry.data.specializationKey)
		)
			throw new Error("Worker project enrollment is invalid.");
		current.key = entry.data.specializationKey;
	};
	let cursor = current.count;
	while (cursor < session.getEntryCount()) {
		cursor = session.visitEntries(
			cursor,
			Math.min(MAX_SESSION_ENTRY_VISIT_COUNT, session.getEntryCount() - cursor),
			visit,
		);
	}
	current.count = session.getEntryCount();
	projectEnrollmentIndices.set(session, current);
	return current.key;
}
