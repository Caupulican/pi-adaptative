/**
 * Live lane registry for autonomous background work (research/worker/learning lanes).
 *
 * This is the first real concurrency tracker behind `AutonomyStatusSnapshot.activeLaneCount`:
 * counts reflect lanes actually running in THIS process, never inferred/faked from historical
 * snapshots. Terminal lane records are persisted separately via `session-lane-record.ts`.
 */

export type LaneType = "research" | "worker" | "learning";

export type LaneTerminalStatus = "succeeded" | "failed" | "canceled" | "timeout" | "budget_exhausted";

export type LaneStatus = "queued" | "running" | LaneTerminalStatus;

export interface LaneRecord {
	laneId: string;
	type: LaneType;
	status: LaneStatus;
	reasonCode?: string;
	startedAt?: string;
	completedAt?: string;
	costUsd?: number;
	goalId?: string;
	evidenceEntryId?: string;
}

const LANE_TYPES: readonly string[] = ["research", "worker", "learning"];
const TERMINAL_STATUSES: readonly string[] = ["succeeded", "failed", "canceled", "timeout", "budget_exhausted"];
const LANE_STATUSES: readonly string[] = ["queued", "running", ...TERMINAL_STATUSES];

export function isLaneTerminalStatus(value: unknown): value is LaneTerminalStatus {
	return typeof value === "string" && TERMINAL_STATUSES.includes(value);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

export function isLaneRecord(value: unknown): value is LaneRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.laneId !== "string" || record.laneId.length === 0) return false;
	if (typeof record.type !== "string" || !LANE_TYPES.includes(record.type)) return false;
	if (typeof record.status !== "string" || !LANE_STATUSES.includes(record.status)) return false;
	if (!isOptionalString(record.reasonCode)) return false;
	if (!isOptionalString(record.startedAt)) return false;
	if (!isOptionalString(record.completedAt)) return false;
	if (record.costUsd !== undefined && (typeof record.costUsd !== "number" || !Number.isFinite(record.costUsd))) {
		return false;
	}
	if (!isOptionalString(record.goalId)) return false;
	if (!isOptionalString(record.evidenceEntryId)) return false;
	return true;
}

export function cloneLaneRecordForStorage(record: LaneRecord): LaneRecord {
	return { ...record };
}

export class LaneTracker {
	private readonly _lanes = new Map<string, LaneRecord>();
	private _nextLaneNumber = 1;
	private readonly _now: () => string;

	constructor(options?: { now?: () => string }) {
		this._now = options?.now ?? (() => new Date().toISOString());
	}

	start(args: { type: LaneType; goalId?: string }): LaneRecord {
		const laneId = `${args.type}-${this._nextLaneNumber++}`;
		const record: LaneRecord = {
			laneId,
			type: args.type,
			status: "running",
			startedAt: this._now(),
		};
		if (args.goalId !== undefined) record.goalId = args.goalId;
		this._lanes.set(laneId, record);
		return { ...record };
	}

	complete(
		laneId: string,
		args: { status: LaneTerminalStatus; reasonCode?: string; costUsd?: number; evidenceEntryId?: string },
	): LaneRecord | undefined {
		const record = this._lanes.get(laneId);
		if (!record || isLaneTerminalStatus(record.status)) return undefined;
		const next: LaneRecord = {
			...record,
			status: args.status,
			completedAt: this._now(),
		};
		if (args.reasonCode !== undefined) next.reasonCode = args.reasonCode;
		if (args.costUsd !== undefined) next.costUsd = args.costUsd;
		if (args.evidenceEntryId !== undefined) next.evidenceEntryId = args.evidenceEntryId;
		this._lanes.set(laneId, next);
		return { ...next };
	}

	getActiveCount(type?: LaneType): number {
		let count = 0;
		for (const record of this._lanes.values()) {
			if (isLaneTerminalStatus(record.status)) continue;
			if (type !== undefined && record.type !== type) continue;
			count++;
		}
		return count;
	}

	getRecords(): LaneRecord[] {
		return [...this._lanes.values()].map((record) => ({ ...record }));
	}
}
