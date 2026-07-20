/**
 * Shared atomic-file helper: a single lock+tmp+rename implementation reused by every
 * on-disk store that does a read-modify-write against a JSON/text file. Modeled on the pattern
 * already proven in `memory/providers/file-store.ts` (proper-lockfile advisory lock + write-tmp-
 * then-rename); before this helper existed the pattern was copy-pasted per store, and most copies
 * were missing either the lock, the atomic write, or both.
 *
 * Two call shapes:
 *  - `withFileLock(Sync)` — hold an exclusive advisory lock across an arbitrary read-modify-write
 *    callback. The lock spans BOTH the read and the write, closing the classic RMW race where two
 *    writers each read the old content before either writes back.
 *  - `writeFileAtomic(Sync)` — write-tmp-then-rename. Used INSIDE a `withFileLock` callback (or
 *    standalone, for a pure overwrite that has no read step to race).
 *
 * Sync and async variants are both exported. Most existing stores expose a synchronous public API
 * called from hot, non-async paths (e.g. a per-token-stream perf sample), so the sync variant lets
 * them gain locking without forcing an async ripple through their callers; the async variant is for
 * call sites that are already async.
 */

import { promises as fsPromises, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export interface AtomicFileLockOptions {
	/**
	 * Bounded retry attempts while waiting for a lock already held elsewhere. Both variants use a
	 * SHORT, capped backoff (see {@link RETRY_MIN_TIMEOUT_MS}/{@link RETRY_MAX_TIMEOUT_MS}) — these
	 * stores' critical sections are sub-millisecond reads+writes of small JSON/text files, so
	 * contention should clear in milliseconds, not the multi-second-to-31-second worst case
	 * proper-lockfile's OWN default backoff produces for a bare numeric `retries` (its default
	 * `minTimeout` is 1000ms with factor 2 — see node_modules/retry/lib/retry.js). Passing a bare
	 * number straight through would turn brief contention into a multi-second stall on a hot path
	 * (e.g. a per-token-stream perf sample), so both variants instead build an explicit short-backoff
	 * `retry` options object.
	 * - Async (`withFileLock`): forwarded as `{retries, minTimeout, maxTimeout}` to proper-lockfile.
	 * - Sync (`withFileLockSync`): proper-lockfile's sync API REJECTS `retries > 0` outright (it
	 *   requires the whole acquire flow to be synchronous — see proper-lockfile/lib/adapter.js
	 *   `toSyncOptions`, which throws `ESYNC`). So the sync path implements its own bounded retry
	 *   around single `lockfile.lockSync` attempts, blocking briefly between them (Atomics.wait) —
	 *   callers are already fully synchronous fs code, so a short blocking wait on contention matches
	 *   the existing execution model rather than introducing a new one.
	 */
	retries?: number;
	/** Resolve symlinks before locking (proper-lockfile `realpath`); false matches file-store.ts. */
	realpath?: boolean;
	/** Lock staleness window in ms (proper-lockfile `stale`); omitted = proper-lockfile's own default. */
	stale?: number;
}

const DEFAULT_RETRIES = 5;
const DEFAULT_REALPATH = false;
/** Short capped backoff shared by both variants — see {@link AtomicFileLockOptions.retries}. */
const RETRY_MIN_TIMEOUT_MS = 20;
const RETRY_MAX_TIMEOUT_MS = 200;
function ensureLockDirSync(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

async function ensureLockDir(filePath: string): Promise<void> {
	await fsPromises.mkdir(dirname(filePath), { recursive: true });
}

function isLockedError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const code = (err as { code?: string }).code;
	if (code === "ELOCKED") return true;
	// On win32, mkdir-ing the lock directory can transiently surface EPERM (rather than the
	// expected EEXIST) when a previous incarnation of that directory is concurrently being
	// rmdir'd by the racing releaser — the mkdir lands mid-teardown and the OS reports "operation
	// not permitted" instead of "already exists". This is contention, not a real permissions
	// failure, so treat it identically to ELOCKED: retry with the existing backoff rather than
	// letting it escape as fatal. POSIX platforms don't exhibit this transient and keep surfacing
	// real EPERM (e.g. an actually unwritable directory) as fatal.
	if (code === "EPERM" && process.platform === "win32") return true;
	return false;
}

/** Block the calling thread for `ms` without spinning the CPU (Atomics.wait on a private buffer). */
function blockingSleepMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire a proper-lockfile sync lock with bounded retry on `ELOCKED` (proper-lockfile's sync API
 * itself forbids `retries > 0`; see {@link AtomicFileLockOptions.retries}).
 *
 * Backoff doubles each attempt (mirroring the `retry` module's own `factor: 2` default that the
 * async path gets for free from proper-lockfile), starting at {@link RETRY_MIN_TIMEOUT_MS} and
 * capped at {@link RETRY_MAX_TIMEOUT_MS} — a flat `RETRY_MIN_TIMEOUT_MS`-per-attempt wait (the
 * previous behavior) gave the sync path a far smaller total contention budget than its async
 * counterpart, which was too tight under real filesystem latency (e.g. mkdir/rmdir lock-directory
 * churn on Windows CI runners under load) and surfaced as spurious ELOCKED failures.
 */
function lockSyncWithRetry(filePath: string, options: AtomicFileLockOptions): () => void {
	const attempts = Math.max(1, options.retries ?? DEFAULT_RETRIES);
	const lockOptions = { realpath: options.realpath ?? DEFAULT_REALPATH, stale: options.stale };
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return lockfile.lockSync(filePath, lockOptions);
		} catch (err) {
			if (!isLockedError(err) || attempt === attempts) throw err;
			const backoffMs = Math.min(RETRY_MIN_TIMEOUT_MS * 2 ** (attempt - 1), RETRY_MAX_TIMEOUT_MS);
			blockingSleepMs(backoffMs);
		}
	}
	// Unreachable (the loop always returns or throws), but keeps the function's return type honest.
	throw new Error(`Failed to acquire lock for ${filePath}`);
}

