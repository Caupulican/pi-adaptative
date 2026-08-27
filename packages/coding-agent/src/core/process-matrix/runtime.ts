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
 *   session and goal identity recover automatically. Every non-matching worker is report-only:
 *   dead workers are never resume-prompted and still-live workers are never adopt/cleanup-prompted.
 *
 * Sanctioned exception to "a worker's entry is written only by that worker": an exact resumed
 * parent may restore its recorded ownership. The worker later confirms/applies the directive via
 * `pollWorkerDirective` and re-writes its own entry -- see `docs/process-matrix.md`. Outside this
 * identity-fenced handshake, the orphan claim scan NEVER writes another session's entry; bounded
 * reconciliation may still perform generation-fenced lifecycle/TTL maintenance, and nothing here
 * ever kills a process directly.
 */

import { hostname as osHostname } from "node:os";
import { isAgentIdentity } from "../orchestration/agent-resume.ts";
import type { AgentIdentityContract } from "../orchestration/contracts.ts";
import { getParentPid, getParentSessionId, getProcessTaskRef } from "../process-identity.ts";
import type { ResolvedProcessMatrixSettings } from "../settings-manager.ts";
import { getBoundWorktreeLaneKey } from "../worktree-sync/runtime.ts";
import type { ProcessMatrixEntry, ResumablePayload } from "./codes.ts";
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

export interface ProcessMatrixRuntimeConfig {
	agentDir: string;
	/** Canonical logical identity for this process and any exact-session resume. */
	agent: AgentIdentityContract;
	settings: ResolvedProcessMatrixSettings;
	isProcessAlive: (pid: number) => boolean;
	now?: () => number;
	/** Structural notice injection into the running session (host `sendCustomMessage` seam). */
	notify: (text: string) => void | Promise<void>;
	/** Diagnostics sink (never throws into the session). */
	onDiagnostic?: (message: string) => void;
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
}

export type ResumeWorkerLaunchOutcome =
	| {
			started: true;
			/** OS identity of this specific replacement process, used to fence its terminal handoff. */
			pid: number;
			completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	  }
	| { started: false; reason: string };

export interface ProcessMatrixRuntimeHandle {
	stop(): Promise<void> | void;
	/** Resolve after every watcher task that is active at the call boundary has settled. */
	waitForIdle(): Promise<void>;
}

const NOOP_HANDLE: ProcessMatrixRuntimeHandle = { stop: () => {}, waitForIdle: async () => {} };
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

	let stopped = false;
	let ownsEntry = true;
	let heartbeatTask: Promise<void> | undefined;
	const lifetime = new AbortController();
	const heartbeatTimer = setInterval(() => {
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
	});

	return {
		async waitForIdle() {
			await maintenance;
			await heartbeatTask;
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
			await maintenance;
		},
	};
}

