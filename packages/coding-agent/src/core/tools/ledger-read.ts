import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	findLedgerEntry,
	formatLedgerEntry,
	LEDGER_READ_TOOL_NAME,
	loadLedgerCatalog,
} from "../ledger/ledger-catalog.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export { LEDGER_READ_TOOL_NAME };

const ledgerReadSchema = Type.Object(
	{ topic: Type.String({ description: "Topic from the prompt index, without the @hash." }) },
	{ additionalProperties: false },
);

/**
 * Returns one ledger rule whole, with its content-derived id. There is deliberately no range or limit
 * parameter: a rule cannot be read in parts, so a returned id proves the complete rule reached the model.
 */
export function createLedgerReadToolDefinition(): ToolDefinition<typeof ledgerReadSchema> {
	return {
		name: LEDGER_READ_TOOL_NAME,
		label: "Ledger",
		readOnly: true,
		description:
			"Read one standing rule from the system prompt's ledger index. Always returns the whole rule and its LEDGER-ID.",
		promptSnippet: "Read a whole ledger rule by topic.",
		parameters: ledgerReadSchema,
		async execute(_toolCallId, input) {
			const topic = input.topic.trim().replace(/@[0-9a-f]{8}$/, "");
			const entry = findLedgerEntry(topic);
			if (!entry) {
				const topics = loadLedgerCatalog().map((candidate) => candidate.topic);
				return {
					content: [
						{ type: "text" as const, text: `ledger topic not found: ${topic}. Topics: ${topics.join(", ")}` },
					],
					details: { topic, found: false },
					isError: true,
				};
			}
			return {
				content: [{ type: "text" as const, text: formatLedgerEntry(entry) }],
				details: { topic: entry.topic, id: entry.id, chars: entry.body.length, found: true },
			};
		},
	};
}

export function createLedgerReadTool() {
	return wrapToolDefinition(createLedgerReadToolDefinition());
}
