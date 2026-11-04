import { type Static, Type } from "typebox";
import type { OpenEditFileInspection } from "../file-mutation-intent.ts";

export const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({ minLength: 1, description: "Exact, unique, minimal text from the original file." }),
		newText: Type.String(),
		range: Type.Optional(
			Type.Object(
				{
					startLine: Type.Integer({ minimum: 1 }),
					endLine: Type.Integer({ minimum: 1 }),
				},
				{ additionalProperties: false, description: "Inclusive lines of oldText as read showed them, when known." },
			),
		),
	},
	{ additionalProperties: false },
);

export const editPathSchema = Type.String({ minLength: 1 });

export const editEncodingSchema = Type.Optional(
	Type.String({
		minLength: 1,
		maxLength: 80,
		description:
			"Source codec override (e.g. cp1252); the harness detects it, so pass only when that detection is wrong.",
	}),
);

export const editSchema = Type.Union([
	Type.Object(
		{
			path: editPathSchema,
			encoding: editEncodingSchema,
			edits: Type.Array(replaceEditSchema, {
				minItems: 1,
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			path: editPathSchema,
			encoding: editEncodingSchema,
			payloadRef: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
	phase: "edited";
	encodingRecovery?: { codec: "python"; encoding: string; verified: true; source: string };
	contentRef?: string;
	/** Display-oriented diff of the changes made */
	diff?: string;
	/** Standard unified patch of the changes made */
	patch?: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** True when execution reused the match plan already validated for the call preview. */
	matchPlanReused?: boolean;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents for non-mutating previews. */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Open one stable resource for the execution read, write, and identity checks. */
	openFile: (absolutePath: string) => Promise<OpenEditFile>;
}

export interface OpenEditFile {
	readFile: () => Promise<Buffer>;
	writeFile: (content: string | Buffer) => Promise<void>;
	inspect: () => Promise<OpenEditFileInspection>;
	close: () => Promise<void>;
}
