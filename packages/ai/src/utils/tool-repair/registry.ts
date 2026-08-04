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

export type ToolExecutionAttemptMemory = "retain" | "discard";
export type ToolFailurePhase =
	| "validation"
	| "policy"
	| "preflight"
	| "execution"
	| "timeout"
	| "cancelled"
	| "provisioning";

export const REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE = {
	failureCode: "repeated_successful_call",
	diagnostic: "The identical phone tool call already succeeded and was not executed again.",
	guidance:
		"Use the previous successful result and continue; it is quoted in the diagnostic. Answer the user if the task is complete, or call a different required tool. Do not retry the same call unchanged.",
} as const;

interface ToolExecutionErrorCatalogueEntry {
	name: string;
	phase: ToolFailurePhase;
	guidance: string;
	failureCode?: string;
	attemptMemory?: ToolExecutionAttemptMemory;
	retainDiagnostic?: boolean;
	matches(message: string): boolean;
}

export const TOOL_EXECUTION_ERROR_CATALOGUE = [
	{
		name: "provisioningFailed",
		phase: "provisioning",
		failureCode: "provisioning_failed",
		retainDiagnostic: true,
		guidance:
			"Provisioning failed; use the exact diagnostic, repair that cause, and retry only after the environment changes.",
		matches(message: string): boolean {
			return /\bPI_TOOL_PROVISIONING_FAILED\b/i.test(message);
		},
	},
	{
		name: "commandNotFound",
		phase: "provisioning",
		guidance: "Command was not found; check the command name or available tools before retrying.",
		matches(message: string): boolean {
			return /^spawn \S+ ENOENT\b/i.test(message) || /(?:^|\n|:)\s*command not found\b/i.test(message);
		},
	},
	{
		name: "encodingCorruption",
		phase: "execution",
		failureCode: "encoding_corruption",
		attemptMemory: "discard",
		guidance:
			"Change approach: exact UTF-8 text replacement is unsafe for this file. Use an encoding-aware or byte-safe tool/workflow instead; do not replay the text edit.",
		matches(message: string): boolean {
			return /\bPI_FILE_ENCODING_CORRUPTION\b/i.test(message);
		},
	},
	{
		name: "repeatedSuccessfulCall",
		phase: "execution",
		failureCode: REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.failureCode,
		attemptMemory: "discard",
		retainDiagnostic: true,
		guidance: REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.guidance,
		matches(message: string): boolean {
			return message === REPEATED_SUCCESSFUL_TOOL_CALL_FAILURE.diagnostic;
		},
	},
	{
		name: "fileMutationRetarget",
		phase: "execution",
		failureCode: "mutation_retarget_required",
		attemptMemory: "discard",
		retainDiagnostic: true,
		guidance:
			"The mutation payload is already retained by the harness. Choose only the corrected target path and reuse the exact payloadRef from the diagnostic; do not regenerate content or edits.",
		matches(message: string): boolean {
			return /\bPI_FILE_MUTATION_RETARGET\b/i.test(message);
		},
	},
	{
		name: "fileNotFound",
		phase: "execution",
		guidance: "Path was not found; list the parent directory or re-read the path before retrying.",
		matches(message: string): boolean {
			return /\bENOENT\b/i.test(message) || /no such file or directory/i.test(message);
		},
	},
	{
		name: "editOldTextNotFound",
		phase: "execution",
		guidance: "Re-read the target file and use the exact current text before retrying.",
		matches(message: string): boolean {
			return /(?:oldText|old text|exact text).*(?:not found|no match|failed to match|must match)/is.test(message);
		},
	},
	{
		name: "pathOutsideCwd",
		phase: "policy",
		guidance: "Choose a path inside the current working directory, or ask before changing scope.",
		matches(message: string): boolean {
			return /outside (?:the )?(?:current working directory|cwd|workspace|root)/i.test(message);
		},
	},
	{
		name: "permissionDenied",
		phase: "policy",
		failureCode: "permission_denied",
		retainDiagnostic: true,
		guidance:
			"Access was denied; verify the target path and current authority, then request or change permissions before retrying.",
		matches(message: string): boolean {
			return /\b(?:EACCES|EPERM)\b/i.test(message) || /(?:permission|access) (?:is )?denied/i.test(message);
		},
	},
	{
		name: "invalidOption",
		phase: "execution",
		failureCode: "invalid_option",
		retainDiagnostic: true,
		guidance: "Option rejected; re-read command help and remove or replace it before retrying.",
		matches(message: string): boolean {
			return /\b(?:invalid|unknown|unrecognized) (?:command-line )?(?:option|argument)\b/i.test(message);
		},
	},
	{
		name: "invalidPattern",
		phase: "execution",
		failureCode: "invalid_pattern",
		retainDiagnostic: true,
		guidance: "The search pattern was invalid; simplify it or correct its regex/glob escaping before retrying.",
		matches(message: string): boolean {
			return (
				/(?:regex|regular expression|glob) (?:parse )?error\b/i.test(message) ||
				/\bunclosed (?:group|class)\b/i.test(message)
			);
		},
	},
	{
		name: "outputLimit",
		phase: "execution",
		failureCode: "output_limit",
		guidance:
			"Output exceeded its bound; narrow the scope, page the request, or use the retained artifact before retrying.",
		matches(message: string): boolean {
			return /\b(?:output|result|response).*(?:limit|truncat|too large)\b/i.test(message);
		},
	},
	{
		name: "timedOut",
		phase: "timeout",
		failureCode: "timeout",
		guidance:
			"The operation timed out; narrow or split the work, then retry once only when repeating it is safe and still required.",
		matches(message: string): boolean {
			return (
				/\b(?:command|operation|process|request|tool)\s+(?:timed out|timeout(?: after)?)\b/i.test(message) ||
				/\bETIMEDOUT\b/i.test(message)
			);
		},
	},
	{
		name: "cancelled",
		phase: "cancelled",
		failureCode: "cancelled",
		guidance:
			"The operation was cancelled; retry only if it is still required and the cancellation condition has cleared.",
		matches(message: string): boolean {
			return (
				/^(?:operation|request|tool) (?:was )?(?:aborted|cancelled|canceled)\b/i.test(message) ||
				/\bAbortError\b/i.test(message)
			);
		},
	},
] as const satisfies readonly ToolExecutionErrorCatalogueEntry[];

