import { type Static, Type } from "typebox";
import type { TruncationResult } from "../../../kernel/utils/truncate.ts";
import type { ReadLineWindowDetails } from "../read-line-window.ts";

export const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	encoding: Type.Optional(
		Type.String({
			description:
				"Override for the source encoding. The harness resolves it on its own (project declarations, BOM, UTF-8, then a managed Python codec that detects legacy and BOM-less text), so pass this only when you know the file's codec and that resolution is wrong.",
		}),
	),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	column: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Read a character window of one line, starting at this 1-based UTF-16 position. Use the returned nextColumn to continue; surrogate pairs stay intact. Use with offset, not tail, outline, or multiple-line limits.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	lineNumbers: Type.Optional(Type.Boolean({ description: "Include line numbers in the output" })),
	tail: Type.Optional(Type.Number({ description: "Number of lines to read from the end of the file" })),
	mode: Type.Optional(
		Type.Literal("outline", {
			description:
				"Return the file's outline instead of its text: one `line: declaration` row per function, class, type, method, heading (TypeScript/JavaScript, Python, Rust, Go, C#, PowerShell, shell, Markdown). Use it first on files over ~300 lines, then read the range you need with offset/limit.",
		}),
	),
	filter: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("minimal"), Type.Literal("aggressive")], {
			description: "Safe text filtering level (none, minimal, aggressive)",
		}),
	),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	lineWindow?: ReadLineWindowDetails;
	truncation?: TruncationResult;
	/** Present for `mode: "outline"`. */
	outline?: { language: string; entries: number; totalLines: number; headFallback: boolean };
	/** Present when the path was a directory and a bounded listing was returned instead of bytes. */
	directory?: { entries: number; shown: number };
	/** Present when the charset came from metadata, settings, or codec detection instead of the call. */
	encoding?: { name: string; source: string };
}
