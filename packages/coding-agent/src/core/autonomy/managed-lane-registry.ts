import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { registerInFlightWork } from "../reload-blockers.ts";
import { getActiveSessionBranchEntries } from "../session-snapshot.ts";
import type { LaneRecord, LaneTerminalStatus, LaneTracker } from "./lane-tracker.ts";
import { appendLaneRecordSnapshot, getLatestLaneRecordSnapshots } from "./session-lane-record.ts";

interface ManagedLaneCorrelation {
	deregister?: () => void;
	persisted: boolean;
}

export interface ManagedLaneRegistryOptions {
	agentDir: string;
	lanes: LaneTracker;
	sessionManager: SessionManager;
}

/**
 * Durable owner of caller-managed lane identity and dispatch/terminal correlation. The caller's
 * stable lane id is the canonical id everywhere: goal bindings, UI projections, persistence, and
 * terminal reports never cross an in-memory id translation table.
 */
export class ManagedLaneRegistry {
	private readonly agentDir: string;
	private readonly lanes: LaneTracker;
	private readonly sessionManager: SessionManager;
	private readonly correlations = new Map<string, ManagedLaneCorrelation>();
	private hydrated = false;

	constructor(options: ManagedLaneRegistryOptions) {
		this.agentDir = options.agentDir;
		this.lanes = options.lanes;
		this.sessionManager = options.sessionManager;
	}

	ensureHydrated(): void {
		if (this.hydrated) return;
		this.hydrated = true;
		for (const record of getLatestLaneRecordSnapshots(getActiveSessionBranchEntries(this.sessionManager))) {
			if (record.type !== "tmux-worker" || (record.status !== "queued" && record.status !== "running")) continue;
			this.lanes.restore(record);
			this.correlations.set(record.laneId, { persisted: true });
		}
	}

	resolve(laneId: string): string | undefined {
		this.ensureHydrated();
		return this.correlations.has(laneId) ? laneId : undefined;
	}

	start(args: { laneId: string; goalId?: string; worktreeLaneKey?: string }): LaneRecord | undefined {
		this.ensureHydrated();
		const existing = this.correlations.get(args.laneId);
		if (existing) {
			existing.deregister ??= this.register(args.laneId);
			if (!existing.persisted) {
				const record = this.lanes.getRecord(args.laneId);
				if (record) {
					appendLaneRecordSnapshot(this.sessionManager, record);
					existing.persisted = true;
				}
			}
			return undefined;
		}

		const record = this.lanes.startNamed({
			laneId: args.laneId,
			type: "tmux-worker",
			goalId: args.goalId,
			worktreeLaneKey: args.worktreeLaneKey,
		});
		const correlation: ManagedLaneCorrelation = {
			deregister: this.register(args.laneId),
			persisted: false,
		};
		this.correlations.set(args.laneId, correlation);
		appendLaneRecordSnapshot(this.sessionManager, record);
		correlation.persisted = true;
		return record;
	}

	finish(
		laneId: string,
		args: { status: LaneTerminalStatus; reasonCode?: string; costUsd?: number },
	): LaneRecord | undefined {
		this.ensureHydrated();
		const correlation = this.correlations.get(laneId);
		if (!correlation) return undefined;
		try {
			const completed = this.lanes.complete(laneId, args);
			const record = completed ?? this.lanes.getRecord(laneId);
			if (!record || record.status === "queued" || record.status === "running") return undefined;
			appendLaneRecordSnapshot(this.sessionManager, record);
			this.correlations.delete(laneId);
			return record;
		} finally {
			correlation.deregister?.();
			delete correlation.deregister;
		}
	}

	/** Release process-local quiesce registrations without inventing a terminal worker outcome. */
	release(): void {
		for (const correlation of this.correlations.values()) correlation.deregister?.();
		this.correlations.clear();
	}

	private register(laneId: string): () => void {
		return registerInFlightWork(this.agentDir, "lane", `tmux:${laneId}`);
	}
}
