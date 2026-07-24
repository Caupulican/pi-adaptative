/**
 * Multi-question compatibility example.
 *
 * The interaction itself is native and shared with ask_question; this extension only adapts the
 * older questionnaire parameter shape so task navigation, review, and accessibility have one owner.
 */

import { createAskQuestionToolDefinition, type ExtensionAPI } from "@caupulican/pi-adaptative";
import { Type } from "typebox";

const optionSchema = Type.Object({
	value: Type.String({ description: "Legacy value retained in the request shape" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Description shown below the label" })),
});

const questionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(Type.String({ description: "Short navigation label" })),
	prompt: Type.String({ description: "The full question text" }),
	options: Type.Array(optionSchema, { description: "Options for the user to choose from" }),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Legacy field; the native interaction always supplies Other and Skip" }),
	),
});

const paramsSchema = Type.Object({
	questions: Type.Array(questionSchema, { description: "Questions to ask the user" }),
});

export default function questionnaire(pi: ExtensionAPI) {
	const native = createAskQuestionToolDefinition({ name: "questionnaire", label: "Questionnaire" });
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
					questions: params.questions.map((question, index) => ({
						id: question.id,
						header: question.label ?? `Q${index + 1}`,
						question: question.prompt,
						options: question.options.map((option) => ({
							label: option.label,
							description: option.description ?? `Choose ${option.label}.`,
						})),
					})),
				},
				signal,
				undefined,
				ctx,
			);
		},
	});
}
