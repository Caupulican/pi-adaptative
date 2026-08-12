/**
 * Live lane registry for autonomous background work (research/worker/learning lanes).
 *
 * This is the first real concurrency tracker behind `AutonomyStatusSnapshot.activeLaneCount`:
 * counts reflect lanes actually running in THIS process, never inferred/faked from historical
 * snapshots. Terminal lane records are persisted separately via `session-lane-record.ts`.
 */

import { ORCHESTRATION_THINKING_LEVELS, type OrchestrationThinkingLevel } from "../orchestration/contracts.ts";

export type LaneType = "research" | "worker" | "learning" | "tmux-worker";

export type LaneTerminalStatus =
	| "succeeded"
	| "partial"
	| "blocked"
	| "failed"
	| "canceled"
	| "timeout"
	| "budget_exhausted";

export type LaneStatus = "queued" | "running" | LaneTerminalStatus;

export interface LaneRecord {
	laneId: string;
	type: LaneType;
	status: LaneStatus;
	/** Bounded human-readable work label retained across session resume. */
	label?: string;
	/** Owner-authored profile that fixed the worker's model, thinking, tools, and budget. */
	profileId?: string;
	/** Effective provider/model admitted into the immutable worker execution contract. */
	modelRef?: string;
	/** Effective thinking level admitted with modelRef. */
	thinkingLevel?: OrchestrationThinkingLevel;
	reasonCode?: string;
	startedAt?: string;
	completedAt?: string;
	costUsd?: number;
	goalId?: string;
	evidenceEntryId?: string;
	/**
	 * Worktree-sync lane key this lane record was correlated to at dispatch (set only for a
	 * tmux-worker lane whose fire_task carried a `worktreeLane` -- see `tmux-dispatch.ts`'s
	 * `createLaneWorktree`). Optional so every pre-existing record/caller keeps compiling and
	 * behaving unchanged; `undefined` for a lane never bound to a worktree-sync lane.
	 */
	worktreeLaneKey?: string;
}

const LANE_TYPES: readonly string[] = ["research", "worker", "learning", "tmux-worker"];
const TERMINAL_STATUSES: readonly string[] = [
	"succeeded",
	"partial",
	"blocked",
	"failed",
	"canceled",
	"timeout",
	"budget_exhausted",
];
const LANE_STATUSES: readonly string[] = ["queued", "running", ...TERMINAL_STATUSES];
const ORCHESTRATION_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(ORCHESTRATION_THINKING_LEVELS);

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
	if (!isOptionalString(record.label)) return false;
	if (!isOptionalString(record.profileId)) return false;
	if (!isOptionalString(record.modelRef)) return false;
	if (
		record.thinkingLevel !== undefined &&
		(typeof record.thinkingLevel !== "string" || !ORCHESTRATION_THINKING_LEVEL_SET.has(record.thinkingLevel))
	) {
		return false;
	}
	if (!isOptionalString(record.reasonCode)) return false;
	if (!isOptionalString(record.startedAt)) return false;
	if (!isOptionalString(record.completedAt)) return false;
	if (record.costUsd !== undefined && (typeof record.costUsd !== "number" || !Number.isFinite(record.costUsd))) {
		return false;
	}
	if (!isOptionalString(record.goalId)) return false;
	if (!isOptionalString(record.evidenceEntryId)) return false;
	if (!isOptionalString(record.worktreeLaneKey)) return false;
	return true;
}

export function cloneLaneRecordForStorage(record: LaneRecord): LaneRecord {
	return { ...record };
}

/** Terminal records kept in memory for diagnostics; older ones are evicted (the session log holds history). */
const MAX_TERMINAL_LANES_IN_MEMORY = 100;

export class LaneTracker {
	private readonly _lanes = new Map<string, LaneRecord>();
	private _nextLaneNumber = 1;
	private readonly _now: () => string;

