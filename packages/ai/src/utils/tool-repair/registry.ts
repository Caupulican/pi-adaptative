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
}

export const TOOL_REPAIR_REGISTRY: readonly ToolRepairRegistryEntry[] = [
	{
		name: "nullOptionalDrop",
		noteTemplate: "sent null for optional `{path}` -> omit the field instead",
	},
	{
		name: "nullRequiredBounce",
		noteTemplate: "`{path}` is required and cannot be null -> send a real value",
	},
	{
		name: "jsonStringParse",
		noteTemplate: "sent `{path}` as a quoted JSON string -> send a raw JSON array/object",
	},
	{
		name: "singleObjectWrap",
		noteTemplate: "sent one object where `{path}` takes a list -> wrap it in [ ]",
	},
	{
		name: "bareScalarWrap",
		noteTemplate: "sent a single value where `{path}` takes a list -> wrap it in [ ]",
	},
	{
		name: "emptyObjectPlaceholder",
		noteTemplate: "sent `{}` as a placeholder -> omit `{path}`; its default applies",
	},
	{
		name: "numberFromString",
		noteTemplate: "sent `{path}` as a quoted number -> send a bare number",
	},
	{
		name: "boolFromString",
		noteTemplate: "sent `{path}` as a quoted boolean -> send bare true/false",
	},
	{
		name: "enumCaseNormalize",
		noteTemplate: "`{path}` matched a declared enum value after case/space normalization",
	},
	{
		name: "singleElementUnwrap",
		noteTemplate: "sent `{path}` as a 1-item list where a single value was expected -> send the value",
	},
	{
		name: "stringifiedNumberInArray",
		noteTemplate: "list `{path}` holds quoted numbers -> send bare numbers",
	},
	{
		name: "bashCommandArgvJoin",
		noteTemplate: "bash takes one command string, not an argv list -> joined the argv values",
	},
	{
		name: "bashCommandUnwrap",
		noteTemplate: "bash `command` is a string -> unwrapped the command object",
	},
] as const;

const registryByName = new Map(TOOL_REPAIR_REGISTRY.map((entry) => [entry.name, entry]));

export function getToolRepairRegistryEntry(name: ToolRepairModeName): ToolRepairRegistryEntry {
	const entry = registryByName.get(name);
	if (!entry) throw new Error(`Unknown tool repair mode: ${name}`);
	return entry;
}
