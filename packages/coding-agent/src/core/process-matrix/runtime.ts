/**
 * Process-matrix runtime composition: the pieces main.ts wires together for durable,
 * restart-surviving master/worker process supervision.
 *
 * Contract:
 * - A WORKER is any process launched with a known parent (`PI_PARENT_PID` -- set by the
 *   `--parent-pid` CLI flag, or directly by a launcher such as tmux dispatch). It self-registers
 *   its OWN entry (the single writer of that entry during normal operation) and watches its
 *   parent's liveness. On parent death it winds down GRACEFULLY -- never silently -- leaving a
 *   `resumable` payload, then exits on its own after a bounded grace window (during which it may
 *   instead be adopted by a new parent). "No new turns" after that point is automatic: a dead
 *   parent injects no further follow-ups, so the worker simply runs out of work to do.
 * - A MASTER is everything else (no known parent). On startup it scans the matrix for orphaned
 *   workers (workers whose recorded parent is dead). Workers tied to this master's exact resumed
 *   session and goal identity recover automatically. Every non-matching worker is report-only until
 *   the owner decides: dead workers are never resume-prompted, and a still-live foreign worker is
 *   offered to the owner through `requestOwnerCleanupDecision` -- an explicit yes writes a
 *   cooperative `user_cleanup` directive, anything else (no, timeout, no owner, abort) leaves the
 *   entry untouched.
 *
 * Sanctioned exceptions to "a worker's entry is written only by that worker": (1) an exact resumed
 * parent may restore its recorded ownership; (2) the owner-approved `user_cleanup` directive. The
 * worker later confirms/applies the directive via `pollWorkerDirective` and re-writes its own entry
 * -- see `docs/process-matrix.md`. Both are identity-fenced compare-and-swap writes. Outside these
 * handshakes, the orphan scan NEVER writes another session's entry; bounded reconciliation may still
 * perform generation-fenced lifecycle/TTL maintenance, and nothing here ever kills a process directly.
 */

