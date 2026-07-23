/** Cross-process identity carried by managed child sessions. */

export const PI_PARENT_PID_ENV = "PI_PARENT_PID";
export const PI_PARENT_SESSION_ENV = "PI_PARENT_SESSION";

/** A malformed or non-positive parent pid is ignored. */
export function getParentPid(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env[PI_PARENT_PID_ENV];
	if (raw === undefined) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function getParentSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[PI_PARENT_SESSION_ENV]?.trim();
	return value && value.length > 0 ? value : undefined;
}
