import { type Static, Type } from "typebox";
import type { TruncationResult } from "../../../kernel/utils/truncate.ts";
import type { ReadLineWindowDetails } from "../read-line-window.ts";

export const readSchema = Type.Object({
	path: Type.String(),
	encoding: Type.Optional(
		Type.String({
			description: "Source codec override; the harness detects it, so pass only when that detection is wrong.",
		}),
	),
	offset: Type.Optional(Type.Number({ description: "1-indexed start line" })),
	column: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Read a character window of one line from this 1-based UTF-16 position (with offset).",
		}),
	),
	limit: Type.Optional(Type.Number()),
	lineNumbers: Type.Optional(Type.Boolean()),
	tail: Type.Optional(Type.Number({ description: "Lines to read from the end" })),
	mode: Type.Optional(
		Type.Literal("outline", {
			description:
				"Return `line: declaration` rows (functions, classes, types, methods, headings) instead of text; supports TypeScript/JavaScript, Python, Rust, Go, C#, PowerShell, shell, Markdown.",
		}),
	),
	filter: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("minimal"), Type.Literal("aggressive")], {
			description: "Safe text filtering level",
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