import { hostname as osHostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type { ProcessObservation } from "../../kernel/reliability/process-tree.ts";
import { isAgentIdentity } from "../orchestration/agent-resume.ts";
import type { AgentIdentityContract } from "../orchestration/contracts.ts";
import { getParentPid, getParentSessionId, getProcessTaskRef } from "../process-identity.ts";
import type { ResolvedProcessMatrixSettings } from "../settings/settings-schema.ts";
import { getBoundWorktreeLaneKey } from "../worktree-sync/lane-binding.ts";
import type {
	OrphanCleanupRequest,
	OwnerCleanupDecision,
	ParentLiveness,
	ParentLossCode,
	ProcessMatrixEntry,
	ResumablePayload,
} from "./codes.ts";
import { type PresenceWatch, startPresenceBeacon, watchPresence } from "./presence.ts";
import {
	buildEntryId,
	listEntries,
	readEntry,
	removeEntryIfUnchanged,
	writeEntry,
	writeEntryIfUnchanged,
	writeEntryIfUnchangedSync,
} from "./store.ts";
import {
	applyAdoption,
	applyHeartbeat,
	beginWindDown,
	buildMasterEntry,
	buildWorkerEntry,
	classifyParentLiveness,
	detectOrphanedWorkers,
	markClosed,
	markResumable,
	markTerminal,
	markTerminalNotificationDelivered,
	pollWorkerDirective,
	reconcileMatrix,
} from "./supervisor.ts";

export {
	getOrchestrationAgentId,
	getParentPid,
	getParentSessionId,
	getProcessTaskRef,
	PI_ORCHESTRATION_AGENT_ID_ENV,
	PI_PARENT_PID_ENV,
	PI_PARENT_SESSION_ENV,
	PI_TASK_REF_ENV,
} from "../process-identity.ts";

/** Storage boundary for the process-matrix coordinator. Runtime state transitions depend on this
 * port, while the filesystem adapter remains the single production implementation. */
export interface ProcessMatrixStorePort {
	listEntries: typeof listEntries;
	readEntry: typeof readEntry;
	removeEntryIfUnchanged: typeof removeEntryIfUnchanged;
	writeEntry: typeof writeEntry;
	writeEntryIfUnchanged: typeof writeEntryIfUnchanged;
	writeEntryIfUnchangedSync: typeof writeEntryIfUnchangedSync;
}

export const localProcessMatrixStore: ProcessMatrixStorePort = Object.freeze({
	listEntries,
	readEntry,
	removeEntryIfUnchanged,
	writeEntry,
	writeEntryIfUnchanged,
	writeEntryIfUnchangedSync,
});

/** An authenticated controller record supplies effective supervision, separately from launch provenance. */
export interface ProcessParentOwnership {
	parentPid: number;
	parentSessionId: string;
	generation: number;
}

export interface ProcessParentOwnershipSource {
	read(): ProcessParentOwnership | undefined;
	subscribe(changed: () => void, onError: (error: Error) => void): () => void;
}

export interface ProcessMatrixRuntimeConfig {
	agentDir: string;
	parentOwnership?: ProcessParentOwnershipSource;
	/** Canonical logical identity for this process and any exact-session resume. */
	agent: AgentIdentityContract;
	settings: ResolvedProcessMatrixSettings;
	observeProcess: (pid: number) => ProcessObservation;
	now?: () => number;
	/** Structural notice injection into the running session (host `sendCustomMessage` seam). */
	notify: (text: string) => void | Promise<void>;
	/** Diagnostics sink (never throws into the session). */
	onDiagnostic?: (message: string) => void;
	/** Session-log sink for a wall-clock discontinuity observed between two heartbeat ticks. */
	recordClockJump?: (record: ClockJumpRecord) => void;
	/** Cooperative self-exit -- called by a worker once wound down (grace expiry or a
	 * master-granted cleanup directive). Never called for the master's own lifecycle. */
	requestExit: () => Promise<void>;
	/** Stable goal/task identity. Automatic recovery requires an exact match. */
	taskRef?: string;
	taskSummary?: string;
	/** False for terminal/blocked owner state: exact-session recovery stays report-only. */
	allowAutomaticRecovery?: boolean;
	/** Starts a replacement OS process for a dead resumable worker. Completion is an event-driven
	 * terminal signal; worker product remains in its persisted session/artifacts. */
	resumeWorker?: (payload: ResumablePayload) => Promise<ResumeWorkerLaunchOutcome>;
	/** Injectable only at the storage boundary; defaults to the atomic local filesystem adapter. */
	store?: ProcessMatrixStorePort;
	/**
	 * Master only. Ask the owner whether a still-live orphan of another session may be asked to wind
	 * down. Resolve `approved` only for an explicit yes; the runtime treats every other outcome --
	 * including a rejection -- as "leave it untouched". The signal aborts when the runtime stops.
	 * Absent (headless): the orphan is only reported as a pending decision.
	 */
	requestOwnerCleanupDecision?: (request: OrphanCleanupRequest, signal: AbortSignal) => Promise<OwnerCleanupDecision>;
}

export type ResumeWorkerLaunchOutcome =
	| {
			started: true;
			/** OS identity of this specific replacement process, used to fence its terminal handoff. */
			pid: number;
			completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	  }
	| { started: false; reason: string };

/** `idle`: every task active at the call boundary settled. `timed_out`: the bound elapsed first; nothing was cancelled. */
export type ProcessMatrixIdleResult = "idle" | "timed_out";

export interface ProcessMatrixIdleOptions {
	/** Upper bound on the wait. Defaults to {@link PROCESS_MATRIX_IDLE_WAIT_DEFAULT_MS}. */
	timeoutMs?: number;
}

export interface ProcessMatrixRuntimeHandle {
	stop(): Promise<void> | void;
	/**
	 * Resolve `idle` after every watcher task that is active at the call boundary has settled, or
	 * `timed_out` once the bound elapses. The master's tasks include a human-paced owner decision, so
	 * a headless session with an owner hook must never wait on it unboundedly. A timeout abandons only
	 * this wait: the tasks keep running and `stop()` still aborts them.
	 */
	waitForIdle(options?: ProcessMatrixIdleOptions): Promise<ProcessMatrixIdleResult>;
}

export const PROCESS_MATRIX_IDLE_WAIT_DEFAULT_MS = 30_000;

const NOOP_HANDLE: ProcessMatrixRuntimeHandle = { stop: () => {}, waitForIdle: async () => "idle" };

async function settleWithin(
	work: () => Promise<void>,
	options: ProcessMatrixIdleOptions = {},
): Promise<ProcessMatrixIdleResult> {
	const timeoutMs = options.timeoutMs ?? PROCESS_MATRIX_IDLE_WAIT_DEFAULT_MS;
	let timer: NodeJS.Timeout | undefined;
	const bound = new Promise<"timed_out">((resolve) => {
		timer = setTimeout(() => resolve("timed_out"), Math.max(0, timeoutMs));
		timer.unref?.();
	});
	try {
		return await Promise.race([work().then((): "idle" => "idle"), bound]);
	} finally {
		clearTimeout(timer);
	}
}
export const PROCESS_MATRIX_RESUMABLE_RETENTION_MS = 30 * 24 * 60 * 60_000;

function resolveProcessMatrixStore(config: ProcessMatrixRuntimeConfig): ProcessMatrixStorePort {
	return config.store ?? localProcessMatrixStore;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function nowIso(now: () => number): string {
	return new Date(now()).toISOString();
}

/** Session custom-entry type for a wall-clock discontinuity. Read by the latency census. */
export const CLOCK_JUMP_CUSTOM_TYPE = "clock_jump";

/**
 * The wall clock between two heartbeat ticks. A transcript cannot otherwise distinguish a harness
 * that stalled from a host that was suspended: both leave one long silent span between entries.
 */
export interface ClockJumpRecord {
	previousTickAt: string;
	tickAt: string;
	gapMs: number;
	intervalMs: number;
}

/**
 * How many heartbeat intervals a tick gap must exceed before it is a jump. A loaded event loop
 * delays a timer by a fraction of its interval; a suspended host skips whole intervals at once.
 */
const CLOCK_JUMP_INTERVAL_MULTIPLE = 5;

/** The record for a tick that arrived far later than its own cadence, or undefined for a normal tick. */
function detectClockJump(previousTickMs: number, tickMs: number, intervalMs: number): ClockJumpRecord | undefined {
	const gapMs = tickMs - previousTickMs;
	if (!(intervalMs > 0) || gapMs <= intervalMs * CLOCK_JUMP_INTERVAL_MULTIPLE) return undefined;
	return {
		previousTickAt: new Date(previousTickMs).toISOString(),
		tickAt: new Date(tickMs).toISOString(),
		gapMs,
		intervalMs,
	};
}

function emitRuntimeNotice(config: ProcessMatrixRuntimeConfig, text: string): void {
	try {
		void Promise.resolve(config.notify(text)).catch((error: unknown) => {
			config.onDiagnostic?.(`process-matrix: failed to notify session: ${describeError(error)}`);
		});
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: failed to notify session: ${describeError(error)}`);
	}
}

/**
 * Start the per-session process-matrix runtime. No-op when disabled (byte-identical to not
 * calling this at all). Never throws: a broken store must surface as a diagnostic, not a startup
 * crash.
 */
export async function startProcessMatrixRuntime(
	config: ProcessMatrixRuntimeConfig,
): Promise<ProcessMatrixRuntimeHandle> {
	if (!config.settings.enabled) return NOOP_HANDLE;
	const now = config.now ?? Date.now;
	const parentPid = getParentPid();

	try {
		if (!isAgentIdentity(config.agent)) throw new TypeError("Process-matrix agent identity is invalid.");
		if (parentPid !== undefined) {
			return await startWorkerBranch(config, parentPid, now);
		}
		return await startMasterBranch(config, now);
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: runtime failed to start: ${describeError(error)}`);
		return NOOP_HANDLE;
	}
}

// ---------------------------------------------------------------------------
// Master branch
// ---------------------------------------------------------------------------

async function startMasterBranch(
	config: ProcessMatrixRuntimeConfig,
	now: () => number,
): Promise<ProcessMatrixRuntimeHandle> {
	const store = resolveProcessMatrixStore(config);
	let entry = buildMasterEntry({
		agent: config.agent,
		pid: process.pid,
		hostname: osHostname(),
		now: nowIso(now),
	});
	try {
		await store.writeEntry(config.agentDir, entry);
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: failed to register master entry: ${describeError(error)}`);
	}
	// Workers learn this master died from the kernel closing their connection, not from a timer.
	const presence = await startPresenceBeacon(config.agent.resumeContext.sessionId, config.onDiagnostic);

	let stopped = false;
	let ownsEntry = true;
	let heartbeatTask: Promise<void> | undefined;
	const lifetime = new AbortController();
	// The heartbeat is the session's only fixed-cadence observation of the wall clock, so it is also
	// where a suspended host becomes visible. The gap is measured before anything can skip the tick:
	// entry ownership and a still-running store write say nothing about what the clock did.
	let previousTickMs = now();
	const heartbeatTimer = setInterval(() => {
		const tickMs = now();
		const clockJump = detectClockJump(previousTickMs, tickMs, config.settings.heartbeatMs);
		previousTickMs = tickMs;
		if (clockJump) {
			try {
				config.recordClockJump?.(clockJump);
			} catch (error) {
				config.onDiagnostic?.(`process-matrix: failed to record a clock jump: ${describeError(error)}`);
			}
		}
		if (stopped || !ownsEntry || heartbeatTask) return;
		const expected = entry;
		const next = applyHeartbeat(expected, nowIso(now));
		heartbeatTask = store
			.writeEntryIfUnchanged(config.agentDir, expected.entryId, expected, next)
			.then((written) => {
				if (written) {
					entry = next;
					return;
				}
				ownsEntry = false;
				lifetime.abort();
				clearInterval(heartbeatTimer);
				process.off("exit", closeOnExit);
				config.onDiagnostic?.("process-matrix: master entry ownership moved to a newer process generation");
			})
			.catch((error: unknown) => {
				config.onDiagnostic?.(`process-matrix: failed to write master heartbeat: ${describeError(error)}`);
			})
			.finally(() => {
				heartbeatTask = undefined;
			});
	}, config.settings.heartbeatMs);
	heartbeatTimer.unref?.();

	// Best-effort close on process exit. A SIGKILLed master leaving "running" is fine -- reconcile's
	// own dead-pid detection covers it; this only makes the common clean-exit case tidy.
	const closeOnExit = (): void => {
		if (!ownsEntry) return;
		try {
			const closed = markClosed(entry, nowIso(now));
			if (store.writeEntryIfUnchangedSync(config.agentDir, entry, closed)) entry = closed;
		} catch {
			// Best-effort only -- see module doc.
		}
	};
	process.once("exit", closeOnExit);

	const maintenance = reconcileAndRunOrphanScan(config, now, lifetime.signal).catch((error: unknown) => {
		config.onDiagnostic?.(`process-matrix: maintenance failed: ${describeError(error)}`);
		return [] as ProcessMatrixEntry[];
	});
	// The owner's answer is human-paced: it never gates maintenance, and stop() aborts it.
	const ownerDecisions = maintenance
		.then((pending) => askOwnerAboutOrphans(config, pending, now, lifetime.signal))
		.catch((error: unknown) => {
			config.onDiagnostic?.(`process-matrix: owner decision failed: ${describeError(error)}`);
		});

	return {
		waitForIdle(options) {
			return settleWithin(async () => {
				await maintenance;
				await ownerDecisions;
				await heartbeatTask;
			}, options);
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			lifetime.abort();
			clearInterval(heartbeatTimer);
			process.off("exit", closeOnExit);
			await heartbeatTask;
			if (ownsEntry) {
				const closed = markClosed(entry, nowIso(now));
				if (await store.writeEntryIfUnchanged(config.agentDir, entry.entryId, entry, closed)) entry = closed;
			}
			// After the entry is closed: a worker woken by this disconnect must read `closed`, not `running`.
			await presence.stop();
			await maintenance;
			await ownerDecisions;
		},
	};
}

/** Returns the live foreign orphans still awaiting an owner decision. */
async function reconcileAndRunOrphanScan(
	config: ProcessMatrixRuntimeConfig,
	now: () => number,
	signal: AbortSignal,
): Promise<ProcessMatrixEntry[]> {
	const store = resolveProcessMatrixStore(config);
	let entries: ProcessMatrixEntry[];
	try {
		entries = await store.listEntries(config.agentDir);
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: reconciliation failed to list entries: ${describeError(error)}`);
		return [];
	}
	if (signal.aborted) return [];
	const reconciled = reconcileMatrix(entries, {
		observeProcess: (pid) => (pid === process.pid ? "alive" : config.observeProcess(pid)),
		now: now(),
		resumableTtlMs: PROCESS_MATRIX_RESUMABLE_RETENTION_MS,
	});
	const originalByEntryId = new Map(entries.map((entry) => [entry.entryId, entry]));
	const recoveredEntryIdSet = new Set(reconciled.recoveredEntryIds);
	const pruneActions = reconciled.prunedEntryIds.map((entryId) => () => {
		const original = originalByEntryId.get(entryId);
		return original ? store.removeEntryIfUnchanged(config.agentDir, original) : false;
	});
	const recoveryActions = reconciled.kept
		.filter((entry) => recoveredEntryIdSet.has(entry.entryId))
		.map((entry) => () => {
			const original = originalByEntryId.get(entry.entryId);
			return original ? store.writeEntryIfUnchanged(config.agentDir, entry.entryId, original, entry) : false;
		});
	// Store adapters are independent at this boundary. Start every mutation even if an adapter throws
	// synchronously, and do not publish the maintenance terminal until every admitted mutation settles.
	const mutationResults = await Promise.allSettled(
		[...pruneActions, ...recoveryActions].map((action) => Promise.resolve().then(action)),
	);
	const failures = mutationResults
		.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		.map((result) => result.reason);
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Process-matrix reconciliation mutations failed");
	const recoveredOutcomes = mutationResults
		.slice(pruneActions.length)
		.map((result) => (result.status === "fulfilled" ? result.value : false));
	if (signal.aborted) return [];
	const recoveredCount = recoveredOutcomes.filter(Boolean).length;
	if (recoveredCount > 0) {
		config.onDiagnostic?.(
			`process-matrix: recovered ${recoveredCount} interrupted Pi worker entr${recoveredCount === 1 ? "y" : "ies"}`,
		);
	}
	const currentEntries = await store.listEntries(config.agentDir);
	await deliverTerminalNotifications(config, currentEntries, now, signal);
	if (signal.aborted) return [];
	return runOrphanScan(config, currentEntries, signal);
}

