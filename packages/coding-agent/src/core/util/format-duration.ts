/** A compact duration for operator surfaces: tenths under ten seconds, seconds under a minute, then m:ss. */
export function formatCompactDuration(ms: number): string {
	if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
