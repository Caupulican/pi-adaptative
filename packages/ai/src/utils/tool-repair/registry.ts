export const TOOL_REPAIR_MODE_NAMES = [
	"nullOptionalDrop",
	"nullRequiredBounce",
	"jsonStringParse",
	"singleObjectWrap",
	"bareScalarWrap",
	"emptyObjectPlaceholder",
	"numberFromString",
	"boolFromString",
	"enumCaseNormalize",
	"singleElementUnwrap",
	"stringifiedNumberInArray",
	"bashCommandArgvJoin",
	"bashCommandUnwrap",
] as const;

export type ToolRepairModeName = (typeof TOOL_REPAIR_MODE_NAMES)[number];

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