async function deliverTerminalNotifications(
	config: ProcessMatrixRuntimeConfig,
	entries: ProcessMatrixEntry[],
	now: () => number,
	signal: AbortSignal,
): Promise<void> {
	const store = resolveProcessMatrixStore(config);
	for (const entry of entries) {
		if (
			signal.aborted ||
			entry.status !== "closed" ||
			!entry.terminal ||
			entry.terminal.notificationDeliveredAt ||
			entry.parentSessionId !== config.agent.resumeContext.sessionId
		)
			continue;
		try {
			await config.notify(formatTerminalNotification(entry));
			if (signal.aborted) return;
		} catch (error) {
			config.onDiagnostic?.(
				`process-matrix: failed to deliver terminal handoff for ${entry.entryId}: ${describeError(error)}`,
			);
			continue;
		}
		try {
			const delivered = markTerminalNotificationDelivered(entry, nowIso(now));
			if (!(await store.writeEntryIfUnchanged(config.agentDir, entry.entryId, entry, delivered))) {
				config.onDiagnostic?.(
					`process-matrix: terminal handoff changed before acknowledgement for ${entry.entryId}`,
				);
			}
		} catch (error) {
			config.onDiagnostic?.(
				`process-matrix: failed to acknowledge terminal handoff for ${entry.entryId}: ${describeError(error)}`,
			);
		}
	}
}

function formatTerminalNotification(entry: ProcessMatrixEntry): string {
	const terminal = entry.terminal;
	return `process-matrix: resumed agent ${entry.agent.agentId} reached a terminal process state (code ${terminal?.code ?? "none"}, signal ${terminal?.signal ?? "none"}). Inspect its persisted result before continuing.`;
}

