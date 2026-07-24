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
 *   workers (workers whose recorded parent is dead). Workers owned by this exact resumed session
 *   are restored automatically; foreign workers remain owner-gated interactively and report-only
 *   headlessly.
 *
 * Sanctioned exceptions to "a worker's entry is written only by that worker": an exact resumed
 * parent may restore its recorded ownership, and an owner may explicitly approve adoption or
 * cooperative cleanup of a foreign orphan. The worker later confirms/applies the directive via
 * `pollWorkerDirective` and re-writes its own entry -- see `docs/process-matrix.md`. Outside these
 * identity/approval-fenced handshakes, a master NEVER writes another session's entry, and nothing
 * here ever kills a process directly.
 */

import { hostname as osHostname } from "node:os";
import { isAgentIdentity } from "../orchestration/agent-resume.ts";
import type { AgentIdentityContract } from "../orchestration/contracts.ts";
import { getParentPid, getParentSessionId, getProcessTaskRef } from "../process-identity.ts";
import type { ResolvedProcessMatrixSettings } from "../settings-manager.ts";
import { getBoundWorktreeLaneKey } from "../worktree-sync/runtime.ts";
import type { ProcessMatrixEntry, ResumablePayload } from "./codes.ts";
import { buildEntryId, listEntries, readEntry, removeEntry, writeEntry, writeEntrySync } from "./store.ts";
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

export interface ProcessMatrixRuntimeConfig {
	agentDir: string;
	/** Canonical logical identity for this process and any exact-session resume. */
	agent: AgentIdentityContract;
	/** Whether an interactive UI is available to ask the owner (see `promptConfirm`). */
	hasUI: boolean;
	settings: ResolvedProcessMatrixSettings;
	isProcessAlive: (pid: number) => boolean;
	now?: () => number;
	/** Structural notice injection into the running session (host `sendCustomMessage` seam). */
	notify: (text: string) => void | Promise<void>;
	/** Diagnostics sink (never throws into the session). */
	onDiagnostic?: (message: string) => void;
	/** The ask seam: resolves false on decline AND on any non-interactive/non-TTY caller. */
	promptConfirm: (message: string) => Promise<boolean>;
	/** Cooperative self-exit -- called by a worker once wound down (grace expiry or a
	 * master-granted cleanup directive). Never called for the master's own lifecycle. */
	requestExit: () => void;
	/** Stable goal/task identity. Automatic recovery requires an exact match. */
	taskRef?: string;
	taskSummary?: string;
	/** False for terminal/blocked owner state; recovery then remains explicit-owner gated. */
	allowAutomaticRecovery?: boolean;
	/** Starts a replacement OS process for a dead resumable worker. Completion is an event-driven
	 * terminal signal; worker product remains in its persisted session/artifacts. */
	resumeWorker?: (payload: ResumablePayload) => Promise<ResumeWorkerLaunchOutcome>;
}

export type ResumeWorkerLaunchOutcome =
	| {
			started: true;
			completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	  }
	| { started: false; reason: string };

export interface ProcessMatrixRuntimeHandle {
	stop(): Promise<void> | void;
}

