/** The `systemone locate` request: its limits, its shape, and the one place a caller's input is checked. */

export const MAX_LOCATE_TARGET_CHARS = 500;
export const MAX_LOCATE_QUERIES = 8;
export const MAX_LOCATE_QUERY_CHARS = 300;
export const MAX_LOCATE_PATHS = 8;
export const MAX_LOCATE_LIMIT = 10;
export const DEFAULT_LOCATE_LIMIT = 5;

export interface LocateInput {
	readonly target: string;
	readonly queries: readonly string[];
	readonly paths?: readonly string[];
	readonly limit?: number;
}

/** The caller's request was unusable (bad query, path out of scope); nothing was searched or judged. */
export class LocateInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocateInputError";
	}
}

export function normalizeLocateInput(input: LocateInput): { target: string; queries: string[]; limit: number } {
	const target = input.target.trim();
	if (!target) throw new LocateInputError("locate requires a target describing what to find");
	if (target.length > MAX_LOCATE_TARGET_CHARS)
		throw new LocateInputError(
			`locate target is ${target.length} characters; the limit is ${MAX_LOCATE_TARGET_CHARS}`,
		);
	const queries = input.queries.map((query) => query.trim()).filter((query) => query.length > 0);
	if (queries.length === 0 || queries.length > MAX_LOCATE_QUERIES)
		throw new LocateInputError(`locate requires 1 to ${MAX_LOCATE_QUERIES} queries`);
	if (queries.some((query) => query.length > MAX_LOCATE_QUERY_CHARS))
		throw new LocateInputError(`each locate query is limited to ${MAX_LOCATE_QUERY_CHARS} characters`);
	const limit = Math.min(MAX_LOCATE_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_LOCATE_LIMIT)));
	return { target, queries, limit };
}
