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
 *   workers (workers whose recorded parent is dead) and, when interactive, ASKS the owner before
 *   touching anything -- adopt, cooperative cleanup, or leave untouched. Non-interactive: report
 *   only, zero writes, zero kills.
 *
 * One sanctioned exception to "a worker's entry is written only by that worker": the master
 * orphan-scan writes an adoption or a cooperative-cleanup request directly into an ORPHANED
 * worker's own entry, but ONLY after explicit owner confirmation (`promptConfirm`) -- mirroring
 * the worktree-sync integration lock's dead-owner takeover (a new owner may claim a PROVABLY DEAD
 * owner's resource). The worker itself later confirms/applies that grant locally via
 * `pollWorkerDirective` and re-writes its own entry -- see `docs/process-matrix.md`. Outside this
 * one ask-gated handshake, a master NEVER writes another session's entry, and nothing here ever
 * kills a process directly: every termination is either owner-confirmed or the worker's own
 * cooperative self-exit.
 */

import { hostname as osHostname } from "node:os";
import type { ResolvedProcessMatrixSettings } from "../settings-manager.ts";
import { getBoundWorktreeLaneKey } from "../worktree-sync/runtime.ts";
import type { ProcessMatrixEntry, ResumablePayload } from "./codes.ts";
import { buildEntryId, listEntries, readEntry, writeEntry, writeEntrySync } from "./store.ts";
import {
	applyAdoption,
	applyHeartbeat,
	beginWindDown,
	buildMasterEntry,
	buildWorkerEntry,
	detectOrphanedWorkers,
	markClosed,
	markResumable,
	pollWorkerDirective,
} from "./supervisor.ts";

export const PI_PARENT_PID_ENV = "PI_PARENT_PID";
export const PI_PARENT_SESSION_ENV = "PI_PARENT_SESSION";

/** This process's declared parent pid, from the cross-process env contract. A malformed or
 * non-positive value is ignored (never a crash on bad env). */
export function getParentPid(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env[PI_PARENT_PID_ENV];
	if (raw === undefined) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** This process's declared parent sessionId, from the cross-process env contract. */
export function getParentSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[PI_PARENT_SESSION_ENV]?.trim();
	return value && value.length > 0 ? value : undefined;
}

export interface ProcessMatrixRuntimeConfig {
	agentDir: string;
	sessionId: string;
	/** Whether an interactive UI is available to ask the owner (see `promptConfirm`). */
	hasUI: boolean;
	settings: ResolvedProcessMatrixSettings;
	isProcessAlive: (pid: number) => boolean;
	now?: () => number;
	/** Structural notice injection into the running session (host `sendCustomMessage` seam). */
	notify: (text: string) => void;
	/** Diagnostics sink (never throws into the session). */
	onDiagnostic?: (message: string) => void;
	/** The ask seam: resolves false on decline AND on any non-interactive/non-TTY caller. */
	promptConfirm: (message: string) => Promise<boolean>;
	/** Cooperative self-exit -- called by a worker once wound down (grace expiry or a
	 * master-granted cleanup directive). Never called for the master's own lifecycle. */
	requestExit: () => void;
}

export interface ProcessMatrixRuntimeHandle {
	stop(): void;
}

const NOOP_HANDLE: ProcessMatrixRuntimeHandle = { stop: () => {} };

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function nowIso(now: () => number): string {
	return new Date(now()).toISOString();
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
		sessionId: config.sessionId,
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
	process.on("exit", () => {
		try {
			writeEntrySync(config.agentDir, markClosed(entry, nowIso(now)));
		} catch {
			// Best-effort only -- see module doc.
		}
	});

	void runOrphanScan(config, now);

	return {
		stop() {
			stopped = true;
			clearInterval(heartbeatTimer);
		},
	};
}

async function runOrphanScan(config: ProcessMatrixRuntimeConfig, now: () => number): Promise<void> {
	let entries: ProcessMatrixEntry[];
	try {
		entries = await listEntries(config.agentDir);
	} catch (error) {
		config.onDiagnostic?.(`process-matrix: orphan scan failed to list entries: ${describeError(error)}`);
		return;
	}
	const orphans = detectOrphanedWorkers(entries, {
		isPidAlive: config.isProcessAlive,
		ownSessionId: config.sessionId,
	});
	if (orphans.length === 0) return;

	if (!config.hasUI) {
		config.onDiagnostic?.(
			`process-matrix: found ${orphans.length} orphaned worker(s) with no reachable parent (report-only, non-interactive; nothing written, nothing killed): ${orphans
				.map((orphan) => orphan.entryId)
				.join(", ")}`,
		);
		return;
	}

	for (const orphan of orphans) {
		const adopt = await config.promptConfirm(`adopt worker ${orphan.entryId} (lane ${orphan.laneKey ?? "none"})?`);
		if (adopt) {
			const adopted = applyAdoption(orphan, { parentPid: process.pid, parentSessionId: config.sessionId });
			try {
				await writeEntry(config.agentDir, adopted);
			} catch (error) {
				config.onDiagnostic?.(
					`process-matrix: failed to write adoption for ${orphan.entryId}: ${describeError(error)}`,
				);
			}
			continue;
		}
		const cleanup = await config.promptConfirm(`clean up worker ${orphan.entryId} gracefully?`);
		if (!cleanup) continue;
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

// ---------------------------------------------------------------------------
// Worker branch
// ---------------------------------------------------------------------------

async function startWorkerBranch(
	config: ProcessMatrixRuntimeConfig,
	initialParentPid: number,
	now: () => number,
): Promise<ProcessMatrixRuntimeHandle> {
	const parentSessionId = getParentSessionId();
	const laneKey = getBoundWorktreeLaneKey();

	let entry = buildWorkerEntry({
		sessionId: config.sessionId,
		pid: process.pid,
		hostname: osHostname(),
		now: nowIso(now),
		parentPid: initialParentPid,
		...(parentSessionId !== undefined ? { parentSessionId } : {}),
		...(laneKey !== undefined ? { laneKey } : {}),
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

	const stop = (): void => {
		stopped = true;
		if (timer) clearInterval(timer);
		timer = undefined;
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
		if (!parent || parent.role !== "master" || parent.sessionId !== currentParentSessionId) return false;
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
		config.notify("process-matrix: the parent session requested a cooperative cleanup. Winding down.");
		stop();
		config.requestExit();
	};

	const enterWindDown = async (): Promise<void> => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		const windDownAt = nowIso(now);
		const resumable: ResumablePayload = { lastCode: "resumable" };
		if (laneKey !== undefined) resumable.laneKey = laneKey;
		await persist(
			markResumable(beginWindDown(entry, "parent_lost", windDownAt), resumable, windDownAt),
			"failed to write worker wind-down",
		);
		config.notify(
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
				config.notify(`process-matrix: adopted by a new parent (pid ${directive.parentPid}). Resuming.`);
				currentParentPid = directive.parentPid;
				currentParentSessionId = fresh.parentSessionId;
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
