import { type Static, Type } from "typebox";
import type { TruncationResult } from "../../../kernel/utils/truncate.ts";

export const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
	metadata: Type.Optional(Type.Boolean({ description: "Include file size and permission metadata (default: false)" })),
});

export type LsToolInput = Static<typeof lsSchema>;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsEntryStats {
	isDirectory: () => boolean;
	size?: number;
	mode?: number;
}

export interface LsOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Get file or directory stats. Throws if not found. */
	stat: (absolutePath: string) => Promise<LsEntryStats> | LsEntryStats;
	/** Read directory entries */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}
