/** Shared process policy for managed tool installation and offline-mode admission. */

export const MANAGED_TOOL_INSTALL_TIMEOUT_MS = 5 * 60_000;

export function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
