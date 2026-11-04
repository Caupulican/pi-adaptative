import { type Static, Type } from "typebox";
import type { TruncationResult } from "../../../kernel/utils/truncate.ts";

export const findSchema = Type.Object({
	pattern: Type.String({ description: "Glob, e.g. '**/*.json' or 'src/**/*.spec.ts'; '.' matches all files." }),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	limit: Type.Optional(Type.Number()),
	ignoreCase: Type.Optional(Type.Boolean()),
});

export type FindToolInput = Static<typeof findSchema>;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	/** Set only when output was packed to an artifact; see tool-output-packer.ts. */
	artifactId?: string;
	/** Set when this exact query has repeatedly produced broad/truncated results. */
	invalidationCandidate?: boolean;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}
