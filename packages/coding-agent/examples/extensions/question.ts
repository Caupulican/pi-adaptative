/**
 * Single-question compatibility example.
 *
 * The interaction itself is native and shared with ask_question; this extension only adapts the
 * older one-question parameter shape so example code cannot drift into a second UI implementation.
 */

import { createAskQuestionToolDefinition, type ExtensionAPI } from "@caupulican/pi-adaptative";
import { Type } from "typebox";

const optionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Description shown below the label" })),
});

const paramsSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(optionSchema, { description: "Options for the user to choose from" }),
});

export default function question(pi: ExtensionAPI) {
	const native = createAskQuestionToolDefinition({ name: "question", label: "Question" });
	pi.registerTool({
		name: native.name,
		label: native.label,
		description: native.description,
		promptSnippet: native.promptSnippet,
		promptGuidelines: native.promptGuidelines,
		executionMode: native.executionMode,
		parameters: paramsSchema,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			return native.execute(
				toolCallId,
				{
					questions: [
						{
							id: "question",
							header: "Question",
							question: params.question,
							options: params.options.map((option) => ({
								label: option.label,
								description: option.description ?? `Choose ${option.label}.`,
							})),
						},
					],
				},
				signal,
				undefined,
				ctx,
			);
		},
	});
}
