import type { ContinuousChatRecord } from "./continuous-chat-contracts.ts";

export const PARENT_INPUT_PROJECTION_REVISION = 1;
export type ParentProjectionState = "unreviewed" | "unchanged" | "superseded" | "quarantined";

export interface ParentProjectionGroup {
	readonly sessionId: string;
	readonly entryId: string;
	readonly firstRecord: ContinuousChatRecord;
	readonly recordCount: number;
	readonly state: ParentProjectionState;
}

export interface ParentProjectionDecision {
	readonly sessionId: string;
	readonly entryId: string;
	readonly state: Exclude<ParentProjectionState, "unreviewed">;
}

/** Projection metadata and progress have one owner, the canonical ICM store. */
export interface ParentProjectionReconciliationPort {
	listParentProjectionSessionIds(
		after?: string,
		limit?: number,
		signal?: AbortSignal,
	): Promise<{ readonly sessionIds: readonly string[]; readonly nextSessionId?: string }>;
	listParentProjectionGroups(
		sessionId: string,
		afterEntryId?: string,
		limit?: number,
		signal?: AbortSignal,
	): Promise<{ readonly groups: readonly ParentProjectionGroup[]; readonly nextEntryId?: string }>;
	applyParentProjectionDecisions(decisions: readonly ParentProjectionDecision[], signal?: AbortSignal): Promise<void>;
	parentProjectionSourceReplayed(sessionId: string): Promise<boolean>;
	markParentProjectionSourceReplayed(sessionId: string, signal?: AbortSignal): Promise<void>;
	noteParentProjectionSourceUnavailable(sessionId: string, reason: string, signal?: AbortSignal): Promise<void>;
	finishParentProjectionPass(
		signal?: AbortSignal,
	): Promise<{ readonly unresolvedGroups: number; readonly unresolvedSources: number }>;
}

/**
 * Old keys are exact source-derived namespaces; new consumption keys include both session and entry.
 *
 * @deprecated Recognizes parent-projection keys written before session and entry joined the consumption key; remove when no such key can remain in a session file.
 */
export function legacyParentProjectionFamily(record: ContinuousChatRecord): "canonical" | "legacy" | undefined {
	const source = record.source;
	if (!source) return undefined;
	if (record.sourceKey === `parent:${source.entryId}:0:${source.unit}`) return "canonical";
	if (record.sourceKey === `${source.sessionId}:${source.entryId}:0:${source.unit}`) return "legacy";
	return undefined;
}

/**
 * A legacy envelope is a lookup candidate only; canonical source evidence decides its final state.
 *
 * @deprecated Recognizes a parent-projection envelope written before session and entry joined the consumption key; remove with legacyParentProjectionFamily.
 */
export function isLegacyParentProjectionCandidate(record: ContinuousChatRecord): boolean {
	const family = legacyParentProjectionFamily(record);
	if (family === "canonical") return true;
	return (
		family === "legacy" &&
		record.kind === "note" &&
		record.source?.unit === 0 &&
		/^work: \[Harness background (?:delivery|wake) [^\]\r\n]+; not owner-authored evidence\] /.test(record.text)
	);
}