export type ToolExecutionErrorClass = (typeof TOOL_EXECUTION_ERROR_CATALOGUE)[number]["name"];
const executionErrorCatalogue: readonly ToolExecutionErrorCatalogueEntry[] = TOOL_EXECUTION_ERROR_CATALOGUE;

export interface ToolExecutionErrorPolicy {
	name: ToolExecutionErrorClass;
	phase: ToolFailurePhase;
	guidance: string;
	failureCode?: string;
	attemptMemory: ToolExecutionAttemptMemory;
	retainDiagnostic: boolean;
}

export function getToolExecutionErrorPolicy(errorMessage: string): ToolExecutionErrorPolicy | undefined {
	const entry = executionErrorCatalogue.find((candidate) => candidate.matches(errorMessage));
	if (!entry) return undefined;
	return {
		name: entry.name as ToolExecutionErrorClass,
		phase: entry.phase,
		guidance: entry.guidance,
		...(entry.failureCode ? { failureCode: entry.failureCode } : {}),
		attemptMemory: entry.attemptMemory ?? "retain",
		retainDiagnostic: entry.retainDiagnostic ?? false,
	};
}

export function getToolExecutionAttemptMemory(failureCode: string): ToolExecutionAttemptMemory {
	const entry = executionErrorCatalogue.find((candidate) => candidate.failureCode === failureCode);
	return entry?.attemptMemory ?? "retain";
}

export function getToolExecutionErrorGuidance(errorMessage: string): string | undefined {
	return getToolExecutionErrorPolicy(errorMessage)?.guidance;
}
