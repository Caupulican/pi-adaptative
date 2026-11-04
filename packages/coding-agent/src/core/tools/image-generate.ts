import { MAX_CODEX_EDIT_IMAGES, MAX_CODEX_IMAGE_PROMPT_BYTES } from "@caupulican/pi-ai";
import { Type } from "typebox";
import type { AgentTool } from "../../kernel/index.ts";
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
			description: "Generation or editing instructions.",
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
			"Generate or edit one image with the ChatGPT subscription (openai-codex OAuth only; uses subscription limits, never API-key credits). For edits pass referenced_image_paths or num_last_images_to_include, not both; prefer local paths, since recent-image selection is best-effort. Saves the original and returns a bounded inline result; may take several minutes. Never regenerate automatically after an entitlement, limit, cancellation or ambiguous failure.",
		promptSnippet: "Generate or edit an image",
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
