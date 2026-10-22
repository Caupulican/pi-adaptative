/** Maximum entries visited by a single bounded session traversal. */
export const MAX_SESSION_ENTRY_VISIT_COUNT = 1_024;

/** A session line must fit below the JavaScript string limit, including large image payloads. */
export const MAX_SESSION_LINE_CHARS = 256 * 1024 * 1024;
