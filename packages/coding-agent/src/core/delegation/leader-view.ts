/**
 * Plain words for delegations: the one text source for the Leaders rows of the Orchestration panel and the `/lead`
 * listing. No ids and no codes; a leader is named by its display name and the goal by its own words.
 */

import { boundedText } from "../util/bounded-line.ts";
import type { DelegationRecord } from "./leader-delegation-ledger.ts";
import { describeNextAction } from "./worker-outcome-words.ts";

export type LeaderRowTone = "working" | "waiting" | "paused" | "done" | "attention";

export interface LeaderRow {
	/** The leader's bot id: what `/lead` takes. Shown only where a command needs it. */
	readonly leader: string;
	readonly name: string;
	readonly goal: string;
	readonly state: string;
	readonly tone: LeaderRowTone;
	readonly open: boolean;
}

/** How many ended goals the panel keeps beside the open ones. */
export const LEADER_ROWS_RECENT_CLOSED = 3;

/** The open delegation a leader is working, else the oldest open one waiting for it. */
export function currentDelegationFor(
	records: readonly DelegationRecord[],
	leader: string,
): DelegationRecord | undefined {
	const open = records.filter((record) => record.state !== "closed" && record.charter.leader === leader);
	return open.find((record) => record.state !== "queued") ?? open[0];
}

function goalWords(record: DelegationRecord): string {
	return boundedText(record.title.replace(/^Lead: /, ""), 80);
}

/** One row: who leads, which goal, and where it stands. */
export function leaderRow(record: DelegationRecord, displayName: (alias: string) => string): LeaderRow {
	const base = { leader: record.charter.leader, name: displayName(record.charter.leader), goal: goalWords(record) };
	switch (record.state) {
		case "queued":
			return { ...base, state: "Waiting to start", tone: "waiting", open: true };
		case "paused":
			return { ...base, state: "Paused", tone: "paused", open: true };
		case "running":
			return { ...base, state: "Working", tone: "working", open: true };
		default: {
			const outcome = record.outcome;
			return {
				...base,
				state: outcome ? describeNextAction(outcome) : "Ended",
				tone: outcome?.status === "succeeded" ? "done" : "attention",
				open: false,
			};
		}
	}
}

/** The most recent ended delegations, then the open ones: oldest first, so the newest work sits last. */
export function leaderRows(
	records: readonly DelegationRecord[],
	displayName: (alias: string) => string,
	recentClosed = LEADER_ROWS_RECENT_CLOSED,
): LeaderRow[] {
	const open = records.filter((record) => record.state !== "closed");
	const closed = records.filter((record) => record.state === "closed").slice(-recentClosed);
	return [...closed, ...open].map((record) => leaderRow(record, displayName));
}