async function runOrphanScan(
	config: ProcessMatrixRuntimeConfig,
	entries: ProcessMatrixEntry[],
	signal: AbortSignal,
): Promise<ProcessMatrixEntry[]> {
	const orphans = detectOrphanedWorkers(entries, {
		observeProcess: config.observeProcess,
		ownSessionId: config.agent.resumeContext.sessionId,
	});
	const awaitingOwner: ProcessMatrixEntry[] = [];

	for (const orphan of orphans) {
		if (signal.aborted) return awaitingOwner;
		const recoveryBoundary = getAutomaticRecoveryBoundary(config, orphan);
		const exactResumedParent = recoveryBoundary === undefined;
		if (!exactResumedParent) {
			// Foreign workers are never claimed or cleaned up implicitly. A dead one gets no resume
			// prompt; a still-live one is put to the owner (askOwnerAboutOrphans) and only an explicit
			// yes asks it to wind down. Only a still-live foreign worker is worth a loud, repeated
			// warning -- it's a potentially resource-consuming rogue process the user can act on. A foreign
			// worker whose own process has already died is inert data with zero possible action;
			// bounded reconciliation (see reconcileAndRunOrphanScan) already ages it out over
			// PROCESS_MATRIX_RESUMABLE_RETENTION_MS without help from this diagnostic, so
			// repeating the warning on every startup until that TTL elapses is pure noise.
			const observation = config.observeProcess(orphan.pid);
			if (observation === "alive") {
				reportUnrecoveredOrphan(config, orphan, recoveryBoundary);
				awaitingOwner.push(orphan);
			}
			continue;
		}
		const observation = config.observeProcess(orphan.pid);
		if (observation === "dead") {
			await resumeDeadOrphan(config, orphan, signal);
			continue;
		}
		if (observation === "alive") {
			await adoptLiveOrphan(config, orphan, signal);
		}
	}
	return awaitingOwner;
}

function getAutomaticRecoveryBoundary(
	config: ProcessMatrixRuntimeConfig,
	orphan: ProcessMatrixEntry,
): string | undefined {
	if (orphan.parentSessionId !== config.agent.resumeContext.sessionId) return "foreign parent session";
	const entryTaskRef = orphan.taskRef;
	const payloadTaskRef = orphan.resumable?.taskRef;
	if (entryTaskRef !== undefined && payloadTaskRef !== undefined && entryTaskRef !== payloadTaskRef) {
		return "inconsistent persisted task identity";
	}
	if ((payloadTaskRef ?? entryTaskRef) !== config.taskRef) return "task identity does not match the current goal";
	if (config.allowAutomaticRecovery === false) return "current goal state does not permit automatic recovery";
	return undefined;
}

function reportUnrecoveredOrphan(config: ProcessMatrixRuntimeConfig, orphan: ProcessMatrixEntry, reason: string): void {
	config.onDiagnostic?.(
		`process-matrix: found unrecovered orphan ${orphan.entryId} (pid ${orphan.pid}; ${reason}; report-only; pending owner decision; nothing written, nothing killed)`,
	);
}

/** Same worker process generation under the same recorded ownership; only its lifecycle state may differ. */
function isSameWorkerGeneration(shown: ProcessMatrixEntry, current: ProcessMatrixEntry): boolean {
	return (
		current.role === "worker" &&
		current.status !== "closed" &&
		current.pid === shown.pid &&
		current.startedAt === shown.startedAt &&
		current.parentPid === shown.parentPid &&
		current.parentSessionId === shown.parentSessionId &&
		current.taskRef === shown.taskRef
	);
}

/** Bound on dialogs per scan; the rest stay reported. */
const MAX_OWNER_CLEANUP_PROMPTS = 5;

/**
 * Put each live foreign orphan to the owner. Silence is never approval: only `approved` writes, and
 * the write is the existing worker-side `user_cleanup` directive -- the worker winds itself down.
 * Nothing here signals or kills a process.
 */
async function askOwnerAboutOrphans(
	config: ProcessMatrixRuntimeConfig,
	orphans: ProcessMatrixEntry[],
	now: () => number,
	signal: AbortSignal,
): Promise<void> {
	const ask = config.requestOwnerCleanupDecision;
	if (!ask || orphans.length === 0) return;
	for (const orphan of orphans.slice(0, MAX_OWNER_CLEANUP_PROMPTS)) {
		if (signal.aborted) return;
		let decision: OwnerCleanupDecision = "unanswered";
		try {
			decision = await ask(
				{
					entryId: orphan.entryId,
					pid: orphan.pid,
					...(orphan.parentPid !== undefined ? { parentPid: orphan.parentPid } : {}),
					...(orphan.taskRef !== undefined ? { taskRef: orphan.taskRef } : {}),
					...(orphan.taskSummary !== undefined ? { taskSummary: orphan.taskSummary } : {}),
				},
				signal,
			);
		} catch (error) {
			config.onDiagnostic?.(`process-matrix: owner question for ${orphan.entryId} failed: ${describeError(error)}`);
		}
		if (signal.aborted) return;
		if (decision !== "approved") {
			config.onDiagnostic?.(
				`process-matrix: orphan ${orphan.entryId} left untouched (owner ${decision === "declined" ? "declined" : "did not answer"})`,
			);
			continue;
		}
		await requestWorkerCleanup(config, orphan, now);
	}
	if (orphans.length > MAX_OWNER_CLEANUP_PROMPTS) {
		config.onDiagnostic?.(
			`process-matrix: ${orphans.length - MAX_OWNER_CLEANUP_PROMPTS} more orphan(s) left report-only (prompt limit)`,
		);
	}
}

async function requestWorkerCleanup(
	config: ProcessMatrixRuntimeConfig,
	shown: ProcessMatrixEntry,
	now: () => number,
): Promise<void> {
	const store = resolveProcessMatrixStore(config);
	let expected = shown;
	try {
		// The worker may legitimately advance its own lifecycle (running -> winding_down -> resumable)
		// while the owner reads the question; the fence is the process generation the owner was shown.
		for (let attempt = 0; attempt < 3; attempt++) {
			if (config.observeProcess(expected.pid) !== "alive") {
				config.onDiagnostic?.(
					`process-matrix: orphan ${shown.entryId} exited before cleanup was requested; nothing written`,
				);
				return;
			}
			if (
				await store.writeEntryIfUnchanged(
					config.agentDir,
					shown.entryId,
					expected,
					beginWindDown(expected, "user_cleanup", nowIso(now)),
				)
			) {
				config.onDiagnostic?.(
					`process-matrix: cleanup requested for orphan ${shown.entryId} (pid ${shown.pid}); the worker winds itself down, nothing is killed`,
				);
				return;
			}
			const current = await store.readEntry(config.agentDir, shown.entryId);
			if (current?.windDownReason === "user_cleanup" && current.status !== "closed") return;
			if (!current || !isSameWorkerGeneration(shown, current)) {
				config.onDiagnostic?.(
					`process-matrix: orphan ${shown.entryId} changed identity after it was shown to the owner; nothing written`,
				);
				return;
			}
			expected = current;
		}
		config.onDiagnostic?.(`process-matrix: orphan ${shown.entryId} kept changing; cleanup not requested`);
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: failed to request cleanup for ${shown.entryId}: ${describeError(error)}`);
	}
}

async function adoptLiveOrphan(
	config: ProcessMatrixRuntimeConfig,
	orphan: ProcessMatrixEntry,
	signal: AbortSignal,
): Promise<void> {
	const store = resolveProcessMatrixStore(config);
	if (signal.aborted) return;
	const adopted = applyAdoption(orphan, {
		parentPid: process.pid,
		parentSessionId: config.agent.resumeContext.sessionId,
	});
	try {
		if (!(await store.writeEntryIfUnchanged(config.agentDir, orphan.entryId, orphan, adopted))) return;
		if (signal.aborted) await store.writeEntryIfUnchanged(config.agentDir, orphan.entryId, adopted, orphan);
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: failed to write adoption for ${orphan.entryId}: ${describeError(error)}`);
	}
}

