import { sessionHistoryMessage } from "../kernel/session/session-context-builder.ts";
import { GOAL_STATE_CUSTOM_TYPE, type SessionEntry } from "../kernel/session/session-entries.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { AgentMessage } from "../kernel/types.ts";
import { BACKGROUND_TOOL_COMPLETION_TYPE } from "./background-tool-handoff-text.ts";
import { decodeGoalJournalPayload, decodeGoalStateSnapshotPayload } from "./goals/session-goal-state.ts";
import { isPlainRecord } from "./util/value-guards.ts";

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

/** Read backwards on one branch. Old declarations count once a subsequent goal entry confirms the allocation. */
function branchWorkUnitReader() {
	let followingGoalId: string | undefined;
	return (entry: SessionEntry): WorkUnitRecord | undefined => {
		if (entry.type !== "custom") return undefined;
		if (entry.customType === GOAL_STATE_CUSTOM_TYPE) {
			const data = entry.data;
			if (!isPlainRecord(data)) return undefined;
			if (data.kind === "events") return undefined;
			const journal = data.kind === "checkpoint" ? decodeGoalJournalPayload(data) : undefined;
			const state = journal?.kind === "checkpoint" ? journal.state : decodeGoalStateSnapshotPayload(data);
			followingGoalId = state?.goalId;
			if (journal?.kind === "checkpoint" && journal.opensWorkUnit)
				return {
					kind: "declared",
					goalId: journal.state.goalId,
					reason: journal.state.userGoal,
					openedAt: Date.parse(entry.timestamp),
					startEntryId: entry.parentId,
				};
			return undefined;
		}
		if (entry.customType !== WORK_UNIT_CUSTOM_TYPE || !isPlainRecord(entry.data)) return undefined;
		const { kind, goalId, reason, openedAt, startEntryId } = entry.data;
		if (
			(kind !== "enforced" && !(kind === "declared" && typeof goalId === "string" && followingGoalId === goalId)) ||
			typeof reason !== "string" ||
			typeof openedAt !== "number" ||
			!Number.isFinite(openedAt) ||
			openedAt < 0 ||
			(startEntryId !== null && typeof startEntryId !== "string")
		)
			return undefined;
		return { kind, reason, openedAt, startEntryId, ...(typeof goalId === "string" ? { goalId } : {}) };
	};
}

/**
 * The work unit the current branch is in: the latest `work_unit` entry, walking back from the leaf, when
 * no owner message came after it. An owner message returns the conversation to the talker, so a unit
 * opened before it is over; a declared unit stays open for as long as its goal is being worked.
 */
export function currentWorkUnit(
	manager: Pick<WorkUnitSessionView, "getLeafEntry" | "getEntry">,
	activeGoalId?: string,
): { entryId: string; record: WorkUnitRecord } | undefined {
	let passedOwnerMessage = false;
	const readUnit = branchWorkUnitReader();
	for (
		let entry = manager.getLeafEntry();
		entry;
		entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined
	) {
		const record = readUnit(entry);
		if (record) {
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

export function noteMutatingWorkUnit(
	manager: WorkUnitSessionView,
	activeGoalId: string | undefined,
	toolName: string,
	assistantEntryId: () => string | undefined,
): void {
	if (currentWorkUnit(manager, activeGoalId)) return;
	const entryId = assistantEntryId();
	if (!entryId) throw new Error("Cannot open a work unit before its mutating assistant message is persisted.");
	manager.appendCustomEntry(WORK_UNIT_CUSTOM_TYPE, {
		kind: "enforced",
		reason: `first mutating call: ${toolName}`,
		startEntryId: entryId,
		openedAt: Date.now(),
	} satisfies WorkUnitRecord);
}

/** Session custom entry recording a worker's receipts once its report was accepted (see claim-delivery.ts). */
export const WORKER_RECEIPTS_CUSTOM_TYPE = "worker_receipts";

export type WorkWindowEntry =
	| { kind: "message"; message: AgentMessage }
	| { kind: "custom"; entryId: string; data: unknown };

function collectWorkWindow(
	manager: Pick<SessionManager, "getLeafEntry" | "getEntry">,
	customType: string,
	openingEntryId?: string | null,
): { entries: WorkWindowEntry[]; startEntryId: string | null; workUnit?: WorkUnitRecord } | undefined {
	const entries: WorkWindowEntry[] = [];
	let workUnit: WorkUnitRecord | undefined;
	let startEntryId: string | null | undefined = openingEntryId;
	let reachedOpening = false;
	const readUnit = branchWorkUnitReader();
	for (
		let entry = manager.getLeafEntry();
		entry;
		entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined
	) {
		if (entry.type === "message") entries.push({ kind: "message", message: entry.message });
		else if (entry.type === "custom_message" && entry.customType === BACKGROUND_TOOL_COMPLETION_TYPE) {
			const message = sessionHistoryMessage(entry);
			if (message) entries.push({ kind: "message", message });
		} else if (entry.type === "custom" && entry.customType === customType)
			entries.push({ kind: "custom", entryId: entry.id, data: entry.data });
		else if (startEntryId === undefined) {
			workUnit = readUnit(entry);
			if (workUnit) {
				startEntryId = workUnit.startEntryId;
				if (startEntryId === null) break;
			}
		}
		if (startEntryId !== undefined && entry.id === startEntryId) {
			reachedOpening = true;
			break;
		}
	}
	if (typeof openingEntryId === "string" && !reachedOpening)
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

/**
 * The same ordered view from an explicit boundary entry (null: the whole branch) to the leaf, for a window whose
 * boundary an earlier check recorded. A later work unit does not move it. Throws when the entry left the branch.
 */
export function workWindowFrom(
	manager: Pick<SessionManager, "getLeafEntry" | "getEntry">,
	customType: string,
	startEntryId: string | null,
): WorkWindowEntry[] {
	return collectWorkWindow(manager, customType, startEntryId)!.entries;
}
