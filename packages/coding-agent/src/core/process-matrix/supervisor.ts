/**
 * Process-matrix supervisor: PURE state-transition functions over `ProcessMatrixEntry`. Every
 * function here takes its notion of "now" and process liveness as an explicit argument/dependency
 * -- no `Date.now()`, no `process.kill` inside this module -- so the whole lifecycle (orphan
 * detection, wind-down, adoption, reconcile) is deterministically testable without real timers or
 * real processes. `runtime.ts` is the only caller that supplies real deps and real I/O.
 */

import type {
	ProcessMatrixEntry,
	ReconcileMatrixResult,
	ResumablePayload,
	WindDownReason,
	WorkerDirective,
} from "./codes.ts";
import { buildEntryId } from "./store.ts";

export interface BuildMasterEntryFacts {
	sessionId: string;
	pid: number;
	hostname: string;
	now: string;
}

export function buildMasterEntry(facts: BuildMasterEntryFacts): ProcessMatrixEntry {
	return {
		entryId: buildEntryId("master", facts.sessionId),
		role: "master",
		pid: facts.pid,
		sessionId: facts.sessionId,
		hostname: facts.hostname,
		startedAt: facts.now,
		heartbeatAt: facts.now,
		status: "running",
	};
}

export interface BuildWorkerEntryFacts {
	sessionId: string;
	pid: number;
	hostname: string;
	now: string;
	parentPid: number;
	parentSessionId?: string;
	laneKey?: string;
	tmuxSession?: string;
	tmuxPanePid?: number;
	taskRef?: string;
}

export function buildWorkerEntry(facts: BuildWorkerEntryFacts): ProcessMatrixEntry {
	const entry: ProcessMatrixEntry = {
		entryId: buildEntryId("worker", facts.sessionId),
		role: "worker",
		pid: facts.pid,
		sessionId: facts.sessionId,
		hostname: facts.hostname,
		startedAt: facts.now,
		heartbeatAt: facts.now,
		status: "running",
		parentPid: facts.parentPid,
	};
	if (facts.parentSessionId !== undefined) entry.parentSessionId = facts.parentSessionId;
	if (facts.laneKey !== undefined) entry.laneKey = facts.laneKey;
	if (facts.tmuxSession !== undefined) entry.tmuxSession = facts.tmuxSession;
	if (facts.tmuxPanePid !== undefined) entry.tmuxPanePid = facts.tmuxPanePid;
	if (facts.taskRef !== undefined) entry.taskRef = facts.taskRef;
	return entry;
}

export function applyHeartbeat(entry: ProcessMatrixEntry, now: string): ProcessMatrixEntry {
	return { ...entry, heartbeatAt: now };
}

export interface DetectOrphanedWorkersDeps {
	isPidAlive: (pid: number) => boolean;
	/** This session's own sessionId -- never treat yourself as an orphan you found. */
	ownSessionId?: string;
}

/**
 * Worker entries whose `parentPid` is dead, excluding this session's own entry and anything
 * already `closed` (a closed worker isn't "orphaned", it's already done).
 */
export function detectOrphanedWorkers(
	entries: ProcessMatrixEntry[],
	deps: DetectOrphanedWorkersDeps,
): ProcessMatrixEntry[] {
	return entries.filter((entry) => {
		if (entry.role !== "worker") return false;
		if (entry.status === "closed") return false;
		if (deps.ownSessionId !== undefined && entry.sessionId === deps.ownSessionId) return false;
		if (entry.parentPid === undefined) return false;
		return !deps.isPidAlive(entry.parentPid);
	});
}

export function beginWindDown(entry: ProcessMatrixEntry, reason: WindDownReason, now: string): ProcessMatrixEntry {
	return { ...entry, status: "winding_down", windDownReason: reason, heartbeatAt: now };
}

export function markResumable(entry: ProcessMatrixEntry, payload: ResumablePayload, now: string): ProcessMatrixEntry {
	return { ...entry, status: "resumable", resumable: payload, heartbeatAt: now };
}

export function markClosed(entry: ProcessMatrixEntry, now: string): ProcessMatrixEntry {
	return { ...entry, status: "closed", heartbeatAt: now };
}

export interface AdoptionFacts {
	parentPid: number;
	parentSessionId?: string;
}

/** Claim (or reclaim) an entry under a new parent: back to `running`, wind-down reason cleared. */
export function applyAdoption(entry: ProcessMatrixEntry, adoption: AdoptionFacts): ProcessMatrixEntry {
	const next: ProcessMatrixEntry = { ...entry, status: "running", parentPid: adoption.parentPid };
	delete next.windDownReason;
	if (adoption.parentSessionId !== undefined) next.parentSessionId = adoption.parentSessionId;
	return next;
}

export interface PollWorkerDirectiveDeps {
	isPidAlive: (pid: number) => boolean;
}

/**
 * A worker calls this against its OWN freshly re-read entry to learn whether a master wrote a
 * directive into it: an adoption (a new, live `parentPid` the worker didn't already know about)
 * or a cooperative cleanup request (`windDownReason === "user_cleanup"`). `knownParentPid` is the
 * parent the worker itself currently believes it has -- an unchanged, still-known parentPid never
 * counts as a new adoption.
 */
export function pollWorkerDirective(
	freshEntry: ProcessMatrixEntry,
	knownParentPid: number | undefined,
	deps: PollWorkerDirectiveDeps,
): WorkerDirective {
	if (freshEntry.windDownReason === "user_cleanup") return { code: "user_cleanup" };
	if (
		freshEntry.parentPid !== undefined &&
		freshEntry.parentPid !== knownParentPid &&
		deps.isPidAlive(freshEntry.parentPid)
	) {
		return { code: "adopt", parentPid: freshEntry.parentPid };
	}
	return { code: "none" };
}

export interface ReconcileMatrixDeps {
	isPidAlive: (pid: number) => boolean;
	/** Epoch ms "now", compared against a resumable/adopted entry's `heartbeatAt`. */
	now: number;
	resumableTtlMs: number;
}

/**
 * Prune `closed` entries and any `running`/`winding_down` entry whose OWN pid is dead (a crashed
 * process that never reached `closed`). `resumable`/`adopted` entries are kept until they age past
 * `resumableTtlMs` -- they carry a payload a future session may still pick up.
 */
export function reconcileMatrix(entries: ProcessMatrixEntry[], deps: ReconcileMatrixDeps): ReconcileMatrixResult {
	const kept: ProcessMatrixEntry[] = [];
	const prunedEntryIds: string[] = [];
	for (const entry of entries) {
		if (entry.status === "closed") {
			prunedEntryIds.push(entry.entryId);
			continue;
		}
		if (entry.status === "running" || entry.status === "winding_down") {
			if (!deps.isPidAlive(entry.pid)) {
				prunedEntryIds.push(entry.entryId);
				continue;
			}
			kept.push(entry);
			continue;
		}
		// resumable / adopted: TTL-gated on the entry's own last heartbeat.
		const heartbeatMs = Date.parse(entry.heartbeatAt);
		if (Number.isFinite(heartbeatMs) && deps.now - heartbeatMs > deps.resumableTtlMs) {
			prunedEntryIds.push(entry.entryId);
			continue;
		}
		kept.push(entry);
	}
	return { code: "reconciled", kept, prunedEntryIds };
}
