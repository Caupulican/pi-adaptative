import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import type { Tool, ToolCall } from "../types.ts";
import { repairToolArguments } from "./tool-repair/repairer.ts";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();

function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

function formatValidationErrors(errors: readonly TLocalizedValidationError[]): string {
	return (
		errors.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`).join("\n") ||
		"Unknown validation error"
	);
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): Record<string, unknown> {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema.
 *
 * The hot path is validate-first and allocation-free: valid arguments return the exact
 * argument object emitted by the model. Only invalid calls enter the deterministic
 * repair layer, which applies named, guard-checked shape repairs on a clone.
 *
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially repaired) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): Record<string, unknown> {
	const args = toolCall.arguments;
	const validator = getValidator(tool.parameters);

	if (validator.Check(args)) {
		return args;
	}

	const validationErrors = [...validator.Errors(args)] as TLocalizedValidationError[];
	const repaired = repairToolArguments(toolCall.name, tool.parameters, args, validationErrors, (candidate) =>
		validator.Check(candidate),
	);
	if (repaired) {
		return repaired.args;
	}

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${formatValidationErrors(
		validationErrors,
	)}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}
