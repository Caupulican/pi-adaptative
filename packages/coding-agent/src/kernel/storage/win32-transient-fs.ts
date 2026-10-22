import { SYSTEM_TIMER_PORT, type TimerPort } from "../timer-port.ts";

/**
 * Windows Defender and the Search indexer open a freshly written file without FILE_SHARE_DELETE.
 * Rename and directory removal then fail EPERM/EACCES/EBUSY for a few milliseconds. POSIX never
 * does this, so the retry stays on win32.
 */
export const WIN32_TRANSIENT_RETRY_ATTEMPTS = 9;
export const WIN32_TRANSIENT_RETRY_MIN_MS = 10;
export const WIN32_TRANSIENT_RETRY_MAX_MS = 200;

/**
 * The error codes a share-mode collision raises (EPERM/EACCES/EBUSY), on any platform. Production gates it to win32
 * through {@link isTransientWin32FsError}; a host that raises these codes itself on another platform passes this
 * classifier as `isTransientError` to reach the same retry ladder.
 */
export function isTransientFsShareError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const code = (err as { code?: string }).code;
	return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

export function isTransientWin32FsError(err: unknown): boolean {
	return process.platform === "win32" && isTransientFsShareError(err);
}

function sleepMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface Win32TransientRetryOptions {
	/** Runs before every attempt, including after a backoff wait; a throw ends the retry with that error. */
	readonly beforeAttempt?: () => void;
	/**
	 * The clock the backoff waits on. Defaults to {@link SYSTEM_TIMER_PORT}; each wait keeps the process alive, because
	 * the caller's own result is behind it. A host that drives time itself passes its own port.
	 */
	readonly timers?: TimerPort;
	/**
	 * Which failures the next attempt may clear. Defaults to {@link isTransientWin32FsError}, so POSIX keeps a bare
	 * single attempt; any other failure ends the retry with that error.
	 */
	readonly isTransientError?: (err: unknown) => boolean;
}

export async function retryTransientWin32(
	operation: () => void | Promise<void>,
	options: Win32TransientRetryOptions = {},
): Promise<void> {
	const timers = options.timers ?? SYSTEM_TIMER_PORT;
	const isTransient = options.isTransientError ?? isTransientWin32FsError;
	for (let attempt = 0; attempt <= WIN32_TRANSIENT_RETRY_ATTEMPTS; attempt++) {
		options.beforeAttempt?.();
		try {
			await operation();
			return;
		} catch (err) {
			if (!isTransient(err) || attempt === WIN32_TRANSIENT_RETRY_ATTEMPTS) throw err;
			const backoffMs = Math.min(WIN32_TRANSIENT_RETRY_MIN_MS * 2 ** attempt, WIN32_TRANSIENT_RETRY_MAX_MS);
			await new Promise<void>((resolve) => {
				timers.setTimeout(resolve, backoffMs, { keepAlive: true });
			});
		}
	}
}

export function retryTransientWin32Sync(
	operation: () => void,
	beforeAttempt?: () => void,
	bounds?: { attempts?: number; maxMs?: number },
): void {
	const attempts = bounds?.attempts ?? WIN32_TRANSIENT_RETRY_ATTEMPTS;
	const maxMs = bounds?.maxMs ?? WIN32_TRANSIENT_RETRY_MAX_MS;
	for (let attempt = 0; attempt <= attempts; attempt++) {
		beforeAttempt?.();
		try {
			operation();
			return;
		} catch (err) {
			if (!isTransientWin32FsError(err) || attempt === attempts) throw err;
			const backoffMs = Math.min(WIN32_TRANSIENT_RETRY_MIN_MS * 2 ** attempt, maxMs);
			sleepMs(backoffMs);
		}
	}
}
