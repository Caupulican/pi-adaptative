import { type Static, Type } from "typebox";

export const writePathSchema = Type.String({ minLength: 1 });

export const writeSchema = Type.Union([
	Type.Object(
		{
			path: writePathSchema,
			content: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			path: writePathSchema,
			contentRef: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			path: writePathSchema,
			payloadRef: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Atomically create a new file and fail if any entry already occupies the path. */
	createFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

export interface WriteToolDetails {
	phase: "written";
	contentRef?: string;
	byteCount?: number;
}