const NOOP_HANDLE: ProcessMatrixRuntimeHandle = { stop: () => {} };
export const PROCESS_MATRIX_RESUMABLE_RETENTION_MS = 30 * 24 * 60 * 60_000;

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
	let entry = buildMasterEntry({
		agent: config.agent,
		pid: process.pid,
		hostname: osHostname(),
		now: nowIso(now),
	});
	try {
		await writeEntry(config.agentDir, entry);
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: failed to register master entry: ${describeError(error)}`);
	}

	let stopped = false;
	const lifetime = new AbortController();
	const heartbeatTimer = setInterval(() => {
		if (stopped) return;
		entry = applyHeartbeat(entry, nowIso(now));
		void writeEntry(config.agentDir, entry).catch((error) => {
			config.onDiagnostic?.(`process-matrix: failed to write master heartbeat: ${describeError(error)}`);
		});
	}, config.settings.heartbeatMs);
	heartbeatTimer.unref?.();

	// Best-effort close on process exit. A SIGKILLed master leaving "running" is fine -- reconcile's
	// own dead-pid detection covers it; this only makes the common clean-exit case tidy.
	const closeOnExit = (): void => {
		try {
			writeEntrySync(config.agentDir, markClosed(entry, nowIso(now)));
		} catch {
			// Best-effort only -- see module doc.
		}
	};
	process.once("exit", closeOnExit);

	const maintenance = reconcileAndRunOrphanScan(config, now, lifetime.signal).catch((error: unknown) => {
		config.onDiagnostic?.(`process-matrix: maintenance failed: ${describeError(error)}`);
	});

	return {
		async stop() {
			if (stopped) return;
			stopped = true;
			lifetime.abort();
			clearInterval(heartbeatTimer);
			closeOnExit();
			process.off("exit", closeOnExit);
			await maintenance;
		},
	};
}

async function reconcileAndRunOrphanScan(
	config: ProcessMatrixRuntimeConfig,
	now: () => number,
	signal: AbortSignal,
): Promise<void> {
	let entries: ProcessMatrixEntry[];
	try {
		entries = await listEntries(config.agentDir);
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
	const recoveredEntryIdSet = new Set(reconciled.recoveredEntryIds);
	await Promise.all([
		...reconciled.prunedEntryIds.map((entryId) => removeEntry(config.agentDir, entryId)),
		...reconciled.kept
			.filter((entry) => recoveredEntryIdSet.has(entry.entryId))
			.map((entry) => writeEntry(config.agentDir, entry)),
	]);
	if (signal.aborted) return;
	if (reconciled.recoveredEntryIds.length > 0) {
		config.onDiagnostic?.(
			`process-matrix: recovered ${reconciled.recoveredEntryIds.length} interrupted Pi worker entr${reconciled.recoveredEntryIds.length === 1 ? "y" : "ies"}`,
		);
	}
	if (reconciled.prunedEntryIds.length > 0) {
		config.onDiagnostic?.(
			`process-matrix: pruned ${reconciled.prunedEntryIds.length} terminal or expired entr${reconciled.prunedEntryIds.length === 1 ? "y" : "ies"}`,
		);
	}
	await deliverTerminalNotifications(config, reconciled.kept, now, signal);
	if (signal.aborted) return;
	await runOrphanScan(config, reconciled.kept, now, signal);
}

async function deliverTerminalNotifications(
	config: ProcessMatrixRuntimeConfig,
	entries: ProcessMatrixEntry[],
	now: () => number,
	signal: AbortSignal,
): Promise<void> {
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
			await writeEntry(config.agentDir, markTerminalNotificationDelivered(entry, nowIso(now)));
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
	now: () => number,
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
		if (!config.isProcessAlive(orphan.pid)) {
			if (!exactResumedParent) {
				if (!config.hasUI) {
					reportOwnerGatedOrphan(config, orphan, recoveryBoundary);
					continue;
				}
				const payload = orphan.resumable;
				if (!payload) {
					config.onDiagnostic?.(
						`process-matrix: dead worker ${orphan.entryId} is not resumable because its launch context is unavailable`,
					);
					continue;
				}
				const resume = await config.promptConfirm(
					`resume agent ${payload.agent.agentId} from its persisted session?`,
				);
				if (!resume || signal.aborted) continue;
			}
			await resumeDeadOrphan(config, orphan, signal);
			continue;
		}

		if (exactResumedParent) {
			await adoptLiveOrphan(config, orphan, signal);
			continue;
		}
		if (!config.hasUI) {
			reportOwnerGatedOrphan(config, orphan, recoveryBoundary);
			continue;
		}
		const adopt = await config.promptConfirm(
			`adopt worker ${orphan.entryId} (lane ${orphan.agent.resumeContext.worktreeLaneKey ?? "none"})?`,
		);
		if (signal.aborted) return;
		if (adopt) {
			await adoptLiveOrphan(config, orphan, signal);
			continue;
		}
		const cleanup = await config.promptConfirm(`clean up worker ${orphan.entryId} gracefully?`);
		if (!cleanup || signal.aborted) continue;
		const windingDown = beginWindDown(orphan, "user_cleanup", nowIso(now));
		try {
			await writeEntry(config.agentDir, windingDown);
		} catch (error) {
			config.onDiagnostic?.(
				`process-matrix: failed to write cleanup for ${orphan.entryId}: ${describeError(error)}`,
			);
		}
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

function reportOwnerGatedOrphan(config: ProcessMatrixRuntimeConfig, orphan: ProcessMatrixEntry, reason: string): void {
	config.onDiagnostic?.(
		`process-matrix: found owner-gated orphan ${orphan.entryId} (${reason}; report-only, non-interactive; nothing written, nothing killed)`,
	);
}

async function adoptLiveOrphan(
	config: ProcessMatrixRuntimeConfig,
	orphan: ProcessMatrixEntry,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) return;
	const adopted = applyAdoption(orphan, {
		parentPid: process.pid,
		parentSessionId: config.agent.resumeContext.sessionId,
	});
	try {
		await writeEntry(config.agentDir, adopted);
		if (signal.aborted) await writeEntry(config.agentDir, orphan);
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: failed to write adoption for ${orphan.entryId}: ${describeError(error)}`);
	}
}

