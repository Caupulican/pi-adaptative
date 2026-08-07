/**
 * Native Windows performs the same loaded-suite work with four workers, but filesystem-heavy
 * fixtures can exceed Vitest's 30-second default under full release-gate contention.
 */
export function windowsLoadedSuiteTimeout(existingTimeout?: number): number | undefined {
	return process.platform === "win32" ? 90_000 : existingTimeout;
}
