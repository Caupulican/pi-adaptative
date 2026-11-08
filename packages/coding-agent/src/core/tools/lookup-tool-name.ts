/** The read-only batch lookup tool: several independent reads, listings, git reads and searches in one call. */
export const LOOKUP_TOOL_NAME = "lookup";

/**
 * The tools a lookup request runs through, one per request kind. A request kind is available only where
 * its tool is: the session's registry (or a lane's materialized surface) decides, never this list.
 */
export const LOOKUP_SUB_TOOL_NAMES = ["read", "repo_read", "grep"] as const;
export type LookupSubToolName = (typeof LOOKUP_SUB_TOOL_NAMES)[number];
