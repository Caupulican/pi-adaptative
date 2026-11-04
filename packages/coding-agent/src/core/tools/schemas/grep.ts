import { type Static, Type } from "typebox";
import type { TruncationResult } from "../../../kernel/utils/truncate.ts";

export const grepSchema = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String({ description: "Directory or file (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "File glob filter, e.g. '*.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean()),
	literal: Type.Optional(Type.Boolean({ description: "Match pattern literally, not as a regex" })),
	context: Type.Optional(Type.Number({ description: "Lines before and after each match" })),
	limit: Type.Optional(Type.Number()),
});

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	/** Set only when output was packed to an artifact; see tool-output-packer.ts. */
	artifactId?: string;
	/** Set when this exact query has repeatedly produced broad/truncated results. */
	invalidationCandidate?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}
