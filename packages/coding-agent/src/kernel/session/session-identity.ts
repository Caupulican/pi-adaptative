export const MAX_SESSION_HEADER_BYTES = 64 * 1024;

/**
 * The one session id rule: a single alphanumeric token, with '-', '_' and '.' allowed inside it. Every id the kernel
 * mints (UUID v4 before uuidv7, UUID v7 now) and every explicit id it has accepted since explicit ids existed satisfies it.
 */
export function isValidSessionId(id: string): boolean {
	return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id);
}

/**
 * A session identity as the records that hold one read it: an id the rule above admits, within the header bytes a session
 * file's id is read from. A value that fails is refused where it is read; it is never truncated or rehashed to fit.
 */
export function isSessionIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_SESSION_HEADER_BYTES && isValidSessionId(value);
}

export function assertValidSessionId(id: string): void {
	if (!isValidSessionId(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}
