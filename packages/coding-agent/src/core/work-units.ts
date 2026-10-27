import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { AgentMessage } from "../kernel/types.ts";

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
	startEntryId: string | null = manager.getLeafEntry()?.id ?? null,
): string {
	const full: WorkUnitRecord = { ...record, startEntryId, openedAt: Date.now() };
	return manager.appendCustomEntry(WORK_UNIT_CUSTOM_TYPE, full);
}

/** Session custom entry recording a worker's receipts once its report was accepted (see claim-delivery.ts). */
export const WORKER_RECEIPTS_CUSTOM_TYPE = "worker_receipts";

export type WorkWindowEntry =
	| { kind: "message"; message: AgentMessage }
	| { kind: "custom"; entryId: string; data: unknown };

function collectWorkWindow(
	manager: Pick<SessionManager, "getLeafEntry" | "getEntry">,
	customType: string,
	openingEntryId?: string,
): { entries: WorkWindowEntry[]; startEntryId: string | null; workUnit?: WorkUnitRecord } | undefined {
	const entries: WorkWindowEntry[] = [];
	let workUnit: WorkUnitRecord | undefined;
	let startEntryId: string | null | undefined = openingEntryId;
	let reachedOpening = false;
	for (
		let entry = manager.getLeafEntry();
		entry;
		entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined
	) {
		if (entry.type === "message") entries.push({ kind: "message", message: entry.message });
		else if (entry.type === "custom" && entry.customType === customType)
			entries.push({ kind: "custom", entryId: entry.id, data: entry.data });
		else if (entry.type === "custom" && entry.customType === WORK_UNIT_CUSTOM_TYPE && startEntryId === undefined) {
			const record = entry.data as WorkUnitRecord | undefined;
			startEntryId = record?.startEntryId ?? null;
			if (
				record &&
				(record.kind === "declared" || record.kind === "enforced") &&
				typeof record.reason === "string" &&
				typeof record.openedAt === "number" &&
				Number.isFinite(record.openedAt) &&
				record.openedAt >= 0 &&
				(record.startEntryId === null || typeof record.startEntryId === "string")
			)
				workUnit = {
					kind: record.kind,
					reason: record.reason,
					openedAt: record.openedAt,
					startEntryId: record.startEntryId,
					...(typeof record.goalId === "string" ? { goalId: record.goalId } : {}),
				};
			if (startEntryId === null) break;
		}
		if (startEntryId !== undefined && entry.id === startEntryId) {
			reachedOpening = true;
			break;
		}
	}
	if (openingEntryId !== undefined && !reachedOpening)
		throw new Error(`Turn opening entry ${openingEntryId} is not on the active branch.`);
	return startEntryId === undefined
		? undefined
		: { entries: entries.reverse(), startEntryId, ...(workUnit ? { workUnit } : {}) };
}

/**
 * The most recent work unit's messages and custom records in branch order. Reading the branch
 * preserves both sides of a tool call across compaction and the position of intervening worker receipts.
 * Undefined when no work unit was ever opened on the branch.
 */
export function workUnitWindow(
	manager: Pick<SessionManager, "getLeafEntry" | "getEntry">,
	customType: string,
): { entries: WorkWindowEntry[]; startEntryId: string | null; workUnit?: WorkUnitRecord } | undefined {
	return collectWorkWindow(manager, customType);
}

/**
 * The same ordered view for a turn with no work unit, bounded by its exact opening entry.
 * A later steering message is not a new boundary for work already performed in this turn.
 */
export function turnWorkWindow(
	manager: Pick<SessionManager, "getLeafEntry" | "getEntry">,
	customType: string,
	openingEntryId: string,
): WorkWindowEntry[] {
	return collectWorkWindow(manager, customType, openingEntryId)!.entries;
}
