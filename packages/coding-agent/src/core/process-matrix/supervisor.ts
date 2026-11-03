/**
 * Process-matrix supervisor: PURE state-transition functions over `ProcessMatrixEntry`. Every
 * function here takes its notion of "now" and process liveness as an explicit argument/dependency
 * -- no `Date.now()`, no `process.kill` inside this module -- so the whole lifecycle (orphan
 * detection, wind-down, adoption, reconcile) is deterministically testable without real timers or
 * real processes. `runtime.ts` is the only caller that supplies real deps and real I/O.
 */

import type { OwnerStanding, ProcessOwner } from "../../kernel/reliability/owner-identity.ts";
import type { ProcessObservation } from "../../kernel/reliability/process-tree.ts";
import type { AgentIdentityContract } from "../orchestration/contracts.ts";
import type {
	ParentLiveness,
	ProcessMatrixEntry,
	ProcessTerminalHandoff,
	ReconcileMatrixResult,
	ResumablePayload,
	WindDownReason,
	WorkerDirective,
} from "./codes.ts";
import { buildEntryId } from "./store.ts";

export interface BuildMasterEntryFacts {
	agent: AgentIdentityContract;
	/** The registering process (`ownProcessOwner`): pid, start time, hostname and machine id as readable. */
	owner: ProcessOwner;
	now: string;
}

export function buildMasterEntry(facts: BuildMasterEntryFacts): ProcessMatrixEntry {
	return {
		entryId: buildEntryId("master", facts.agent.resumeContext.sessionId),
		role: "master",
		agent: structuredClone(facts.agent),
		...facts.owner,
		startedAt: facts.now,
		heartbeatAt: facts.now,
		status: "running",
	};
}

export interface BuildWorkerEntryFacts {
	agent: AgentIdentityContract;
	/** The registering process (`ownProcessOwner`): pid, start time, hostname and machine id as readable. */
	owner: ProcessOwner;
	now: string;
	parentPid: number;
	parentSessionId?: string;
	tmuxSession?: string;
	tmuxPanePid?: number;
	taskRef?: string;
	taskSummary?: string;
}

export function buildWorkerEntry(facts: BuildWorkerEntryFacts): ProcessMatrixEntry {
	const entry: ProcessMatrixEntry = {
		entryId: buildEntryId("worker", facts.agent.resumeContext.sessionId),
		role: "worker",
		agent: structuredClone(facts.agent),
		...facts.owner,
		startedAt: facts.now,
		heartbeatAt: facts.now,
		status: "running",
		parentPid: facts.parentPid,
	};
	if (facts.parentSessionId !== undefined) entry.parentSessionId = facts.parentSessionId;
	if (facts.tmuxSession !== undefined) entry.tmuxSession = facts.tmuxSession;
	if (facts.tmuxPanePid !== undefined) entry.tmuxPanePid = facts.tmuxPanePid;
	if (facts.taskRef !== undefined) entry.taskRef = facts.taskRef;
	if (facts.taskSummary !== undefined) entry.taskSummary = facts.taskSummary;
	return entry;
}

export function applyHeartbeat(entry: ProcessMatrixEntry, now: string): ProcessMatrixEntry {
	return { ...entry, heartbeatAt: now };
}

/**
 * The standing of a recorded owner (`judgeOwner` with the runtime's host and pid observation): only `dead` proves a
 * same-host owner gone; `foreign` (another host) and `unknown` prove nothing about it.
 */
export type OwnerJudge = (owner: ProcessOwner) => OwnerStanding;

export interface DetectOrphanedWorkersDeps {
	judge: OwnerJudge;
	/** This session's own sessionId -- never treat yourself as an orphan you found. */
	ownSessionId?: string;
}

/**
 * Worker entries whose `parentPid` is judged `dead`, excluding this session's own entry and anything
 * already `closed` (a closed worker isn't "orphaned", it's already done). The parent is judged as an
 * owner on the worker's own host (it launched the worker there, with no recorded start time), so a
 * worker recorded on another host is `foreign` and never an orphan here.
 */
