/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */

import type {
	Content,
	FinishReason,
	FunctionCallingConfigMode,
	ThinkingLevel as GenAiThinkingLevel,
	Part,
	ThinkingConfig,
} from "@google/genai";
import type { Context, ImageContent, Model, StopReason, ThinkingBudgets, Tool } from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { createToolNameMap, type ToolNameMap } from "../utils/tool-names.ts";
import { joinTextContent, transformMessages } from "./transform-messages.ts";

export type GoogleApiType = "google-generative-ai" | "google-vertex" | "google-antigravity";

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleThinkingLevel = `${GenAiThinkingLevel}`;
export type GoogleThinkingEffort = "minimal" | "low" | "medium" | "high";

export interface GoogleThinkingConfigFields {
	thinkingLevel?: GoogleThinkingLevel;
	thinkingBudget?: number;
}

function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-flash/.test(modelId.toLowerCase());
}

function getGoogleThinkingLevel(modelId: string, effort: GoogleThinkingEffort): GoogleThinkingLevel {
	if (isGemini3ProModel(modelId)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "LOW";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	if (isGemma4Model(modelId)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "MINIMAL";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	switch (effort) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}

function getGoogleThinkingBudget(
	modelId: string,
	effort: GoogleThinkingEffort,
	customBudgets?: ThinkingBudgets,
): number {
	const customBudget = customBudgets?.[effort];
	if (customBudget !== undefined) {
		return customBudget;
	}

	const normalizedModelId = modelId.toLowerCase();
	if (normalizedModelId.includes("2.5-pro")) {
		const budgets: Record<GoogleThinkingEffort, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[effort];
	}

	if (normalizedModelId.includes("2.5-flash-lite")) {
		const budgets: Record<GoogleThinkingEffort, number> = {
			minimal: 512,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[effort];
	}

	if (normalizedModelId.includes("2.5-flash")) {
		const budgets: Record<GoogleThinkingEffort, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[effort];
	}

	return -1;
}

export function resolveGoogleThinkingConfig(
	modelId: string,
	effort: GoogleThinkingEffort,
	customBudgets?: ThinkingBudgets,
): GoogleThinkingConfigFields {
	if (isGemini3ProModel(modelId) || isGemini3FlashModel(modelId) || isGemma4Model(modelId)) {
		return { thinkingLevel: getGoogleThinkingLevel(modelId, effort) };
	}
	return { thinkingBudget: getGoogleThinkingBudget(modelId, effort, customBudgets) };
}

export function resolveDisabledGoogleThinkingConfig(modelId: string): GoogleThinkingConfigFields {
	// Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
	// do not support full thinking-off either. For those models, use the lowest supported
	// thinkingLevel without includeThoughts so hidden thinking remains invisible to pi.
	if (isGemini3ProModel(modelId)) {
		return { thinkingLevel: "LOW" };
	}
	if (isGemini3FlashModel(modelId) || isGemma4Model(modelId)) {
		return { thinkingLevel: "MINIMAL" };
	}

	// Gemini 2.x supports disabling via thinkingBudget = 0.
	return { thinkingBudget: 0 };
}

export function toGoogleGenAiThinkingConfig(
	fields: GoogleThinkingConfigFields,
	includeThoughts = false,
): ThinkingConfig {
	return {
		...(includeThoughts ? { includeThoughts: true } : {}),
		// The SDK's nominal string enum has exactly the wire values derived by GoogleThinkingLevel.
		...(fields.thinkingLevel ? { thinkingLevel: fields.thinkingLevel as GenAiThinkingLevel } : {}),
		...(fields.thinkingBudget !== undefined ? { thinkingBudget: fields.thinkingBudget } : {}),
	};
}

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 */
export function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(
	model: Model<T>,
	context: Context,
	toolNameMap: ToolNameMap = createToolNameMap(context.tools ?? []),
): Content[] {
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	let pendingToolResultImageParts: Part[] = [];
	const flushPendingToolResultImages = (): void => {
		if (pendingToolResultImageParts.length === 0) return;
		contents.push({
			role: "user",
			parts: [{ text: "Tool result image:" }, ...pendingToolResultImageParts],
		});
		pendingToolResultImageParts = [];
	};

	for (const msg of transformedMessages) {
		if (msg.role !== "toolResult") flushPendingToolResultImages();
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// Check if message is from same provider and model - only then keep thinking blocks
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					// Skip empty text blocks
					if (!block.text || block.text.trim() === "") continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// Skip empty thinking blocks
					if (!block.thinking || block.thinking.trim() === "") continue;
					// Only keep as thinking block if same provider AND same model
					// Otherwise convert to plain text (no tags to avoid model mimicking them)
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const part: Part = {
						functionCall: {
							name: toolNameMap.toProviderName(block.name),
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(thoughtSignature && { thoughtSignature }),
					};
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const textResult = joinTextContent(msg.content);
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ models support multimodal function responses with images nested inside
			// functionResponse.parts. Claude and other non-Gemini models behind Cloud Code Assist /
			// Gemini < 3 still needs a separate user image turn.
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// Use "output" key for success, "error" key for errors as per SDK documentation
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: toolNameMap.toProviderName(msg.toolName),
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API requires all function responses to be in a single user turn.
			// Check if the last content is already a user turn with function responses and merge.
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// For Gemini < 3, add images in a separate user message after the consecutive
			// functionResponse group closes so later tool results still merge into that group.
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				pendingToolResultImageParts.push(...imageParts);
			}
		}
	}

	flushPendingToolResultImages();
	return contents;
}

/** The fields of the API's OpenAPI-subset `Schema`; any other field is rejected as an unknown name. */
const OPENAPI_SCHEMA_FIELDS = new Set([
	"anyOf",
	"default",
	"description",
	"enum",
	"example",
	"format",
	"items",
	"maxItems",
	"maxLength",
	"maxProperties",
	"maximum",
	"minItems",
	"minLength",
	"minProperties",
	"minimum",
	"nullable",
	"pattern",
	"properties",
	"propertyOrdering",
	"required",
	"title",
	"type",
]);

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The local definitions a `$ref` may point at: `#/$defs/<name>` or `#/definitions/<name>`. */
function localDefinitions(schema: JsonObject): Map<string, unknown> {
	const definitions = new Map<string, unknown>();
	for (const key of ["$defs", "definitions"]) {
		const table = schema[key];
		if (!isJsonObject(table)) continue;
		for (const [name, value] of Object.entries(table)) definitions.set(`#/${key}/${name}`, value);
	}
	return definitions;
}

/**
 * Translate a JSON Schema into the OpenAPI subset the `parameters` field accepts. Keywords the subset
 * lacks are expressed in the nearest form it has (`const` as a one-value `enum`, `oneOf` as `anyOf`,
 * an exclusive bound as the inclusive one, a `null` member of a type list as `nullable`, a local
 * `$ref` inlined); anything with no counterpart is left out. The declaration only guides the model:
 * arguments are still validated against the tool's full schema.
 */
function toOpenApiSchema(schema: unknown, definitions: Map<string, unknown>, resolving: ReadonlySet<string>): unknown {
	if (!isJsonObject(schema)) return schema;
	let source = schema;
	const ref = schema.$ref;
	if (typeof ref === "string" && definitions.has(ref) && !resolving.has(ref)) {
		const { $ref: _ref, ...siblings } = schema;
		const target = definitions.get(ref);
		source = isJsonObject(target) ? { ...target, ...siblings } : siblings;
		resolving = new Set([...resolving, ref]);
	}
	const result: JsonObject = {};
	for (const [key, value] of Object.entries(source)) {
		if (key === "properties" && isJsonObject(value)) {
			result.properties = Object.fromEntries(
				Object.entries(value).map(([name, property]) => [name, toOpenApiSchema(property, definitions, resolving)]),
			);
		} else if (key === "items") {
			result.items = toOpenApiSchema(value, definitions, resolving);
		} else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
			Object.assign(result, flattenUnion(value.map((member) => toOpenApiSchema(member, definitions, resolving))));
		} else if (key === "enum" && Array.isArray(value)) {
			// The subset's enum lists strings.
			if (value.every((member) => typeof member === "string")) result.enum = value;
		} else if (key === "type" && Array.isArray(value)) {
			const types = value.filter((type) => type !== "null");
			if (types.length !== value.length) result.nullable = true;
			if (types.length > 0) Object.assign(result, flattenUnion(types.map((type) => ({ type }))));
		} else if (OPENAPI_SCHEMA_FIELDS.has(key)) {
			result[key] = value;
		}
	}
	if ("const" in source && result.enum === undefined && typeof source.const === "string") result.enum = [source.const];
	if (typeof source.exclusiveMinimum === "number" && result.minimum === undefined)
		result.minimum = source.exclusiveMinimum;
	if (typeof source.exclusiveMaximum === "number" && result.maximum === undefined)
		result.maximum = source.exclusiveMaximum;
	return result;
}

/**
 * One schema for a union. The Claude and GPT upstreams reject every `anyOf` that reaches them through
 * `parameters` (measured: a string-or-null, a literal union and an object union each fail as an
 * invalid input_schema), so a union is written in the single-schema forms it has: a `null` member as
 * `nullable`, string literals as one `enum`, object variants as one object with every variant's
 * properties and only the required keys all variants share. Mixed primitive types keep the first and
 * name the rest in the description.
 */
function flattenUnion(members: readonly unknown[]): JsonObject {
	const variants = members.filter(isJsonObject);
	const nullable = variants.some((member) => member.type === "null" || member.nullable === true);
	const kept = variants.filter((member) => member.type !== "null");
	const flat: JsonObject = nullable ? { nullable: true } : {};
	if (kept.length === 0) return flat;
	if (kept.length === 1) return { ...kept[0], ...flat };
	const literals = kept.flatMap((member) =>
		member.type === "string" && Array.isArray(member.enum) ? (member.enum as unknown[]) : [undefined],
	);
	if (literals.every((literal) => typeof literal === "string")) {
		return { type: "string", enum: [...new Set(literals as string[])], ...flat };
	}
	if (kept.every((member) => member.type === "object")) {
		const properties: JsonObject = {};
		for (const member of kept) {
			for (const [name, property] of Object.entries(isJsonObject(member.properties) ? member.properties : {})) {
				if (!(name in properties)) properties[name] = property;
			}
		}
		const requiredBy = kept.map((member) => new Set(Array.isArray(member.required) ? member.required : []));
		const required = [...requiredBy[0]].filter((name) => requiredBy.every((set) => set.has(name)));
		const descriptions = kept.map((member) => member.description).filter((text) => typeof text === "string");
		return {
			type: "object",
			properties,
			...(required.length > 0 ? { required } : {}),
			...(descriptions.length > 0 ? { description: descriptions.join(" Or: ") } : {}),
			...flat,
		};
	}
	const [first, ...rest] = kept;
	const alternatives = [...new Set(rest.map((member) => String(member.type ?? "another shape")))];
	const description = [first.description, `Also accepts: ${alternatives.join(", ")}.`]
		.filter((text) => typeof text === "string")
		.join(" ");
	return { ...first, description, ...flat };
}

function sanitizeForOpenApi(schema: unknown): unknown {
	return toOpenApiSchema(schema, isJsonObject(schema) ? localDefinitions(schema) : new Map(), new Set());
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, const, etc.). Set `useParameters` to true to use the legacy `parameters`
 * field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude
 * models, where the API translates `parameters` into Anthropic's `input_schema`.
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
	toolNameMap: ToolNameMap = createToolNameMap(tools),
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: toolNameMap.toProviderName(tool.name),
				description: tool.description,
				...(useParameters
					? { parameters: sanitizeForOpenApi(tool.parameters as unknown) }
					: { parametersJsonSchema: tool.parameters }),
			})),
		},
	];
}

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	const mode: `${FunctionCallingConfigMode}` = choice === "none" ? "NONE" : choice === "any" ? "ANY" : "AUTO";
	// Checked against SDK enum values above; no SDK runtime is needed to serialize the wire value.
	return mode as FunctionCallingConfigMode;
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
		case "SPII":
		case "SAFETY":
		case "IMAGE_SAFETY":
		case "IMAGE_PROHIBITED_CONTENT":
		case "IMAGE_RECITATION":
		case "IMAGE_OTHER":
		case "RECITATION":
		case "FINISH_REASON_UNSPECIFIED":
		case "OTHER":
		case "LANGUAGE":
		case "MALFORMED_FUNCTION_CALL":
		case "UNEXPECTED_TOOL_CALL":
		case "TOO_MANY_TOOL_CALLS":
		case "NO_IMAGE":
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}
