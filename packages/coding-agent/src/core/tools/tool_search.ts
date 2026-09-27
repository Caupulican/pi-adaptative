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
		description:
			'Keywords describing the capability, or "select:name1,name2" to load exact deferred tools in one call.',
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
			"Find deferred tool schemas by capability keywords before calling them. Use select:name1,name2 when exact names are already known; batch every likely tool into one search to avoid extra round trips. Search changes no state and returns only tools already granted in this request.",
		promptSnippet: "Load deferred tool schemas by keyword or exact batched names before calling them",
		parameters: toolSchemaSearchSchema,
		async execute(_toolCallId, { query, maxResults = 5 }: ToolSchemaSearchInput) {
			return {
				content: [{ type: "text", text: `Searching deferred tools for ${JSON.stringify(query)}.` }],
				details: { kind: TOOL_SCHEMA_SEARCH_DETAILS_KIND, query, maxResults },
			};
		},
	};
}
