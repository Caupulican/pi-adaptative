import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stateFile } from "../agent-paths.ts";
import { isProcessAlive } from "../process-liveness.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { ProviderRequestLane } from "./lane-context.ts";

/**
 * Machine-wide record of the provider requests currently in flight from every pi process on this
 * agent directory: owner sessions, their delegated workers, background lanes. One JSON file per
 * request under `state/provider-admission/`, written when the request is admitted and removed when
 * its stream settles, so counting a provider's load is one directory read and nothing has to
 * coordinate through a long-lived daemon.
 *
 * Why a file per request rather than one counter file: every process owns exactly its own entries,
 * a crash leaves entries a later reader can prove dead (their pid is gone or their heartbeat is
 * stale) and prune, and there is no read-modify-write of shared state outside the short admission
 * lock. Measured 2026-09-11 on the owner's box: no process knew what the others were sending, so
 * eight requests to one account overlapped while the owner's own turn waited behind them.
 */

export interface ProviderAdmissionEntry {
	id: string;
	provider: string;
	lane: ProviderRequestLane;
	pid: number;
	sessionId?: string;
	startedAt: string;
	heartbeatAt: string;
}

export interface ProviderAdmissionHold {
	readonly id: string;
	release(): void;
}

export interface ProviderInflightCount {
	total: number;
	byLane: Record<ProviderRequestLane, number>;
}

export interface ProviderAdmissionLedgerOptions {
	now?: () => number;
	isProcessAlive?: (pid: number) => boolean;
	pid?: number;
	sessionId?: string;
	/** How often a held entry rewrites its heartbeat. */
	heartbeatMs?: number;
	/** An entry whose owner is alive but whose heartbeat is older than this is treated as abandoned. */
	staleMs?: number;
}

export const PROVIDER_ADMISSION_HEARTBEAT_MS = 10_000;
export const PROVIDER_ADMISSION_STALE_MS = 45_000;
const ENTRY_SUFFIX = ".json";
const LOCK_FILE = "admission.lock";
const LANES: readonly ProviderRequestLane[] = ["foreground", "worker", "background"];

export function providerAdmissionDir(agentDir: string): string {
	return stateFile(agentDir, "provider-admission");
}

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "provider";
}

function isEntry(value: unknown): value is ProviderAdmissionEntry {
	return (
		isPlainRecord(value) &&
		typeof value.id === "string" &&
		typeof value.provider === "string" &&
		typeof value.lane === "string" &&
		LANES.includes(value.lane as ProviderRequestLane) &&
		Number.isSafeInteger(value.pid) &&
		typeof value.startedAt === "string" &&
		typeof value.heartbeatAt === "string" &&
		(value.sessionId === undefined || typeof value.sessionId === "string")
	);
}

export class ProviderAdmissionLedger {
	private readonly dir: string;
	private readonly lockPath: string;
	private readonly now: () => number;
	private readonly isAlive: (pid: number) => boolean;
	private readonly pid: number;
	private readonly sessionId: string | undefined;
	private readonly heartbeatMs: number;
	private readonly staleMs: number;
	private readonly holds = new Map<string, () => void>();
	private sequence = 0;

	constructor(agentDir: string, options: ProviderAdmissionLedgerOptions = {}) {
		this.dir = providerAdmissionDir(agentDir);
		this.lockPath = join(this.dir, LOCK_FILE);
		this.now = options.now ?? Date.now;
		this.isAlive = options.isProcessAlive ?? ((pid) => isProcessAlive(pid));
		this.pid = options.pid ?? process.pid;
		this.sessionId = options.sessionId;
		this.heartbeatMs = options.heartbeatMs ?? PROVIDER_ADMISSION_HEARTBEAT_MS;
		this.staleMs = options.staleMs ?? PROVIDER_ADMISSION_STALE_MS;
	}

	/** Register one in-flight request unconditionally. */
	acquire(provider: string, lane: ProviderRequestLane): ProviderAdmissionHold {
		this.ensureDir();
		return this.withLock(() => this.writeHold(provider, lane));
	}