async function resumeDeadOrphan(
	config: ProcessMatrixRuntimeConfig,
	orphan: ProcessMatrixEntry,
	signal: AbortSignal,
): Promise<void> {
	const store = resolveProcessMatrixStore(config);
	if (signal.aborted) return;
	const payload = orphan.resumable;
	if (!payload || !config.resumeWorker) {
		config.onDiagnostic?.(
			`process-matrix: dead worker ${orphan.entryId} is not resumable because its launch context or resume launcher is unavailable`,
		);
		return;
	}
	const claimed = applyAdoption(orphan, {
		parentPid: process.pid,
		parentSessionId: config.agent.resumeContext.sessionId,
	});
	let launched: Extract<ResumeWorkerLaunchOutcome, { started: true }>;
	try {
		if (!(await store.writeEntryIfUnchanged(config.agentDir, orphan.entryId, orphan, claimed))) return;
		if (signal.aborted) {
			await store.writeEntryIfUnchanged(config.agentDir, orphan.entryId, claimed, orphan);
			return;
		}
		const launchOutcome = await config.resumeWorker(payload);
		if (!launchOutcome.started) {
			await store.writeEntryIfUnchanged(config.agentDir, orphan.entryId, claimed, orphan);
			config.onDiagnostic?.(`process-matrix: failed to resume ${orphan.entryId}: ${launchOutcome.reason}`);
			return;
		}
		launched = launchOutcome;
	} catch (error) {
		try {
			await store.writeEntryIfUnchanged(config.agentDir, orphan.entryId, claimed, orphan);
		} catch {
			// The original resumable record remains the intended recovery state.
		}
		config.onDiagnostic?.(`process-matrix: failed to resume ${orphan.entryId}: ${describeError(error)}`);
		return;
	}
	const launchedEntry = { ...claimed, pid: launched.pid };
	if (!signal.aborted) {
		try {
			// Bridge the interval before the replacement can self-register. Without its real PID here, a
			// restarted master can mistake this live replacement for the original dead process and spawn
			// a duplicate.
			await store.writeEntryIfUnchanged(config.agentDir, claimed.entryId, claimed, launchedEntry);
		} catch (error) {
			config.onDiagnostic?.(
				`process-matrix: failed to record resumed worker pid for ${orphan.entryId}: ${describeError(error)}`,
			);
		}
	} else {
		config.onDiagnostic?.(
			`process-matrix: resumed worker ${orphan.entryId} launched after owner shutdown; preserving its terminal handoff only`,
		);
	}
	void launched.completion.then(
		(result) => persistResumedWorkerTerminal(config, launchedEntry, claimed, result, signal),
		(error: unknown) => {
			config.onDiagnostic?.(
				`process-matrix: resumed agent ${payload.agent.agentId} terminal signal failed: ${describeError(error)}`,
			);
		},
	);
}

async function persistResumedWorkerTerminal(
	config: ProcessMatrixRuntimeConfig,
	claimed: ProcessMatrixEntry,
	preLaunchClaim: ProcessMatrixEntry,
	result: { code: number | null; signal: NodeJS.Signals | null },
	lifetime: AbortSignal,
): Promise<void> {
	const store = resolveProcessMatrixStore(config);
	try {
		const observedAt = new Date().toISOString();
		const terminal = markTerminal(claimed, result, observedAt);
		if (await store.writeEntryIfUnchanged(config.agentDir, claimed.entryId, claimed, terminal)) {
			if (lifetime.aborted) return;
			await notifyResumedWorkerTerminal(config, terminal, lifetime);
			return;
		}
		const selfRegistered = await store.readEntry(config.agentDir, claimed.entryId);
		if (
			selfRegistered?.pid === claimed.pid &&
			selfRegistered.role === claimed.role &&
			selfRegistered.parentPid === claimed.parentPid &&
			selfRegistered.parentSessionId === claimed.parentSessionId &&
			selfRegistered.taskRef === claimed.taskRef &&
			isDeepStrictEqual(selfRegistered.agent, claimed.agent)
		) {
			const registeredTerminal = markTerminal(selfRegistered, result, observedAt);
			if (await store.writeEntryIfUnchanged(config.agentDir, claimed.entryId, selfRegistered, registeredTerminal)) {
				if (lifetime.aborted) return;
				await notifyResumedWorkerTerminal(config, registeredTerminal, lifetime);
				return;
			}
		}
		// If recording the spawned PID failed (or shutdown won the race immediately after spawn), the
		// untouched pre-launch claim proves no newer process has taken this logical entry. Upgrade it
		// to the actual exited process before persisting its terminal handoff.
		const fallbackTerminal = markTerminal({ ...preLaunchClaim, pid: claimed.pid }, result, observedAt);
		if (await store.writeEntryIfUnchanged(config.agentDir, claimed.entryId, preLaunchClaim, fallbackTerminal)) {
			if (lifetime.aborted) return;
			await notifyResumedWorkerTerminal(config, fallbackTerminal, lifetime);
			return;
		}
		if (await store.writeEntryIfUnchanged(config.agentDir, claimed.entryId, undefined, terminal)) {
			if (lifetime.aborted) return;
			await notifyResumedWorkerTerminal(config, terminal, lifetime);
			return;
		}
		config.onDiagnostic?.(`process-matrix: ignored stale terminal handoff for ${claimed.entryId}`);
	} catch (error) {
		config.onDiagnostic?.(
			`process-matrix: failed to persist terminal handoff for ${claimed.entryId}: ${describeError(error)}`,
		);
	}
}

