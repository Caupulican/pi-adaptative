import type { SessionManager } from "@caupulican/pi-agent-core/session";

/**
 * Session custom entry marking where a unit of work began (conversation-continuity stage 2, the
 * boundary): `declared` when a goal starts, `enforced` when the first mutating tool call arrives with no
 * work declared. What a delivery claims is checked against what happened since (see `workUnitStartEntryId`).
 */
export const WORK_UNIT_CUSTOM_TYPE = "work_unit";

export interface WorkUnitRecord {
	readonly kind: "declared" | "enforced";
	readonly goalId?: string;
	/** The branch entry the unit started after: everything recorded after it belongs to the unit. */
	readonly startEntryId: string | null;
	readonly openedAt: number;
	/** What opened it: the goal's objective or the first mutating tool. */
	readonly reason: string;
}

type WorkUnitSessionView = Pick<SessionManager, "getLeafEntry" | "getEntry" | "appendCustomEntry">;

/**
 * The work unit the current branch is in: the latest `work_unit` entry, walking back from the leaf, when
 * no owner message came after it. An owner message returns the conversation to the talker, so a unit
 * opened before it is over; a declared unit stays open for as long as its goal is being worked.
 */
export function currentWorkUnit(
	manager: WorkUnitSessionView,
	activeGoalId?: string,
): { entryId: string; record: WorkUnitRecord } | undefined {
	let passedOwnerMessage = false;
	for (
		let entry = manager.getLeafEntry();
		entry;
		entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined
	) {
		if (entry.type === "custom" && entry.customType === WORK_UNIT_CUSTOM_TYPE) {
			const record = entry.data as WorkUnitRecord | undefined;
			if (!record) continue;
			if (record.kind === "declared" && record.goalId !== undefined && record.goalId === activeGoalId) {
				return { entryId: entry.id, record };
			}
			return passedOwnerMessage ? undefined : { entryId: entry.id, record };
		}
		if (entry.type === "message" && entry.message.role === "user") {
			// Without a goal being worked only a unit after the owner's last message counts: stop here.
			if (activeGoalId === undefined) return undefined;
			passedOwnerMessage = true;
		}
	}
	return undefined;
}

/** Open a work unit at the current leaf. */
export function openWorkUnit(
	manager: WorkUnitSessionView,
	record: Omit<WorkUnitRecord, "startEntryId" | "openedAt">,
): string {
	const full: WorkUnitRecord = { ...record, startEntryId: manager.getLeafEntry()?.id ?? null, openedAt: Date.now() };
	return manager.appendCustomEntry(WORK_UNIT_CUSTOM_TYPE, full);
}