	/**
	 * Admit one request only if fewer than `limit` requests to `provider` are in flight across the
	 * machine, deciding and registering under the same lock so two processes cannot both see the
	 * last free slot. Returns the observed count when the request has to wait.
	 */
	tryAcquire(
		provider: string,
		lane: ProviderRequestLane,
		limit: number,
	): { hold: ProviderAdmissionHold; inflight: number } | { hold?: undefined; inflight: number } {
		this.ensureDir();
		return this.withLock(() => {
			const inflight = this.countLocked(provider).total;
			if (inflight >= limit) return { inflight };
			return { hold: this.writeHold(provider, lane), inflight };
		});
	}

	/** Live requests to `provider` from every process, after pruning entries whose owner is gone. */
	countInflight(provider: string): ProviderInflightCount {
		if (!existsSync(this.dir)) return { total: 0, byLane: { foreground: 0, worker: 0, background: 0 } };
		return this.withLock(() => this.countLocked(provider));
	}

	/** Every live in-flight request across the machine, after pruning abandoned entries. */
	listInflight(): ProviderAdmissionEntry[] {
		if (!existsSync(this.dir)) return [];
		return this.withLock(() => this.collectLocked());
	}

	/** Release every hold this ledger still owns (session disposal). */
	releaseAll(): void {
		for (const release of [...this.holds.values()]) release();
	}

	private ensureDir(): void {
		mkdirSync(this.dir, { recursive: true });
	}

	private withLock<T>(fn: () => T): T {
		return withFileLockSync(this.lockPath, fn);
	}

	private writeHold(provider: string, lane: ProviderRequestLane): ProviderAdmissionHold {
		this.sequence += 1;
		const id = `${safeSegment(provider)}--${this.pid}--${this.now().toString(36)}-${this.sequence.toString(36)}`;
		const path = join(this.dir, `${id}${ENTRY_SUFFIX}`);
		const startedAt = new Date(this.now()).toISOString();
		const entry: ProviderAdmissionEntry = {
			id,
			provider,
			lane,
			pid: this.pid,
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			startedAt,
			heartbeatAt: startedAt,
		};
		writeFileAtomicSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		let released = false;
		const heartbeat = setInterval(() => {
			if (released) return;
			try {
				writeFileAtomicSync(
					path,
					`${JSON.stringify({ ...entry, heartbeatAt: new Date(this.now()).toISOString() })}\n`,
					{ mode: 0o600 },
				);
			} catch {
				// A missed heartbeat only shortens how long a crashed owner's entry survives.
			}
		}, this.heartbeatMs);
		heartbeat.unref?.();
		const release = (): void => {
			if (released) return;
			released = true;
			clearInterval(heartbeat);
			this.holds.delete(id);
			try {
				rmSync(path, { force: true });
			} catch (error) {
				if (!isMissingFileError(error)) throw error;
			}
		};
		this.holds.set(id, release);
		return { id, release };
	}

	private countLocked(provider: string): ProviderInflightCount {
		const byLane: Record<ProviderRequestLane, number> = { foreground: 0, worker: 0, background: 0 };
		let total = 0;
		for (const entry of this.collectLocked()) {
			if (entry.provider !== provider) continue;
			total += 1;
			byLane[entry.lane] += 1;
		}
		return { total, byLane };
	}

	private collectLocked(): ProviderAdmissionEntry[] {
		const live: ProviderAdmissionEntry[] = [];
		let names: string[];
		try {
			names = readdirSync(this.dir);
		} catch (error) {
			if (isMissingFileError(error)) return live;
			throw error;
		}
		const nowMs = this.now();
		for (const name of names) {
			if (!name.endsWith(ENTRY_SUFFIX)) continue;
			const path = join(this.dir, name);
			let entry: unknown;
			try {
				entry = JSON.parse(readFileSync(path, "utf-8")) as unknown;
			} catch {
				// A half-written or corrupt entry is not evidence of a live request.
				rmSync(path, { force: true });
				continue;
			}
			if (!isEntry(entry)) {
				rmSync(path, { force: true });
				continue;
			}
			const heartbeatMs = Date.parse(entry.heartbeatAt);
			const abandoned =
				(entry.pid !== this.pid && !this.isAlive(entry.pid)) ||
				!Number.isFinite(heartbeatMs) ||
				nowMs - heartbeatMs > this.staleMs;
			if (abandoned) {
				rmSync(path, { force: true });
				continue;
			}
			live.push(entry);
		}
		return live.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	}
}
