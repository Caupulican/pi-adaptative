/**
 * One ordered projection of every call waiting on the owner, built from the stores that hold them; no store of its own.
 *
 * Each store is read through a narrow port declared here, so this module imports no controller and performs no I/O: the
 * wiring passes the data in. The seen-state record (`decodeOwnerDecisionSeen`, `advanceOwnerDecisionSeen`) is the pure
 * part of the one state file that marks which waiting calls a returning owner has not yet been shown; its controller owns
 * the file.
 */

import { PROOF_STAKES_LEVEL_RANK, type ProofStakesLevel } from "../proof/stakes-levels.ts";
import { oneLine, truncateWithEllipsis } from "../provider-tool-text.ts";

export const OWNER_DECISION_WHAT_MAX_CHARS = 160;
/** The seen state holds at most this many keys; a waiting call past the cap is listed as new on every return. */
export const OWNER_DECISION_SEEN_MAX_KEYS = 256;

export type OwnerDecisionSource =
	| "outward_draft"
	| "goal_completion"
	| "worker_question"
	| "plan_hold"
	| "follow_up"
	| "act_ahead";

/** One call waiting on the owner. `key` is `${source}:${id}`: unique, and the handle the seen state keeps. */
export interface OwnerDecisionItem {
	readonly key: string;
	readonly source: OwnerDecisionSource;
	readonly id: string;
	/** Plain words on one line, at most `OWNER_DECISION_WHAT_MAX_CHARS` characters. */
	readonly what: string;
	/** Epoch milliseconds the call started waiting; absent when the store records no time for it. */
	readonly since?: number;
	/** A reference to the record behind the item (an id or a path), never its text. */
	readonly evidence?: string;
	/** The stakes of the waiting call. No store records one for these calls yet, so no item carries one. */
	readonly stakes?: ProofStakesLevel;
}

/** An outward action the branch holds (`outwardDraftStates`). Only a `pending` state waits on the owner. */
export interface OwnerDraftPort {
	readonly state: string;
	readonly record: { readonly id: string; readonly toolName: string; readonly preparedAt: string };
}

/** The resumable human-input request (`getResumableHumanInputSnapshot`). A `blocked_by_user_decision` request waits. */
export interface OwnerHumanInputPort {
	readonly status: string;
	readonly request: {
		readonly requestId: string;
		readonly category?: string;
		readonly createdAt: string;
		readonly questions: readonly { readonly question: string }[];
	};
}

/** A plan view (`listPlanViews`). Its owner-held steps wait on the owner while the plan is active or paused. */
export interface OwnerPlanPort {
	readonly planId: string;
	readonly title: string;
	readonly status: string;
	readonly nodes: readonly OwnerPlanNodePort[];
}

export interface OwnerPlanNodePort {
	readonly id: string;
	/** The task the step's current release runs; a worker question on this task is the same decision. */
	readonly taskId?: string;
	readonly held?: { readonly reason: string; readonly detail: string; readonly heldAt: string };
}

/** A worker outcome whose next action asks the owner (`ask_owner`). `taskId` is the task that recorded the outcome. */
export interface OwnerWorkerQuestionPort {
	readonly outcomeId: string;
	readonly question: string;
	readonly at?: string;
	readonly taskId?: string;
}

/** One act-ahead record with its entry time, and whether its saved patch is still on disk. */
export interface OwnerActAheadPort {
	readonly episode: string;
	readonly phase: string;
	readonly at: string;
	readonly patchPath?: string;
	readonly patchPresent: boolean;
}

/** One entry of the owner's follow-up document (`readOwnerFollowUps`). */
export interface OwnerFollowUpPort {
	readonly id: string;
	readonly question: string;
	readonly requestId?: string;
	readonly at?: string;
}

export interface OwnerDecisionInputs {
	readonly drafts: readonly OwnerDraftPort[];
	readonly humanInput?: OwnerHumanInputPort;
	readonly workerQuestions: readonly OwnerWorkerQuestionPort[];
	readonly plans: readonly OwnerPlanPort[];
	readonly followUps: readonly OwnerFollowUpPort[];
	readonly actAhead: readonly OwnerActAheadPort[];
}