async function reconcileAndRunOrphanScan(
	config: ProcessMatrixRuntimeConfig,
	now: () => number,
	signal: AbortSignal,
): Promise<void> {
	const store = resolveProcessMatrixStore(config);
	let entries: ProcessMatrixEntry[];
	try {
		entries = await store.listEntries(config.agentDir);
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: reconciliation failed to list entries: ${describeError(error)}`);
		return;
	}
	if (signal.aborted) return;
	const reconciled = reconcileMatrix(entries, {
		isPidAlive: (pid) => pid === process.pid || config.isProcessAlive(pid),
		now: now(),
		resumableTtlMs: PROCESS_MATRIX_RESUMABLE_RETENTION_MS,
	});
	const originalByEntryId = new Map(entries.map((entry) => [entry.entryId, entry]));
	const recoveredEntryIdSet = new Set(reconciled.recoveredEntryIds);
	const [, recoveredOutcomes] = await Promise.all([
		Promise.all(
			reconciled.prunedEntryIds.map((entryId) => {
				const original = originalByEntryId.get(entryId);
				return original ? store.removeEntryIfUnchanged(config.agentDir, original) : false;
			}),
		),
		Promise.all(
			reconciled.kept
				.filter((entry) => recoveredEntryIdSet.has(entry.entryId))
				.map((entry) => {
					const original = originalByEntryId.get(entry.entryId);
					return original ? store.writeEntryIfUnchanged(config.agentDir, entry.entryId, original, entry) : false;
				}),
		),
	]);
	if (signal.aborted) return;
	const recoveredCount = recoveredOutcomes.filter(Boolean).length;
	if (recoveredCount > 0) {
		config.onDiagnostic?.(
			`process-matrix: recovered ${recoveredCount} interrupted Pi worker entr${recoveredCount === 1 ? "y" : "ies"}`,
		);
	}
	const currentEntries = await store.listEntries(config.agentDir);
	await deliverTerminalNotifications(config, currentEntries, now, signal);
	if (signal.aborted) return;
	await runOrphanScan(config, currentEntries, signal);
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
): Promise<void> {
	const orphans = detectOrphanedWorkers(entries, {
		isPidAlive: config.isProcessAlive,
		ownSessionId: config.agent.resumeContext.sessionId,
	});
	if (orphans.length === 0) return;

	for (const orphan of orphans) {
		if (signal.aborted) return;
		const recoveryBoundary = getAutomaticRecoveryBoundary(config, orphan);
		const exactResumedParent = recoveryBoundary === undefined;
		if (!exactResumedParent) {
			// Foreign workers are never claimed or cleaned up implicitly. This applies equally to
			// dead workers (no resume prompt) and still-live workers (no adopt/cleanup prompt).
			reportUnrecoveredOrphan(config, orphan, recoveryBoundary);
			continue;
		}
		if (!config.isProcessAlive(orphan.pid)) {
			await resumeDeadOrphan(config, orphan, signal);
			continue;
		}
		await adoptLiveOrphan(config, orphan, signal);
	}
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
		`process-matrix: found unrecovered orphan ${orphan.entryId} (${reason}; report-only; nothing written, nothing killed)`,
	);
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
		if (selfRegistered?.pid === claimed.pid) {
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
		}
		process.off("exit", closeOnExit);
	};

	const stop = (): Promise<void> => {
		stopTask ??= closeWorker();
		return stopTask;
	};

	const persist = async (
		expected: ProcessMatrixEntry,
		next: ProcessMatrixEntry,
		failureContext: string,
	): Promise<boolean> => {
		try {
			if (await store.writeEntryIfUnchanged(config.agentDir, expected.entryId, expected, next)) {
				entry = next;
				return true;
			}
			const current = await store.readEntry(config.agentDir, expected.entryId);
			if (current?.pid === process.pid) entry = current;
			else {
				stopped = true;
				if (timer) clearInterval(timer);
				timer = undefined;
				process.off("exit", closeOnExit);
				config.onDiagnostic?.("process-matrix: worker entry ownership moved to a newer process generation");
			}
		} catch (error) {
			config.onDiagnostic?.(`process-matrix: ${failureContext}: ${describeError(error)}`);
		}
		return false;
	};

	const completeCooperativeCleanup = async (fresh: ProcessMatrixEntry): Promise<void> => {
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
		});
		watchTask = task;
		return task;
	};

	const waitForIdle = async (): Promise<void> => {
		while (watchTask) await watchTask;
	};

	const startHealthyWatch = (): void => {
		timer = setInterval(() => runWatchTick(healthyTick), config.settings.watcherPollMs);
		timer.unref?.();
	};

	const declaredParentIsAlive = async (): Promise<boolean> => {
		// PID liveness alone is not process identity: a reused PID could otherwise keep a worker
		// attached to an unrelated process forever. The parent session's own fresh master entry binds
		// PID to a durable identity and proves that that exact session is still heartbeating.
		if (!currentParentSessionId || !config.isProcessAlive(currentParentPid)) return false;
		const parent = await store.readEntry(config.agentDir, buildEntryId("master", currentParentSessionId));
		if (!parent || parent.role !== "master" || parent.agent.resumeContext.sessionId !== currentParentSessionId)
			return false;
		if (parent.pid !== currentParentPid || parent.status !== "running") return false;
		const heartbeatAt = Date.parse(parent.heartbeatAt);
		const maxAge = config.settings.heartbeatMs * 2 + config.settings.watcherPollMs;
		return Number.isFinite(heartbeatAt) && now() - heartbeatAt <= maxAge;
	};

	const healthyTick = async (): Promise<void> => {
		if (stopped) return;
		if (!(await declaredParentIsAlive())) {
			await enterWindDown();
			return;
		}
		// Still healthy: also poll for a master-initiated cooperative-cleanup directive.
		const fresh = await store.readEntry(config.agentDir, entry.entryId);
		if (!fresh) return;
		const directive = pollWorkerDirective(fresh, currentParentPid, { isPidAlive: config.isProcessAlive });
		if (directive.code !== "user_cleanup") return;
		await completeCooperativeCleanup(fresh);
	};

	const enterWindDown = async (): Promise<void> => {
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
		emitRuntimeNotice(
			config,
			`process-matrix: parent process (pid ${currentParentPid}) is gone. Winding down gracefully; this task is resumable.`,
		);
		startGraceWatch();
	};

	const startGraceWatch = (): void => {
		const graceDeadline = now() + config.settings.adoptionGraceMs;
		timer = setInterval(() => runWatchTick(() => graceTick(graceDeadline)), config.settings.watcherPollMs);
		timer.unref?.();
	};

	const graceTick = async (graceDeadline: number): Promise<void> => {
		if (stopped) return;
		const fresh = await store.readEntry(config.agentDir, entry.entryId);
		if (fresh) {
			const directive = pollWorkerDirective(fresh, currentParentPid, { isPidAlive: config.isProcessAlive });
			if (directive.code === "adopt" && fresh.parentSessionId) {
				// The adopting master persists its session id with the pid. Require both on the next
				// healthy tick; accepting a pid-only adoption would reintroduce the PID-reuse bug.
				if (
					!(await persist(
						fresh,
						applyAdoption(fresh, { parentPid: directive.parentPid, parentSessionId: fresh.parentSessionId }),
						"failed to write worker adoption",
					))
				)
					return;
				emitRuntimeNotice(
					config,
					`process-matrix: adopted by a new parent (pid ${directive.parentPid}). Resuming.`,
				);
				currentParentPid = directive.parentPid;
				currentParentSessionId = fresh.parentSessionId;
				preserveResumableOnExit = false;
				if (timer) {
					clearInterval(timer);
					timer = undefined;
				}
				startHealthyWatch();
				return;
			}
			if (directive.code === "user_cleanup") {
				await completeCooperativeCleanup(fresh);
				return;
			}
		}
		if (now() >= graceDeadline) {
			await stop();
			await config.requestExit();
		}
	};

	startHealthyWatch();

	return { stop, waitForIdle };
}
