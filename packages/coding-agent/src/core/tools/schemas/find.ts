import { type Static, Type } from "typebox";
import type { TruncationResult } from "../../../kernel/utils/truncate.ts";

export const findSchema = Type.Object({
	pattern: Type.String({
		description:
			"Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'. Use '.' to match all files.",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive matching (default: false)" })),
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
