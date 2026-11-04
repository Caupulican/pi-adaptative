import {
	TOOL_SCHEMA_SEARCH_DETAILS_KIND,
	TOOL_SCHEMA_SEARCH_NAME,
	type ToolSchemaSearchDetails,
} from "@caupulican/pi-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const toolSchemaSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: 500,
		description: 'Capability keywords, or "select:name1,name2" for exact names.',
	}),
	maxResults: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 10, description: "Maximum schemas to load (default 5)." }),
	),
});

export type ToolSchemaSearchInput = Static<typeof toolSchemaSearchSchema>;

export function createToolSchemaSearchDefinition(): ToolDefinition<
	typeof toolSchemaSearchSchema,
	ToolSchemaSearchDetails
> {
	return {
		name: TOOL_SCHEMA_SEARCH_NAME,
		label: "Tool schema search",
		readOnly: true,
		description:
			"Load the schemas of deferred tools before calling them, by capability keywords or select:name1,name2 for known names. Batch every likely tool into one search. Read-only: returns only tools already granted in this request.",
		promptSnippet: "Load deferred tool schemas by keyword or exact name",
		parameters: toolSchemaSearchSchema,
		async execute(_toolCallId, { query, maxResults = 5 }: ToolSchemaSearchInput) {
			return {
				content: [{ type: "text", text: `Searching deferred tools for ${JSON.stringify(query)}.` }],
				details: { kind: TOOL_SCHEMA_SEARCH_DETAILS_KIND, query, maxResults },
			};
		},
	};
}
