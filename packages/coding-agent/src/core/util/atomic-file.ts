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

import { randomUUID } from "node:crypto";
import { promises as fsPromises, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { type FaultableFs, nodeFs } from "./faultable-fs.ts";

/**
 * Bounded rename retry budget for the win32-only transient-rename handling below (see
 * {@link isTransientRenameErrorOnWin32}). Backoff doubles each attempt starting at
 * {@link RENAME_RETRY_MIN_TIMEOUT_MS} and capped at {@link RENAME_RETRY_MAX_TIMEOUT_MS}, mirroring
 * the doubling-backoff shape used for lock acquisition above. With {@link RENAME_RETRY_ATTEMPTS}
 * extra attempts (10, 20, 40, 80, ... capped at 200) the worst-case total wait is ~1.03s
 * (10+20+40+80+160+200+200+200+200 ~= 1110ms across 9 gaps), which comfortably covers the
 * millisecond-scale window Defender/the Windows Search indexer hold a freshly-written file open
 * without FILE_SHARE_DELETE before releasing it.
 */
const RENAME_RETRY_ATTEMPTS = 9;
const RENAME_RETRY_MIN_TIMEOUT_MS = 10;
const RENAME_RETRY_MAX_TIMEOUT_MS = 200;

/**
 * On win32, antivirus (e.g. Windows Defender's real-time scanner) and the Windows Search indexer
 * routinely open a freshly-written file for a brief scan without `FILE_SHARE_DELETE`, which makes a
 * rename over/of that file fail transiently with EPERM/EACCES/EBUSY for a few milliseconds. This is
 * a well-documented platform semantic, not a bug in our write path — it's exactly why the
 * `graceful-fs` package ships its own win32 rename-retry wrapper. POSIX platforms never exhibit this
 * transient (a POSIX rename either succeeds or fails for a real, non-transient reason), so retry is
 * gated strictly to win32 to keep POSIX behavior byte-identical to a bare rename.
 */
function isTransientRenameErrorOnWin32(err: unknown): boolean {
	if (process.platform !== "win32") return false;
	if (typeof err !== "object" || err === null) return false;
	const code = (err as { code?: string }).code;
	return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** Sync counterpart of the rename-retry policy; see {@link isTransientRenameErrorOnWin32}. */
function renameSyncWithRetry(tmpPath: string, filePath: string, fs: FaultableFs): void {
	for (let attempt = 0; attempt <= RENAME_RETRY_ATTEMPTS; attempt++) {
		try {
			fs.renameSync(tmpPath, filePath);
			return;
		} catch (err) {
			if (!isTransientRenameErrorOnWin32(err) || attempt === RENAME_RETRY_ATTEMPTS) throw err;
			const backoffMs = Math.min(RENAME_RETRY_MIN_TIMEOUT_MS * 2 ** attempt, RENAME_RETRY_MAX_TIMEOUT_MS);
			blockingSleepMs(backoffMs);
		}
	}
}

/** Async counterpart of the rename-retry policy; see {@link isTransientRenameErrorOnWin32}. */
async function renameWithRetry(tmpPath: string, filePath: string): Promise<void> {
	for (let attempt = 0; attempt <= RENAME_RETRY_ATTEMPTS; attempt++) {
		try {
			await fsPromises.rename(tmpPath, filePath);
			return;
		} catch (err) {
			if (!isTransientRenameErrorOnWin32(err) || attempt === RENAME_RETRY_ATTEMPTS) throw err;
			const backoffMs = Math.min(RENAME_RETRY_MIN_TIMEOUT_MS * 2 ** attempt, RENAME_RETRY_MAX_TIMEOUT_MS);
			await new Promise((resolve) => setTimeout(resolve, backoffMs));
		}
	}
}

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
	/** Initial delay between sync/async acquisition attempts; defaults to 25ms. */
	minRetryDelayMs?: number;
	/** Maximum delay between sync/async acquisition attempts; defaults to 500ms. */
	maxRetryDelayMs?: number;
	/** Retry-delay multiplier; defaults to 2. Set max=min for a fixed delay. */
	retryFactor?: number;
	/** Resolve symlinks before locking (proper-lockfile `realpath`); false matches file-store.ts. */
	realpath?: boolean;
	/** Lock staleness window in ms (proper-lockfile `stale`); omitted = proper-lockfile's own default. */
	stale?: number;
	/** Explicit proper-lockfile directory path; defaults to `${filePath}.lock`. */
	lockfilePath?: string;
}

export interface AtomicFileWriteOptions {
	/** POSIX permission bits applied to the temporary file and inherited by the renamed destination. */
	mode?: number;
	/**
	 * Injection seam for the mutating fs primitives this write issues (`mkdirSync`, `writeFileSync`,
	 * `renameSync`). Defaults to real `node:fs` — omitting this option is a zero-behavior-change no-op.
	 * Only the destructive-testing harness passes a fault-injecting implementation.
	 */
	fs?: FaultableFs;
}

const DEFAULT_RETRIES = 10;
const DEFAULT_REALPATH = false;
/**
 * Capped doubling backoff shared by both variants — see {@link AtomicFileLockOptions.retries}.
 * With the current defaults (10 retries, 25ms floor, 500ms cap) the total worst-case contention
 * budget is ~3.3s (25+50+100+200+400+500+500+500+500+500), comfortably over the >= 2s floor this
 * needs to survive a loaded CI runner (e.g. the Windows CI mkdir/rmdir lock-directory churn under
 * two-real-OS-thread contention).
 */
const RETRY_MIN_TIMEOUT_MS = 25;
const RETRY_MAX_TIMEOUT_MS = 500;

/**
 * Existing auth/settings/trust paths historically used 10 total attempts separated by 20ms. Keep
 * that low-latency user-facing policy explicit while routing the mechanism through this module.
 */
export const LOW_LATENCY_FILE_LOCK_OPTIONS: Readonly<AtomicFileLockOptions> = Object.freeze({
	retries: 9,
	minRetryDelayMs: 20,
	maxRetryDelayMs: 20,
});

function lockDirectory(filePath: string, lockfilePath?: string): string {
	return dirname(lockfilePath ?? filePath);
}

function ensureLockDirSync(filePath: string, lockfilePath?: string): void {
	mkdirSync(lockDirectory(filePath, lockfilePath), { recursive: true });
}

async function ensureLockDir(filePath: string, lockfilePath?: string): Promise<void> {
	await fsPromises.mkdir(lockDirectory(filePath, lockfilePath), { recursive: true });
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

type PendingPathOperations = Map<string, Promise<void>>;

const pendingAsyncFileLockTails: PendingPathOperations = new Map();
const pendingAtomicWriteTails: PendingPathOperations = new Map();

function pathOperationKey(filePath: string): string {
	const absolutePath = resolve(filePath);
	return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
}

/**
 * Queue only operations that target the same platform path. This prevents same-process callers
 * from entering synchronized OS retry storms without imposing a process-wide or cross-tenant
 * bottleneck. The tail always resolves and self-removes, including after a failed operation.
 */
async function withSerializedPathOperation<T>(
	tails: PendingPathOperations,
	filePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const key = pathOperationKey(filePath);
	const preceding = tails.get(key) ?? Promise.resolve();
	let releaseTail: (() => void) | undefined;
	const tail = new Promise<void>((resolveTail) => {
		releaseTail = resolveTail;
	});
	tails.set(key, tail);

	await preceding;
	try {
		return await fn();
	} finally {
		releaseTail?.();
		if (tails.get(key) === tail) tails.delete(key);
	}
}

/**
 * Acquire a proper-lockfile sync lock with bounded retry on `ELOCKED` (proper-lockfile's sync API
 * itself forbids `retries > 0`; see {@link AtomicFileLockOptions.retries}).
 *
 * Backoff doubles each attempt (mirroring the `retry` module's own `factor: 2` default that the
 * async path gets for free from proper-lockfile), starting at {@link RETRY_MIN_TIMEOUT_MS} and
 * capped at {@link RETRY_MAX_TIMEOUT_MS}.
 *
 * This is budget PARITY between two implementations of the same lock-acquisition contract, not
 * flake-masking: `options.retries` (a count of RETRIES, i.e. attempts after the first) means the
 * same thing on both paths, so both must make `retries + 1` total acquisition attempts with the
 * same per-gap backoff schedule. The async path gets `retries + 1` attempts for free from the
 * `retry` module (it retries `options.retries` times after its initial attempt); the sync path
 * used to loop exactly `attempts` times total (one fewer gap, and one fewer attempt than the
 * async path for the same `retries` value), which under-budgeted it relative to its async sibling
 * and surfaced as spurious ELOCKED failures under real contention (e.g. two OS threads hammering
 * the same file, or mkdir/rmdir lock-directory churn on a loaded Windows CI runner).
 */
function retryCount(options: AtomicFileLockOptions): number {
	const configured = options.retries ?? DEFAULT_RETRIES;
	return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_RETRIES;
}

function retryDelayMs(options: AtomicFileLockOptions, attempt: number): number {
	const configuredMin = options.minRetryDelayMs ?? RETRY_MIN_TIMEOUT_MS;
	const minDelay = Number.isFinite(configuredMin) ? Math.max(0, configuredMin) : RETRY_MIN_TIMEOUT_MS;
	const configuredMax = options.maxRetryDelayMs ?? RETRY_MAX_TIMEOUT_MS;
	const maxDelay = Number.isFinite(configuredMax) ? Math.max(minDelay, configuredMax) : RETRY_MAX_TIMEOUT_MS;
	const configuredFactor = options.retryFactor ?? 2;
	const factor = Number.isFinite(configuredFactor) ? Math.max(1, configuredFactor) : 2;
	return Math.min(minDelay * factor ** (attempt - 1), maxDelay);
}

/**
 * Acquire a synchronous advisory file lock and return its release function. This is the shared
 * mechanism for coordinators that must hold several locks in a deterministic order before entering
 * one critical section; callers retain ownership of release ordering and release-error semantics.
 */
export function acquireFileLockSync(filePath: string, options: AtomicFileLockOptions = {}): () => void {
	ensureLockDirSync(filePath, options.lockfilePath);
	const attempts = retryCount(options) + 1;
	const lockOptions = {
		lockfilePath: options.lockfilePath,
		realpath: options.realpath ?? DEFAULT_REALPATH,
		stale: options.stale,
	};
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return lockfile.lockSync(filePath, lockOptions);
		} catch (err) {
			if (!isLockedError(err) || attempt === attempts) throw err;
			blockingSleepMs(retryDelayMs(options, attempt));
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
	const release = acquireFileLockSync(filePath, options);
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
	return withSerializedPathOperation(pendingAsyncFileLockTails, options?.lockfilePath ?? filePath, async () => {
		await ensureLockDir(filePath, options?.lockfilePath);
		const release = await lockfile.lock(filePath, {
			lockfilePath: options?.lockfilePath,
			realpath: options?.realpath ?? DEFAULT_REALPATH,
			retries: {
				retries: retryCount(options ?? {}),
				factor: options?.retryFactor ?? 2,
				minTimeout: options?.minRetryDelayMs ?? RETRY_MIN_TIMEOUT_MS,
				maxTimeout: options?.maxRetryDelayMs ?? RETRY_MAX_TIMEOUT_MS,
			},
			stale: options?.stale,
		});
		try {
			return await fn();
		} finally {
			// See {@link withFileLockSync} — cleanup failures must not mask fn()'s outcome.
			await release().catch(() => {});
		}
	});
}

/**
 * Write `content` to `filePath` via write-tmp-then-rename (sync); the rename is atomic on the same
 * filesystem, so a concurrent reader never observes a partially-written file. Does NOT itself lock —
 * call from inside {@link withFileLockSync} when the write follows a read that must not race another
 * writer's read+write; call standalone for an unconditional overwrite with no read step.
 */
function temporaryPath(filePath: string): string {
	return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

/**
 * Async standalone overwrites can legitimately target the same file at once. Unique temporary
 * names prevent writers from corrupting each other's staging files, but Windows still serializes
 * replacement renames internally. Letting every writer retry in lockstep creates a thundering herd
 * that can exhaust the bounded Defender/indexer retry budget even though no external process owns
 * the destination. Keep one FIFO tail per destination inside this process so each destination has
 * one writer at a time; writes to different destinations remain fully parallel. The tail is always
 * resolved and removed, including after a failed write, so one failure cannot poison later writes
 * or retain tenant paths indefinitely. File-lock queues are separate from atomic-write queues so a
 * write inside a held advisory lock never waits on itself.
 */
async function withSerializedAtomicWrite<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	return withSerializedPathOperation(pendingAtomicWriteTails, filePath, fn);
}

/** Remove one invocation's temporary path without masking the original write/rename failure. */
function removeTemporaryPathSync(tmpPath: string): void {
	try {
		unlinkSync(tmpPath);
	} catch {
		// The rename may have consumed the path, or another failure may have prevented its creation.
	}
}

async function removeTemporaryPath(tmpPath: string): Promise<void> {
	try {
		await fsPromises.unlink(tmpPath);
	} catch {
		// The rename may have consumed the path, or another failure may have prevented its creation.
	}
}

export function writeFileAtomicSync(filePath: string, content: string, options?: AtomicFileWriteOptions): void {
	const fs = options?.fs ?? nodeFs;
	fs.mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = temporaryPath(filePath);
	let renamed = false;
	try {
		// `wx` makes a nonce collision harmless: never truncate another writer's temporary file.
		fs.writeFileSync(tmpPath, content, { encoding: "utf-8", flag: "wx", mode: options?.mode });
		renameSyncWithRetry(tmpPath, filePath, fs);
		renamed = true;
	} finally {
		if (!renamed) removeTemporaryPathSync(tmpPath);
	}
}

/** Async counterpart of {@link writeFileAtomicSync}. */
export async function writeFileAtomic(
	filePath: string,
	content: string,
	options?: AtomicFileWriteOptions,
): Promise<void> {
	await withSerializedAtomicWrite(filePath, async () => {
		await fsPromises.mkdir(dirname(filePath), { recursive: true });
		const tmpPath = temporaryPath(filePath);
		let renamed = false;
		try {
			// `wx` makes a nonce collision harmless: never truncate another writer's temporary file.
			await fsPromises.writeFile(tmpPath, content, { encoding: "utf-8", flag: "wx", mode: options?.mode });
			await renameWithRetry(tmpPath, filePath);
			renamed = true;
		} finally {
			if (!renamed) await removeTemporaryPath(tmpPath);
		}
	});
}
