export const TOOL_REPAIR_MODE_NAMES = [
	"nullOptionalDrop",
	"nullRequiredBounce",
	"jsonStringParse",
	"jsonObjectPropertySalvage",
	"singleObjectWrap",
	"bareScalarWrap",
	"emptyObjectPlaceholder",
	"numberFromString",
	"boolFromString",
	"enumCaseNormalize",
	"propertyCaseNormalize",
	"singleElementUnwrap",
	"stringifiedNumberInArray",
	"bashCommandArgvJoin",
	"bashCommandUnwrap",
] as const;

export type ToolRepairModeName = (typeof TOOL_REPAIR_MODE_NAMES)[number];
export type ToolRepairFailureModeName = ToolRepairModeName | "other";

export interface ToolRepairRegistryEntry {
	name: ToolRepairModeName;
	noteTemplate: string;
	standingRule: string;
}

export const TOOL_REPAIR_REGISTRY: readonly ToolRepairRegistryEntry[] = [
	{
		name: "nullOptionalDrop",
		noteTemplate: "sent null for optional `{path}` -> omit the field instead",
		standingRule: "Omit optional fields instead of sending null.",
	},
	{
		name: "nullRequiredBounce",
		noteTemplate: "`{path}` is required and cannot be null -> send a real value",
		standingRule: "Send real values for required fields; never send null for a required field.",
	},
	{
		name: "jsonStringParse",
		noteTemplate: "sent `{path}` as a quoted JSON string -> send a raw JSON array/object",
		standingRule:
			"Send raw JSON arrays/objects where the tool schema expects arrays/objects; do not quote them as JSON strings.",
	},
	{
		name: "jsonObjectPropertySalvage",
		noteTemplate:
			"sent `{path}` as malformed JSON with recoverable declared properties -> keep the schema-declared properties",
		standingRule:
			"When sending JSON objects, use strict JSON syntax with commas between properties and no extra text inside the object.",
	},
	{
		name: "singleObjectWrap",
		noteTemplate: "sent one object where `{path}` takes a list -> wrap it in [ ]",
		standingRule: "Wrap a single object in [ ] when the tool schema expects a list.",
	},
	{
		name: "bareScalarWrap",
		noteTemplate: "sent a single value where `{path}` takes a list -> wrap it in [ ]",
		standingRule: "Wrap a single scalar in [ ] when the tool schema expects a list.",
	},
	{
		name: "emptyObjectPlaceholder",
		noteTemplate: "sent `{}` as a placeholder -> omit `{path}`; its default applies",
		standingRule: "Omit defaulted object fields instead of sending `{}` placeholders.",
	},
	{
		name: "numberFromString",
		noteTemplate: "sent `{path}` as a quoted number -> send a bare number",
		standingRule: "Send bare numbers where the tool schema expects numbers; do not quote them.",
	},
	{
		name: "boolFromString",
		noteTemplate: "sent `{path}` as a quoted boolean -> send bare true/false",
		standingRule: "Send bare true/false where the tool schema expects booleans; do not quote them.",
	},
	{
		name: "enumCaseNormalize",
		noteTemplate: "`{path}` matched a declared enum value after case/space normalization",
		standingRule: "Use enum values exactly as declared, preserving case and spacing.",
	},
	{
		name: "propertyCaseNormalize",
		noteTemplate: "sent `{path}` with different property-key casing -> use the schema key casing",
		standingRule: "Use tool argument property names exactly as declared in the schema, preserving case.",
	},
	{
		name: "singleElementUnwrap",
		noteTemplate: "sent `{path}` as a 1-item list where a single value was expected -> send the value",
		standingRule:
			"Send a single value directly when the tool schema expects a single value; do not wrap it in a one-item list.",
	},
	{
		name: "stringifiedNumberInArray",
		noteTemplate: "list `{path}` holds quoted numbers -> send bare numbers",
		standingRule: "Use bare numbers inside number arrays; do not quote them.",
	},
	{
		name: "bashCommandArgvJoin",
		noteTemplate: "bash takes one command string, not an argv list -> joined the argv values",
		standingRule: "For bash, send one command string rather than an argv array.",
	},
	{
		name: "bashCommandUnwrap",
		noteTemplate: "bash `command` is a string -> unwrapped the command object",
		standingRule: "For bash, send `command` as a string rather than an object wrapper.",
	},
] as const;

const registryByName = new Map(TOOL_REPAIR_REGISTRY.map((entry) => [entry.name, entry]));

export function getToolRepairRegistryEntry(name: ToolRepairModeName): ToolRepairRegistryEntry {
	const entry = registryByName.get(name);
	if (!entry) throw new Error(`Unknown tool repair mode: ${name}`);
	return entry;
}

export function formatToolRepairNote(name: ToolRepairModeName, path: string): string {
	return getToolRepairRegistryEntry(name).noteTemplate.replaceAll("{path}", path);
}

export function formatToolRepairStandingRule(name: ToolRepairModeName): string {
	return getToolRepairRegistryEntry(name).standingRule;
}

export const TOOL_EXECUTION_ERROR_CATALOGUE = [
	{
		name: "commandNotFound",
		guidance: "Command was not found; check the command name or available tools before retrying.",
		matches(message: string): boolean {
			return /^spawn \S+ ENOENT\b/i.test(message) || /(?:^|\n|:)\s*command not found\b/i.test(message);
		},
	},
	{
		name: "fileNotFound",
		guidance: "Path was not found; list the parent directory or re-read the path before retrying.",
		matches(message: string): boolean {
			return /\bENOENT\b/i.test(message) || /no such file or directory/i.test(message);
		},
	},
	{
		name: "editOldTextNotFound",
		guidance: "Re-read the target file and use the exact current text before retrying.",
		matches(message: string): boolean {
			return /(?:oldText|old text|exact text).*(?:not found|no match|failed to match|must match)/is.test(message);
		},
	},
	{
		name: "pathOutsideCwd",
		guidance: "Choose a path inside the current working directory, or ask before changing scope.",
		matches(message: string): boolean {
			return /outside (?:the )?(?:current working directory|cwd|workspace|root)/i.test(message);
		},
	},
] as const;

export type ToolExecutionErrorClass = (typeof TOOL_EXECUTION_ERROR_CATALOGUE)[number]["name"];

export function getToolExecutionErrorGuidance(errorMessage: string): string | undefined {
	return TOOL_EXECUTION_ERROR_CATALOGUE.find((entry) => entry.matches(errorMessage))?.guidance;
}