export function detectOrphanedWorkers(
	entries: ProcessMatrixEntry[],
	deps: DetectOrphanedWorkersDeps,
): ProcessMatrixEntry[] {
	return entries.filter((entry) => {
		if (entry.role !== "worker") return false;
		if (entry.status === "closed") return false;
		if (deps.ownSessionId !== undefined && entry.agent.resumeContext.sessionId === deps.ownSessionId) return false;
		if (entry.parentPid === undefined) return false;
		return deps.judge({ pid: entry.parentPid, hostname: entry.hostname, machineId: entry.machineId }) === "dead";
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

export function markTerminal(
	entry: ProcessMatrixEntry,
	terminal: Pick<ProcessTerminalHandoff, "code" | "signal">,
	now: string,
): ProcessMatrixEntry {
	return {
		...markClosed(entry, now),
		terminal: { code: terminal.code, signal: terminal.signal, observedAt: now },
	};
}

export function markTerminalNotificationDelivered(entry: ProcessMatrixEntry, now: string): ProcessMatrixEntry {
	if (!entry.terminal) return entry;
	return { ...entry, terminal: { ...entry.terminal, notificationDeliveredAt: now } };
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

export interface ParentLivenessFacts {
	parentPid: number;
	parentSessionId: string | undefined;
	observation: ProcessObservation;
	/** The parent session's master entry as currently stored, or undefined when absent. */
	parentEntry: ProcessMatrixEntry | undefined;
	nowMs: number;
	maxHeartbeatAgeMs: number;
	/** True when the observer itself was suspended or stalled since its last tick: a stale parent
	 * heartbeat is then explained by the same stall and proves nothing about the parent. */
	observerSuspended: boolean;
}

/**
 * PID liveness alone is not process identity: a reused PID could keep a worker attached to an
 * unrelated process forever. The parent session's own master entry binds PID to a durable identity
 * and its heartbeat proves that exact session is still running. Pure: every fact is an argument.
 */
export function classifyParentLiveness(facts: ParentLivenessFacts): ParentLiveness {
	if (!facts.parentSessionId) return { alive: false, code: "no_parent_session" };
	if (facts.observation !== "alive") return { alive: false, code: "process_gone" };
	const parent = facts.parentEntry;
	if (!parent) return { alive: false, code: "session_entry_missing" };
	if (
		parent.role !== "master" ||
		parent.agent.resumeContext.sessionId !== facts.parentSessionId ||
		parent.pid !== facts.parentPid
	)
		return { alive: false, code: "process_identity_mismatch" };
	if (parent.status !== "running") return { alive: false, code: "session_entry_not_running" };
	if (facts.observerSuspended) return { alive: true };
	const heartbeatAt = Date.parse(parent.heartbeatAt);
	if (!Number.isFinite(heartbeatAt) || facts.nowMs - heartbeatAt > facts.maxHeartbeatAgeMs)
		return { alive: false, code: "heartbeat_stale" };
	return { alive: true };
}

export interface PollWorkerDirectiveDeps {
	observeProcess: (pid: number) => ProcessObservation;
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
		deps.observeProcess(freshEntry.parentPid) === "alive"
	) {
		return { code: "adopt", parentPid: freshEntry.parentPid };
	}
	return { code: "none" };
}

export interface ReconcileMatrixDeps {
	/** Judges each `running`/`winding_down` entry as its own process's owner record. */
	judge: OwnerJudge;
	/** Epoch ms "now", compared against an entry's `heartbeatAt` (or terminal `observedAt`). */
	now: number;
	resumableTtlMs: number;
}

/** True once `at` (an ISO timestamp) is unparseable or older than `ttlMs` before `now`. */
function isExpired(at: string, now: number, ttlMs: number): boolean {
	const atMs = Date.parse(at);
	return !Number.isFinite(atMs) || now - atMs > ttlMs;
}

/**
 * Prune `closed` entries and unrecoverable dead processes. A dead Pi worker that was interrupted
 * before persisting its own resumable transition is repaired from its already-durable logical-agent
 * identity. `resumable`/`adopted` entries are kept until they age past `resumableTtlMs`.
 *
 * Only a `dead` standing proves a `running`/`winding_down` process gone: same host, and ESRCH or a pid that
 * now names a process whose start time differs from the entry's `startTime` (a reissued pid). A `foreign`
 * entry (another host) is never probed here, and an `unknown` one proves nothing either way: both are
 * kept while their own heartbeat (every live runtime refreshes it) is within `resumableTtlMs`, then
 * pruned. Neither is ever recovered to `resumable`: that would let this host relaunch a worker that
 * may still be running.
 */
export function reconcileMatrix(entries: ProcessMatrixEntry[], deps: ReconcileMatrixDeps): ReconcileMatrixResult {
	const kept: ProcessMatrixEntry[] = [];
	const prunedEntryIds: string[] = [];
	const recoveredEntryIds: string[] = [];
	for (const entry of entries) {
		if (entry.status === "closed") {
			const terminalAt = entry.terminal?.observedAt ?? entry.heartbeatAt;
			const terminalExpired = isExpired(terminalAt, deps.now, deps.resumableTtlMs);
			if (entry.terminal && !entry.terminal.notificationDeliveredAt && !terminalExpired) kept.push(entry);
			else prunedEntryIds.push(entry.entryId);
			continue;
		}
		if (entry.status === "running" || entry.status === "winding_down") {
			const standing = deps.judge(entry);
			if (standing === "foreign" || standing === "unknown") {
				if (isExpired(entry.heartbeatAt, deps.now, deps.resumableTtlMs)) prunedEntryIds.push(entry.entryId);
				else kept.push(entry);
				continue;
			}
			if (standing === "dead") {
				if (entry.role === "worker" && entry.agent.resumeContext.provider === "pi") {
					const payload: ResumablePayload = {
						agent: structuredClone(entry.agent),
						lastCode: "resumable",
					};
					if (entry.taskRef !== undefined) payload.taskRef = entry.taskRef;
					if (entry.taskSummary !== undefined) payload.taskSummary = entry.taskSummary;
					kept.push(markResumable(entry, payload, new Date(deps.now).toISOString()));
					recoveredEntryIds.push(entry.entryId);
				} else {
					prunedEntryIds.push(entry.entryId);
				}
				continue;
			}
			kept.push(entry);
			continue;
		}
		// resumable / adopted: TTL-gated on the entry's own last heartbeat.
		if (isExpired(entry.heartbeatAt, deps.now, deps.resumableTtlMs)) prunedEntryIds.push(entry.entryId);
		else kept.push(entry);
	}
	return { code: "reconciled", kept, prunedEntryIds, recoveredEntryIds };
}
