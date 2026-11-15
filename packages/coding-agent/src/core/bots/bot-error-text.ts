/** A failure's own text, as the bots' notices and logs quote it beside the owner's words. */

/** What failed, in its own words: each cause of a failure that gathers several. */
export function errorText(error: unknown): string {
	if (error instanceof AggregateError)
		return [error.message, ...error.errors.map(errorText)].filter(Boolean).join("; ");
	return error instanceof Error ? error.message : String(error);
}