/**
 * Hold an exclusive advisory lock on `filePath` for the duration of `fn` (sync). Always releases,
 * including when `fn` throws.
 */
export function withFileLockSync<T>(filePath: string, fn: () => T, options?: AtomicFileLockOptions): T {
	ensureLockDirSync(filePath);
	const release = lockSyncWithRetry(filePath, options ?? {});
	try {
		return fn();
	} finally {
		// A lock-cleanup failure must never mask fn()'s result (or replace fn()'s own thrown error) —
		// by this point fn() has already durably committed or failed on its own terms.
		try {
			release();
		} catch {
			// best-effort cleanup; a stale lock self-expires via proper-lockfile's `stale` window
		}
	}
}

/** Async counterpart of {@link withFileLockSync}. Always releases, including when `fn` throws/rejects. */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T> | T,
	options?: AtomicFileLockOptions,
): Promise<T> {
	await ensureLockDir(filePath);
	const release = await lockfile.lock(filePath, {
		realpath: options?.realpath ?? DEFAULT_REALPATH,
		retries: {
			retries: options?.retries ?? DEFAULT_RETRIES,
			minTimeout: RETRY_MIN_TIMEOUT_MS,
			maxTimeout: RETRY_MAX_TIMEOUT_MS,
		},
		stale: options?.stale,
	});
	try {
		return await fn();
	} finally {
		// See {@link withFileLockSync} — cleanup failures must not mask fn()'s outcome.
		await release().catch(() => {});
	}
}

/**
 * Write `content` to `filePath` via write-tmp-then-rename (sync); the rename is atomic on the same
 * filesystem, so a concurrent reader never observes a partially-written file. Does NOT itself lock —
 * call from inside {@link withFileLockSync} when the write follows a read that must not race another
 * writer's read+write; call standalone for an unconditional overwrite with no read step.
 */
export function writeFileAtomicSync(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	writeFileSync(tmpPath, content, "utf-8");
	renameSync(tmpPath, filePath);
}

/** Async counterpart of {@link writeFileAtomicSync}. */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	await fsPromises.mkdir(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	await fsPromises.writeFile(tmpPath, content, "utf-8");
	await fsPromises.rename(tmpPath, filePath);
}
