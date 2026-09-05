import type { AgentTool } from "@caupulican/pi-agent-core";
import { MAX_CODEX_EDIT_IMAGES, MAX_CODEX_IMAGE_PROMPT_BYTES } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { defineTool } from "../extensions/types.ts";
import {
	ImageGenerationController,
	type ImageGenerationDetails,
	type ImageGenerationOptions,
} from "../image-generation.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const schema = Type.Object(
	{
		prompt: Type.String({
			minLength: 1,
			maxLength: MAX_CODEX_IMAGE_PROMPT_BYTES,
			description: "Detailed generation or editing instructions.",
		}),
		referenced_image_paths: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: MAX_CODEX_EDIT_IMAGES }),
		),
		num_last_images_to_include: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CODEX_EDIT_IMAGES })),
	},
	{ additionalProperties: false },
);

export function createImageGenerateToolDefinition(cwd: string, options: ImageGenerationOptions) {
	const controller = new ImageGenerationController(cwd, options);
	return defineTool({
		name: "image_generate",
		label: "image_generate",
		description:
			"Generate or edit one image using ChatGPT subscription image generation. Only available with openai-codex OAuth; consumes subscription limits, never API-key credits. For edits supply 1–5 local referenced_image_paths OR num_last_images_to_include (1–5), never both. Use local paths when known; recent-image selection is best-effort conversation order. Saves the original image and returns a bounded inline result. May take several minutes. Backend entitlement, limits, cancellation, or ambiguous failure must not trigger automatic regeneration.",
		promptSnippet:
			"Generate/edit an image with ChatGPT subscription; saved original, bounded display; no API-key fallback.",
		parameters: schema,
		async execute(callId, input, signal) {
			return controller.generate(callId, input, signal);
		},
	});
}

export function createImageGenerateTool(
	cwd: string,
	options: ImageGenerationOptions,
): AgentTool<typeof schema, ImageGenerationDetails> {
	return wrapToolDefinition(createImageGenerateToolDefinition(cwd, options));
}
