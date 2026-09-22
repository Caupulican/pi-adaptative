import { rmSync } from "node:fs";

const RETRY_ATTEMPTS = 9;
const RETRY_MIN_MS = 10;
const RETRY_MAX_MS = 200;

function isTransientRemoveError(err: unknown): boolean {
	if (process.platform !== "win32") return false;
	if (typeof err !== "object" || err === null) return false;
	const code = (err as { code?: string }).code;
	return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleepMs(ms: number): void {
	if (ms <= 0) return;
	const sab = new SharedArrayBuffer(4);
	const view = new Int32Array(sab);
	Atomics.wait(view, 0, 0, ms);
}

/**
 * Remove a directory tree. On win32 a freshly written file can stay open for a scan without
 * FILE_SHARE_DELETE, so the first rm fails EPERM/EACCES/EBUSY. The backoff matches an atomic
 * rename. POSIX removes once.
 */
export function removeTreeSync(targetPath: string): void {
	for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
		try {
			rmSync(targetPath, { recursive: true, force: true });
			return;
		} catch (err) {
			if (!isTransientRemoveError(err) || attempt === RETRY_ATTEMPTS) throw err;
			sleepMs(Math.min(RETRY_MIN_MS * 2 ** attempt, RETRY_MAX_MS));
		}
	}
}