	constructor(options?: { now?: () => string }) {
		this._now = options?.now ?? (() => new Date().toISOString());
	}

	/** Seed the id counter (e.g. from persisted lane records) so resumed sessions don't reuse ids. */
	ensureCounterAtLeast(next: number): void {
		if (Number.isFinite(next) && next > this._nextLaneNumber) {
			this._nextLaneNumber = Math.floor(next);
		}
	}

	private _evictOldTerminal(): void {
		let terminal = 0;
		for (const record of this._lanes.values()) {
			if (isLaneTerminalStatus(record.status)) terminal++;
		}
		if (terminal <= MAX_TERMINAL_LANES_IN_MEMORY) return;
		// Map iteration is insertion-ordered: drop oldest terminal records first.
		for (const [laneId, record] of this._lanes) {
			if (terminal <= MAX_TERMINAL_LANES_IN_MEMORY) break;
			if (isLaneTerminalStatus(record.status)) {
				this._lanes.delete(laneId);
				terminal--;
			}
		}
	}

	enqueue(args: { type: LaneType; goalId?: string; worktreeLaneKey?: string }): LaneRecord {
		const laneId = `${args.type}-${this._nextLaneNumber++}`;
		const record: LaneRecord = {
			laneId,
			type: args.type,
			status: "queued",
		};
		if (args.goalId !== undefined) record.goalId = args.goalId;
		if (args.worktreeLaneKey !== undefined) record.worktreeLaneKey = args.worktreeLaneKey;
		this._lanes.set(laneId, record);
		return { ...record };
	}

	/** Restore an exact durable projection without minting a replacement logical id or timestamp. */
	restore(record: LaneRecord): LaneRecord {
		const restored = { ...record };
		this._lanes.set(restored.laneId, restored);
		const suffix = /-(\d+)$/.exec(restored.laneId)?.[1];
		if (suffix) this.ensureCounterAtLeast(Number(suffix) + 1);
		this._evictOldTerminal();
		return { ...restored };
	}

	/** Start or restart a caller-named lane. The supplied id is its durable logical identity. */
	startNamed(args: { laneId: string; type: LaneType; goalId?: string; worktreeLaneKey?: string }): LaneRecord {
		if (!args.laneId) throw new TypeError("A named lane requires a non-empty laneId.");
		const record: LaneRecord = {
			laneId: args.laneId,
			type: args.type,
			status: "running",
			startedAt: this._now(),
		};
		if (args.goalId !== undefined) record.goalId = args.goalId;
		if (args.worktreeLaneKey !== undefined) record.worktreeLaneKey = args.worktreeLaneKey;
		this._lanes.set(record.laneId, record);
		const suffix = /-(\d+)$/.exec(record.laneId)?.[1];
		if (suffix) this.ensureCounterAtLeast(Number(suffix) + 1);
		return { ...record };
	}

	markRunning(laneId: string): LaneRecord | undefined {
		const record = this._lanes.get(laneId);
		if (!record || record.status !== "queued") return undefined;
		const next = { ...record, status: "running" as const, startedAt: this._now() };
		this._lanes.set(laneId, next);
		return { ...next };
	}

	start(args: { type: LaneType; goalId?: string; worktreeLaneKey?: string }): LaneRecord {
		const record = this.enqueue(args);
		return this.markRunning(record.laneId) as LaneRecord;
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
		this._evictOldTerminal();
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

	getRunningCount(type?: LaneType): number {
		let count = 0;
		for (const record of this._lanes.values()) {
			if (record.status !== "running") continue;
			if (type !== undefined && record.type !== type) continue;
			count++;
		}
		return count;
	}

	getRecords(): LaneRecord[] {
		return [...this._lanes.values()].map((record) => ({ ...record }));
	}

	getRecord(laneId: string): LaneRecord | undefined {
		const record = this._lanes.get(laneId);
		return record ? { ...record } : undefined;
	}
}