const OPEN_PLAN_STATUSES: ReadonlySet<string> = new Set(["active", "paused"]);

/**
 * The calls waiting on the owner, most urgent first: by stakes (high, elevated, then unrated), then by when they started
 * waiting (undated last), then by key. A worker question whose task already has an owner-held plan step is dropped: the
 * plan step is the same decision, listed once.
 */
export function ownerDecisionQueue(inputs: OwnerDecisionInputs): readonly OwnerDecisionItem[] {
	const planHolds = plannedHolds(inputs.plans);
	const heldTasks = new Set(planHolds.flatMap((hold) => (hold.taskId === undefined ? [] : [hold.taskId])));
	const items: OwnerDecisionItem[] = [
		...inputs.drafts.filter((draft) => draft.state === "pending").map(draftItem),
		...goalCompletionItems(inputs.humanInput),
		...inputs.workerQuestions
			.filter((question) => question.taskId === undefined || !heldTasks.has(question.taskId))
			.map(workerQuestionItem),
		...planHolds.map((hold) => hold.item),
		...inputs.followUps.map(followUpItem),
		...actAheadItems(inputs.actAhead),
	];
	return items.sort(compareItems);
}

/** The seen state: the first time each waiting call was shown to the owner, bounded to the keys still waiting. */
export interface OwnerDecisionSeenState {
	readonly v: 1;
	readonly seen: Readonly<Record<string, number>>;
}

/** The state a file holds, or undefined when it is not one this build wrote (another version, or malformed). */
export function decodeOwnerDecisionSeen(raw: unknown): OwnerDecisionSeenState | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	if (Reflect.get(raw, "v") !== 1) return undefined;
	const seen: unknown = Reflect.get(raw, "seen");
	if (typeof seen !== "object" || seen === null || Array.isArray(seen)) return undefined;
	const entries = Object.entries(seen);
	if (entries.length > OWNER_DECISION_SEEN_MAX_KEYS) return undefined;
	const record: Record<string, number> = {};
	for (const [key, firstSeen] of entries) {
		if (typeof firstSeen !== "number" || !Number.isFinite(firstSeen)) return undefined;
		record[key] = firstSeen;
	}
	return { v: 1, seen: record };
}

/**
 * The seen state after the owner was shown `queue` at `now`: a key already seen keeps its first-seen time, a new key takes
 * `now`, and the state holds only the keys still waiting (at most `OWNER_DECISION_SEEN_MAX_KEYS`, in queue order).
 * `newKeys` are the waiting keys the previous state did not hold. Pure: the caller writes the state only when a brief renders.
 */
export function advanceOwnerDecisionSeen(
	previous: OwnerDecisionSeenState | undefined,
	queue: readonly OwnerDecisionItem[],
	now: number,
): { readonly state: OwnerDecisionSeenState; readonly newKeys: ReadonlySet<string> } {
	const before = new Map(Object.entries(previous?.seen ?? {}));
	const seen: Record<string, number> = {};
	const newKeys = new Set<string>();
	for (const item of queue.slice(0, OWNER_DECISION_SEEN_MAX_KEYS)) {
		const firstSeen = before.get(item.key);
		if (firstSeen === undefined) newKeys.add(item.key);
		seen[item.key] = firstSeen ?? now;
	}
	return { state: { v: 1, seen }, newKeys };
}

interface PlannedHold {
	readonly taskId?: string;
	readonly item: OwnerDecisionItem;
}

function plannedHolds(plans: readonly OwnerPlanPort[]): PlannedHold[] {
	const holds: PlannedHold[] = [];
	for (const plan of plans) {
		if (!OPEN_PLAN_STATUSES.has(plan.status)) continue;
		for (const node of plan.nodes) {
			if (node.held?.reason !== "owner") continue;
			const id = `${plan.planId}/${node.id}`;
			holds.push({
				...(node.taskId === undefined ? {} : { taskId: node.taskId }),
				item: makeItem(
					"plan_hold",
					id,
					clipWhat(`${oneLine(node.held.detail) || "A plan step needs your decision"} (plan "${plan.title}")`),
					node.held.heldAt,
					id,
				),
			});
		}
	}
	return holds;
}

