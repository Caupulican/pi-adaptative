/**
 * Windows Defender and the Search indexer open a freshly written file without FILE_SHARE_DELETE.
 * Rename and directory removal then fail EPERM/EACCES/EBUSY for a few milliseconds. POSIX never
 * does this, so the retry stays on win32.
 */
export const WIN32_TRANSIENT_RETRY_ATTEMPTS = 9;
export const WIN32_TRANSIENT_RETRY_MIN_MS = 10;
export const WIN32_TRANSIENT_RETRY_MAX_MS = 200;

export function isTransientWin32FsError(err: unknown): boolean {
	if (process.platform !== "win32") return false;
	if (typeof err !== "object" || err === null) return false;
	const code = (err as { code?: string }).code;
	return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleepMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function retryTransientWin32Sync(operation: () => void, beforeAttempt?: () => void): void {
	for (let attempt = 0; attempt <= WIN32_TRANSIENT_RETRY_ATTEMPTS; attempt++) {
		beforeAttempt?.();
		try {
			operation();
			return;
		} catch (err) {
			if (!isTransientWin32FsError(err) || attempt === WIN32_TRANSIENT_RETRY_ATTEMPTS) throw err;
			const backoffMs = Math.min(WIN32_TRANSIENT_RETRY_MIN_MS * 2 ** attempt, WIN32_TRANSIENT_RETRY_MAX_MS);
			sleepMs(backoffMs);
		}
	}
}