async function notifyResumedWorkerTerminal(
	config: ProcessMatrixRuntimeConfig,
	terminal: ProcessMatrixEntry,
	lifetime: AbortSignal,
): Promise<void> {
	const store = resolveProcessMatrixStore(config);
	if (lifetime.aborted) return;
	try {
		await config.notify(formatTerminalNotification(terminal));
		if (lifetime.aborted) return;
		const delivered = markTerminalNotificationDelivered(terminal, new Date().toISOString());
		if (!(await store.writeEntryIfUnchanged(config.agentDir, terminal.entryId, terminal, delivered))) {
			config.onDiagnostic?.(
				`process-matrix: terminal handoff changed before acknowledgement for ${terminal.entryId}`,
			);
		}
	} catch (error) {
		config.onDiagnostic?.(
			`process-matrix: failed to deliver terminal handoff for ${terminal.entryId}: ${describeError(error)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Worker branch
// ---------------------------------------------------------------------------

async function startWorkerBranch(
	config: ProcessMatrixRuntimeConfig,
	initialParentPid: number,
	now: () => number,
): Promise<ProcessMatrixRuntimeHandle> {
	const store = resolveProcessMatrixStore(config);
	const parentSessionId = getParentSessionId();
	const taskRef = (getProcessTaskRef() ?? config.taskRef)?.trim().slice(0, 512) || undefined;
	const taskSummary = config.taskSummary?.trim().slice(0, 2_000) || undefined;
	const laneKey = getBoundWorktreeLaneKey();
	const contextLaneKey = config.agent.resumeContext.worktreeLaneKey;
	if (laneKey !== contextLaneKey) {
		throw new TypeError(
			`Process-matrix agent lane '${contextLaneKey ?? "none"}' does not match active lane '${laneKey ?? "none"}'.`,
		);
	}

	let entry = buildWorkerEntry({
		agent: config.agent,
		pid: process.pid,
		hostname: osHostname(),
		now: nowIso(now),
		parentPid: initialParentPid,
		...(parentSessionId !== undefined ? { parentSessionId } : {}),
		...(taskRef !== undefined ? { taskRef } : {}),
		...(taskSummary !== undefined ? { taskSummary } : {}),
	});
	try {
		await store.writeEntry(config.agentDir, entry);
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: failed to register worker entry: ${describeError(error)}`);
	}

	let currentParentPid = initialParentPid;
	let currentParentSessionId = parentSessionId;
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	let watchTask: Promise<void> | undefined;
	let preserveResumableOnExit = false;
	let stopTask: Promise<void> | undefined;
	let ownershipGeneration = 0;
	let ownershipPending = false;
	let unsubscribeOwnership: (() => void) | undefined;
	let presenceWatch: PresenceWatch | undefined;
	let presenceSessionId: string | undefined;
	let presenceCheckPending = false;
	// Wall-clock observation between watcher ticks. A gap far beyond the cadence is a suspended or
	// stalled host, in which the parent's heartbeat is stale for the same reason this worker's tick is late.
	let previousWatchTickMs = now();
	let heartbeatForgivenUntil = 0;
	const heartbeatAgeBoundMs = config.settings.heartbeatMs * 2 + config.settings.watcherPollMs;
	const reportOwnershipError = (error: unknown): void => {
		try {
			config.onDiagnostic?.(`process-matrix: parent ownership observation failed: ${describeError(error)}`);
		} catch {
			/* A diagnostic cannot escape an ownership event or interrupt teardown. */
		}
	};
	const stopOwnershipObserver = () => {
		const unsubscribe = unsubscribeOwnership;
		unsubscribeOwnership = undefined;
		try {
			unsubscribe?.();
		} catch (error) {
			reportOwnershipError(error);
		}
	};
	const detachPresence = (): void => {
		const watch = presenceWatch;
		presenceWatch = undefined;
		presenceSessionId = undefined;
		watch?.dispose();
	};
	const generationStartedAt = entry.startedAt;
	const closeOnExit = (code: number | null = null): void => {
		if (preserveResumableOnExit) return;
		try {
			const terminal = markTerminal(entry, { code, signal: null }, nowIso(now));
			if (store.writeEntryIfUnchangedSync(config.agentDir, entry, terminal)) entry = terminal;
		} catch {
			// Best-effort. Dead-pid reconciliation remains authoritative.
		}
	};
	process.once("exit", closeOnExit);

	const closeWorker = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		stopOwnershipObserver();
		detachPresence();
		if (timer) clearInterval(timer);
		timer = undefined;
		if (!preserveResumableOnExit) {
			// Normal runtime shutdown can await the lock and Windows rename retry policy. Keep the
			// synchronous exit hook only as a last-chance process-exit fallback: using it here made a
			// transient lock collision leave cooperative cleanup permanently in `winding_down`.
			for (let attempt = 0; attempt < 3; attempt++) {
				const expected = entry;
				const terminal = markTerminal(expected, { code: null, signal: null }, nowIso(now));
				try {
					if (await store.writeEntryIfUnchanged(config.agentDir, expected.entryId, expected, terminal)) {
						entry = terminal;
						break;
					}
					const current = await store.readEntry(config.agentDir, expected.entryId);
					if (current?.pid !== process.pid || current.startedAt !== generationStartedAt) {
						config.onDiagnostic?.("process-matrix: worker entry ownership moved to a newer process generation");
						break;
					}
					entry = current;
				} catch (error) {
					config.onDiagnostic?.(
						`process-matrix: failed to persist worker terminal state: ${describeError(error)}`,
					);
					break;
				}
			}
		} else {
			// Wound down: the resumable payload must survive, so no terminal is written here. But a
			// directive another writer left on THIS generation's entry (the sanctioned exception in this
			// module's header -- e.g. an adoption whose `running` state only becomes true once this
			// runtime confirms it) has no executor once we stop. Leaving it would present a stopped
			// runtime as a live process. Restore only our own last-owned state, only while the stored
			// record is still this generation's, and never a newer generation's.
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					const current = await store.readEntry(config.agentDir, entry.entryId);
					if (!current || current.pid !== process.pid || current.startedAt !== generationStartedAt) break;
					if (isDeepStrictEqual(current, entry)) break;
					if (await store.writeEntryIfUnchanged(config.agentDir, entry.entryId, current, entry)) break;
				} catch (error) {
					config.onDiagnostic?.(
						`process-matrix: failed to restore worker resumable state: ${describeError(error)}`,
					);
					break;
				}
			}
		}
		process.off("exit", closeOnExit);
	};

	const stop = (): Promise<void> => {
		stopTask ??= closeWorker();
		return stopTask;
	};

	/**
	 * This runtime owns an entry only while the record is still its own pid AND its own generation.
	 * A recycled pid or a restarted runtime in the same process both produce a different `startedAt`,
	 * so pid alone is not ownership.
	 */
	const ownsGeneration = (candidate: ProcessMatrixEntry | undefined): candidate is ProcessMatrixEntry =>
		candidate !== undefined && candidate.pid === process.pid && candidate.startedAt === generationStartedAt;

	/**
	 * Ownership has moved to another generation. Stand down completely: no timer, no exit hook, no
	 * further notice, exit request or write may touch the new owner's record.
	 */
	const relinquishOwnership = (): void => {
		if (stopped) return;
		stopped = true;
		stopOwnershipObserver();
		detachPresence();
		if (timer) clearInterval(timer);
		timer = undefined;
		process.off("exit", closeOnExit);
		config.onDiagnostic?.("process-matrix: worker entry ownership moved to a newer process generation");
	};

	/**
	 * Accept a freshly read record as this generation's own. Ownership is decided when a record is
	 * ACCEPTED, not only when one is written: a tick whose directive answer needs no write still acts
	 * on what it read -- it keeps polling, and its grace deadline can still request an exit that would
	 * terminate the process the NEW generation is running in.
	 */
	const acceptOwnedRecord = (fresh: ProcessMatrixEntry | undefined): ProcessMatrixEntry | undefined => {
		if (fresh === undefined) return undefined;
		if (ownsGeneration(fresh)) return fresh;
		relinquishOwnership();
		return undefined;
	};

	/**
	 * The single fenced mutation gate for this branch. A watcher tick that was already awaiting a read
	 * when `stop()` ran must not write, mutate in-memory state, or authorize a follow-on transition:
	 * `closeWorker` has by then persisted the terminal record, and `closed` is terminal.
	 *
	 * The post-await fence does not need to undo a write that raced the fence. Writes are
	 * compare-and-swap under the store's own entry lock, so `closeWorker`'s retry loop re-reads and
	 * re-applies the terminal state; disk converges on terminal either way. What must not happen is
	 * this tick continuing as if it still owned the lifecycle.
	 */
	const persist = async (
		expected: ProcessMatrixEntry,
		next: ProcessMatrixEntry,
		failureContext: string,
	): Promise<boolean> => {
		if (stopped) return false;
		// The watcher ticks hand a FRESH stored record here as `expected`, so the compare-and-swap
		// would match whatever is on disk and succeed on its first try. The generation gate therefore
		// has to run before the write, not only in the CAS-failure branch below: otherwise a directive
		// written by a newer generation is executed by this one, overwriting its record.
		if (!ownsGeneration(expected)) {
			relinquishOwnership();
			return false;
		}
		try {
			if (await store.writeEntryIfUnchanged(config.agentDir, expected.entryId, expected, next)) {
				if (stopped) return false;
				entry = next;
				return true;
			}
			const current = await store.readEntry(config.agentDir, expected.entryId);
			if (stopped) return false;
			// Same gate on the re-read: a same-generation directive is adopted, anything else is a
			// newer owner whose record this runtime must not touch.
			if (ownsGeneration(current)) entry = current;
			else relinquishOwnership();
		} catch (error) {
			config.onDiagnostic?.(`process-matrix: ${failureContext}: ${describeError(error)}`);
		}
		return false;
	};

	const completeCooperativeCleanup = async (fresh: ProcessMatrixEntry): Promise<void> => {
		if (stopped) return;
		if (
			!(await persist(
				fresh,
				beginWindDown(fresh, "user_cleanup", nowIso(now)),
				"failed to write a master-requested worker wind-down",
			))
		)
			return;
		preserveResumableOnExit = false;
		emitRuntimeNotice(config, "process-matrix: the parent session requested a cooperative cleanup. Winding down.");
		await stop();
		await config.requestExit();
	};

	const runWatchTick = (tick: () => Promise<void>): Promise<void> => {
		if (watchTask) return watchTask;
		const task = tick().finally(() => {
			if (watchTask === task) watchTask = undefined;
			if (ownershipPending && !stopped) scheduleOwnershipRefresh();
			if (presenceCheckPending && !stopped) schedulePresenceCheck();
		});
		watchTask = task;
		return task;
	};

	const waitForIdle = (options?: ProcessMatrixIdleOptions): Promise<ProcessMatrixIdleResult> =>
		settleWithin(async () => {
			while (watchTask) await watchTask;
		}, options);

	const startHealthyWatch = (): void => {
		if (stopped) return;
		timer = setInterval(() => runWatchTick(healthyTick), config.settings.watcherPollMs);
		timer.unref?.();
		attachPresence();
	};

	/**
	 * Event source for parent death: the parent session's presence connection closing. It only wakes
	 * the verdict -- the master entry and pid still decide -- and a watch that never connected leaves
	 * the interval poll as the sole detector until the next healthy tick attaches again.
	 */
	const attachPresence = (): void => {
		const sessionId = currentParentSessionId;
		if (stopped || !sessionId || (presenceWatch && presenceSessionId === sessionId)) return;
		detachPresence();
		const watch: PresenceWatch = watchPresence(sessionId, (wasConnected) => {
			if (presenceWatch !== watch) return;
			presenceWatch = undefined;
			presenceSessionId = undefined;
			if (wasConnected) schedulePresenceCheck();
		});
		presenceWatch = watch;
		presenceSessionId = sessionId;
	};

	const schedulePresenceCheck = (): void => {
		if (stopped) return;
		presenceCheckPending = true;
		if (watchTask) return;
		void runWatchTick(async () => {
			while (presenceCheckPending && !stopped) {
				presenceCheckPending = false;
				await confirmParentLoss();
			}
		}).catch(reportOwnershipError);
	};

	/** A dying master closes its descriptors before it is reaped, so for a moment its pid still answers. */
	const PRESENCE_CONFIRM_DELAYS_MS = [0, 50, 100, 200, 400, 800] as const;
	const confirmParentLoss = async (): Promise<void> => {
		for (const delayMs of PRESENCE_CONFIRM_DELAYS_MS) {
			if (delayMs > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, delayMs).unref?.());
			}
			if (stopped || preserveResumableOnExit) return;
			const verdict = await parentLiveness(currentParentPid, currentParentSessionId);
			if (stopped || preserveResumableOnExit) return;
			if (!verdict.alive) {
				await enterWindDown(verdict.code);
				return;
			}
		}
	};

	const parentLiveness = async (pid: number, sessionId: string | undefined): Promise<ParentLiveness> => {
		const observation = sessionId ? config.observeProcess(pid) : "unknown";
		const parentEntry =
			sessionId && observation === "alive"
				? await store.readEntry(config.agentDir, buildEntryId("master", sessionId))
				: undefined;
		return classifyParentLiveness({
			parentPid: pid,
			parentSessionId: sessionId,
			observation,
			parentEntry,
			nowMs: now(),
			maxHeartbeatAgeMs: heartbeatAgeBoundMs,
			observerSuspended: now() < heartbeatForgivenUntil,
		});
	};

	const parentIsAlive = async (pid: number, sessionId: string | undefined): Promise<boolean> =>
		(await parentLiveness(pid, sessionId)).alive;

	/** Record a tick's wall-clock gap; a suspension forgives a stale parent heartbeat for one heartbeat bound. */
	const noteTickGap = (): void => {
		const tickMs = now();
		const jump = detectClockJump(previousWatchTickMs, tickMs, config.settings.watcherPollMs);
		previousWatchTickMs = tickMs;
		if (jump) heartbeatForgivenUntil = tickMs + heartbeatAgeBoundMs;
	};

	const refreshParentOwnership = async (): Promise<void> => {
		if (stopped || !config.parentOwnership) return;
		try {
			const owner = config.parentOwnership.read();
			if (!owner) return;
			if (
				!Number.isSafeInteger(owner.generation) ||
				owner.generation < 1 ||
				!Number.isSafeInteger(owner.parentPid) ||
				owner.parentPid < 1 ||
				typeof owner.parentSessionId !== "string" ||
				!owner.parentSessionId.trim() ||
				owner.parentSessionId.length > 512
			)
				throw new Error("Invalid effective parent ownership.");
			const sameParent = owner.parentPid === currentParentPid && owner.parentSessionId === currentParentSessionId;
			if (owner.generation < ownershipGeneration || (owner.generation === ownershipGeneration && !sameParent))
				return;
			if (sameParent) {
				ownershipGeneration = owner.generation;
				return;
			}
			if (!(await parentIsAlive(owner.parentPid, owner.parentSessionId)) || stopped) return;
			const fresh = await store.readEntry(config.agentDir, entry.entryId);
			if (stopped) return;
			const owned = acceptOwnedRecord(fresh);
			if (!owned || owned.status === "closed" || owned.windDownReason === "user_cleanup") return;
			if (!(await persist(owned, applyAdoption(owned, owner), "failed to transfer worker supervision"))) return;
			currentParentPid = owner.parentPid;
			currentParentSessionId = owner.parentSessionId;
			ownershipGeneration = owner.generation;
			attachPresence();
			if (preserveResumableOnExit) {
				preserveResumableOnExit = false;
				if (timer) clearInterval(timer);
				timer = undefined;
				startHealthyWatch();
			}
		} catch (error) {
			reportOwnershipError(error);
		}
	};

	const scheduleOwnershipRefresh = (): void => {
		if (stopped) return;
		ownershipPending = true;
		if (watchTask) return;
		void runWatchTick(async () => {
			while (ownershipPending && !stopped) {
				ownershipPending = false;
				await refreshParentOwnership();
			}
		}).catch(reportOwnershipError);
	};

	const healthyTick = async (): Promise<void> => {
		if (stopped) return;
		noteTickGap();
		await refreshParentOwnership();
		if (stopped) return;
		// The owner-approved cleanup directive comes first: a worker whose parent is also gone must
		// still honour it rather than overwrite it with a parent-lost wind-down.
		const fresh = await store.readEntry(config.agentDir, entry.entryId);
		if (stopped) return;
		const owned = acceptOwnedRecord(fresh);
		if (stopped) return;
		if (
			owned &&
			pollWorkerDirective(owned, currentParentPid, { observeProcess: config.observeProcess }).code === "user_cleanup"
		) {
			await completeCooperativeCleanup(owned);
			return;
		}
		const verdict = await parentLiveness(currentParentPid, currentParentSessionId);
		// The liveness read is asynchronous; `stop()` may have completed while it was outstanding, and
		// its verdict describes a lifecycle this tick no longer owns.
		if (stopped) return;
		if (!verdict.alive) {
			await enterWindDown(verdict.code);
			return;
		}
		attachPresence();
	};

	const enterWindDown = async (cause: ParentLossCode): Promise<void> => {
		if (stopped) return;
		const windDownAt = nowIso(now);
		const expected = entry;
		const resumable: ResumablePayload = { lastCode: "resumable", agent: structuredClone(config.agent) };
		if (expected.taskRef !== undefined) resumable.taskRef = expected.taskRef;
		if (expected.taskSummary !== undefined) resumable.taskSummary = expected.taskSummary;
		const woundDown = markResumable(beginWindDown(expected, "parent_lost", windDownAt), resumable, windDownAt);
		if (!(await persist(expected, woundDown, "failed to write worker wind-down"))) return;
		if (timer) clearInterval(timer);
		timer = undefined;
		preserveResumableOnExit = true;
		detachPresence();
		emitRuntimeNotice(
			config,
			`process-matrix: parent process (pid ${currentParentPid}) is no longer supervising this worker (${cause}). Winding down gracefully; this task is resumable, and this worker stays attached if that parent resumes or another adopts it within the grace window.`,
		);
		startGraceWatch();
	};

	const startGraceWatch = (): void => {
		if (stopped) return;
		const graceDeadline = now() + config.settings.adoptionGraceMs;
		timer = setInterval(() => runWatchTick(() => graceTick(graceDeadline)), config.settings.watcherPollMs);
		timer.unref?.();
	};

	const graceTick = async (graceDeadline: number): Promise<void> => {
		if (stopped) return;
		// A suspension observed here forgives a stale parent heartbeat in the re-attach check below.
		noteTickGap();
		await refreshParentOwnership();
		if (stopped || !preserveResumableOnExit) return;
		const fresh = await store.readEntry(config.agentDir, entry.entryId);
		// A stop that completed while this read was outstanding ends the grace window: neither an
		// adoption nor a grace expiry may re-arm a timer, notify, or request exit after it.
		if (stopped) return;
		const owned = acceptOwnedRecord(fresh);
		// Ownership moved while this window was open: no directive, no expiry, and above all no exit
		// request -- that exit would end the newer generation's process.
		if (stopped) return;
		if (owned) {
			const directive = pollWorkerDirective(owned, currentParentPid, { observeProcess: config.observeProcess });
			if (directive.code === "adopt" && owned.parentSessionId) {
				// The adopting master persists its session id with the pid. Require both on the next
				// healthy tick; accepting a pid-only adoption would reintroduce the PID-reuse bug.
				if (
					!(await persist(
						owned,
						applyAdoption(owned, { parentPid: directive.parentPid, parentSessionId: owned.parentSessionId }),
						"failed to write worker adoption",
					))
				)
					return;
				currentParentPid = directive.parentPid;
				currentParentSessionId = owned.parentSessionId;
				preserveResumableOnExit = false;
				if (timer) {
					clearInterval(timer);
					timer = undefined;
				}
				startHealthyWatch();
				emitRuntimeNotice(
					config,
					`process-matrix: adopted by a new parent (pid ${directive.parentPid}). Resuming.`,
				);
				return;
			}
			if (directive.code === "user_cleanup") {
				await completeCooperativeCleanup(owned);
				return;
			}
			// The same parent process and session heartbeating again (a stall or suspension, not a
			// death): re-attach instead of exiting. A restarted master is a different pid and arrives
			// as an adoption directive above.
			if (owned.status !== "closed" && (await parentLiveness(currentParentPid, currentParentSessionId)).alive) {
				if (stopped) return;
				if (
					!(await persist(
						owned,
						applyAdoption(owned, {
							parentPid: currentParentPid,
							...(currentParentSessionId !== undefined ? { parentSessionId: currentParentSessionId } : {}),
						}),
						"failed to write worker re-attachment",
					))
				)
					return;
				preserveResumableOnExit = false;
				if (timer) {
					clearInterval(timer);
					timer = undefined;
				}
				startHealthyWatch();
				emitRuntimeNotice(
					config,
					`process-matrix: parent process (pid ${currentParentPid}) is supervising again. Staying attached.`,
				);
				return;
			}
		}
		if (now() >= graceDeadline) {
			await stop();
			await config.requestExit();
		}
	};

	try {
		unsubscribeOwnership = config.parentOwnership?.subscribe(scheduleOwnershipRefresh, reportOwnershipError);
	} catch (error) {
		reportOwnershipError(error);
	}
	await runWatchTick(refreshParentOwnership);
	startHealthyWatch();

	return { stop, waitForIdle };
}