function draftItem(draft: OwnerDraftPort): OwnerDecisionItem {
	return makeItem(
		"outward_draft",
		draft.record.id,
		phrase("Action held for your approval", draft.record.toolName),
		draft.record.preparedAt,
		draft.record.id,
	);
}

function goalCompletionItems(snapshot: OwnerHumanInputPort | undefined): OwnerDecisionItem[] {
	if (snapshot?.status !== "pending" || snapshot.request.category !== "blocked_by_user_decision") return [];
	const question = snapshot.request.questions.at(0)?.question ?? "";
	return [
		makeItem(
			"goal_completion",
			snapshot.request.requestId,
			whatOr(question, "A decision is waiting on you; no question text was recorded"),
			snapshot.request.createdAt,
			snapshot.request.requestId,
		),
	];
}

function workerQuestionItem(question: OwnerWorkerQuestionPort): OwnerDecisionItem {
	return makeItem(
		"worker_question",
		question.outcomeId,
		phrase("A worker is waiting for your decision", question.question),
		question.at,
		question.outcomeId,
	);
}

function followUpItem(entry: OwnerFollowUpPort): OwnerDecisionItem {
	return makeItem(
		"follow_up",
		entry.id,
		whatOr(entry.question, "A follow-up question was recorded without text"),
		entry.at,
		entry.requestId,
	);
}

function actAheadItems(records: readonly OwnerActAheadPort[]): OwnerDecisionItem[] {
	const items: OwnerDecisionItem[] = [];
	for (const record of records) {
		// One `ready` record per episode: the controller settles the episode right after it.
		// A patch that is no longer on disk is not a decision the owner can make.
		if (record.phase !== "ready" || record.patchPath === undefined || !record.patchPresent) continue;
		items.push(
			makeItem(
				"act_ahead",
				record.episode,
				"A fix for a failing CI run is ready to review",
				record.at,
				record.patchPath,
			),
		);
	}
	return items;
}

function makeItem(
	source: OwnerDecisionSource,
	id: string,
	what: string,
	since: string | undefined,
	evidence: string | undefined,
): OwnerDecisionItem {
	const firstSeen = since === undefined ? Number.NaN : Date.parse(since);
	return {
		key: `${source}:${id}`,
		source,
		id,
		what,
		...(Number.isFinite(firstSeen) ? { since: firstSeen } : {}),
		...(evidence === undefined ? {} : { evidence }),
	};
}

/** `text` as one line within the item's `what` bound. */
function clipWhat(text: string): string {
	return truncateWithEllipsis(oneLine(text), OWNER_DECISION_WHAT_MAX_CHARS);
}

/** `text` as one line, or the fallback when the text holds no words. */
function whatOr(text: string, fallback: string): string {
	return clipWhat(oneLine(text) === "" ? fallback : text);
}

/** `prefix: detail`, or the prefix alone when the detail is empty. */
function phrase(prefix: string, detail: string): string {
	const normalized = oneLine(detail);
	return clipWhat(normalized.length > 0 ? `${prefix}: ${normalized}` : prefix);
}

function rankOf(level: ProofStakesLevel | undefined): number {
	return level === undefined ? -1 : PROOF_STAKES_LEVEL_RANK[level];
}

function compareItems(left: OwnerDecisionItem, right: OwnerDecisionItem): number {
	const byStakes = rankOf(right.stakes) - rankOf(left.stakes);
	if (byStakes !== 0) return byStakes;
	const bySince = compareSince(left.since, right.since);
	if (bySince !== 0) return bySince;
	return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/** Earlier first; undated items after every dated one. */
function compareSince(left: number | undefined, right: number | undefined): number {
	if (left === undefined) return right === undefined ? 0 : 1;
	if (right === undefined) return -1;
	return left - right;
}