async function resumeDeadOrphan(
	config: ProcessMatrixRuntimeConfig,
	orphan: ProcessMatrixEntry,
	signal: AbortSignal,
): Promise<void> {
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
	try {
		await writeEntry(config.agentDir, claimed);
		if (signal.aborted) {
			await writeEntry(config.agentDir, orphan);
			return;
		}
		const launched = await config.resumeWorker(payload);
		if (!launched.started) {
			await writeEntry(config.agentDir, orphan);
			config.onDiagnostic?.(`process-matrix: failed to resume ${orphan.entryId}: ${launched.reason}`);
			return;
		}
		void launched.completion.then(
			(result) => persistResumedWorkerTerminal(config, claimed, result, signal),
			(error: unknown) => {
				config.onDiagnostic?.(
					`process-matrix: resumed agent ${payload.agent.agentId} terminal signal failed: ${describeError(error)}`,
				);
			},
		);
	} catch (error) {
		try {
			await writeEntry(config.agentDir, orphan);
		} catch {
			// The original resumable record remains the intended recovery state.
		}
		config.onDiagnostic?.(`process-matrix: failed to resume ${orphan.entryId}: ${describeError(error)}`);
	}
}

async function persistResumedWorkerTerminal(
	config: ProcessMatrixRuntimeConfig,
	claimed: ProcessMatrixEntry,
	result: { code: number | null; signal: NodeJS.Signals | null },
	lifetime: AbortSignal,
): Promise<void> {
	let terminal: ProcessMatrixEntry;
	try {
		const current = (await readEntry(config.agentDir, claimed.entryId)) ?? claimed;
		terminal = markTerminal(current, result, new Date().toISOString());
		await writeEntry(config.agentDir, terminal);
	} catch (error) {
		config.onDiagnostic?.(
			`process-matrix: failed to persist terminal handoff for ${claimed.entryId}: ${describeError(error)}`,
		);
		return;
	}
	if (lifetime.aborted) return;
	try {
		await config.notify(formatTerminalNotification(terminal));
		if (lifetime.aborted) return;
		await writeEntry(config.agentDir, markTerminalNotificationDelivered(terminal, new Date().toISOString()));
	} catch (error) {
		config.onDiagnostic?.(
			`process-matrix: failed to deliver terminal handoff for ${claimed.entryId}: ${describeError(error)}`,
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
		await writeEntry(config.agentDir, entry);
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: failed to register worker entry: ${describeError(error)}`);
	}

	let currentParentPid = initialParentPid;
	let currentParentSessionId = parentSessionId;
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	let ticking = false;
	let preserveResumableOnExit = false;
	const closeOnExit = (code: number | null = null): void => {
		if (preserveResumableOnExit) return;
		try {
			writeEntrySync(config.agentDir, markTerminal(entry, { code, signal: null }, nowIso(now)));
		} catch {
			// Best-effort. Dead-pid reconciliation remains authoritative.
		}
	};
	process.once("exit", closeOnExit);

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (!preserveResumableOnExit) closeOnExit();
		process.off("exit", closeOnExit);
	};

	const persist = async (next: ProcessMatrixEntry, failureContext: string): Promise<void> => {
		entry = next;
		try {
			await writeEntry(config.agentDir, entry);
		} catch (error) {
			config.onDiagnostic?.(`process-matrix: ${failureContext}: ${describeError(error)}`);
		}
	};

	const startHealthyWatch = (): void => {
		timer = setInterval(() => {
			if (ticking) return;
			ticking = true;
			void healthyTick().finally(() => {
				ticking = false;
			});
		}, config.settings.watcherPollMs);
		timer.unref?.();
	};

	const declaredParentIsAlive = async (): Promise<boolean> => {
		// PID liveness alone is not process identity: a reused PID could otherwise keep a worker
		// attached to an unrelated process forever. The parent session's own fresh master entry binds
		// PID to a durable identity and proves that that exact session is still heartbeating.
		if (!currentParentSessionId || !config.isProcessAlive(currentParentPid)) return false;
		const parent = await readEntry(config.agentDir, buildEntryId("master", currentParentSessionId));
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
		const fresh = await readEntry(config.agentDir, entry.entryId);
		if (!fresh) return;
		const directive = pollWorkerDirective(fresh, currentParentPid, { isPidAlive: config.isProcessAlive });
		if (directive.code !== "user_cleanup") return;
		await persist(
			beginWindDown(fresh, "user_cleanup", nowIso(now)),
			"failed to write a master-requested worker wind-down",
		);
		emitRuntimeNotice(config, "process-matrix: the parent session requested a cooperative cleanup. Winding down.");
		stop();
		config.requestExit();
	};

	const enterWindDown = async (): Promise<void> => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		const windDownAt = nowIso(now);
		preserveResumableOnExit = true;
		const resumable: ResumablePayload = { lastCode: "resumable", agent: structuredClone(config.agent) };
		if (entry.taskRef !== undefined) resumable.taskRef = entry.taskRef;
		if (entry.taskSummary !== undefined) resumable.taskSummary = entry.taskSummary;
		await persist(
			markResumable(beginWindDown(entry, "parent_lost", windDownAt), resumable, windDownAt),
			"failed to write worker wind-down",
		);
		emitRuntimeNotice(
			config,
			`process-matrix: parent process (pid ${currentParentPid}) is gone. Winding down gracefully; this task is resumable.`,
		);
		startGraceWatch();
	};

	const startGraceWatch = (): void => {
		const graceDeadline = now() + config.settings.adoptionGraceMs;
		timer = setInterval(() => {
			if (ticking) return;
			ticking = true;
			void graceTick(graceDeadline).finally(() => {
				ticking = false;
			});
		}, config.settings.watcherPollMs);
		timer.unref?.();
	};

	const graceTick = async (graceDeadline: number): Promise<void> => {
		if (stopped) return;
		const fresh = await readEntry(config.agentDir, entry.entryId);
		if (fresh) {
			const directive = pollWorkerDirective(fresh, currentParentPid, { isPidAlive: config.isProcessAlive });
			if (directive.code === "adopt" && fresh.parentSessionId) {
				// The adopting master persists its session id with the pid. Require both on the next
				// healthy tick; accepting a pid-only adoption would reintroduce the PID-reuse bug.
				await persist(
					applyAdoption(fresh, { parentPid: directive.parentPid, parentSessionId: fresh.parentSessionId }),
					"failed to write worker adoption",
				);
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
				stop();
				config.requestExit();
				return;
			}
		}
		if (now() >= graceDeadline) {
			stop();
			config.requestExit();
		}
	};

	startHealthyWatch();

	return { stop };
}
