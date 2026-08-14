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
	"propertyAliasNormalize",
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
		noteTemplate: "optional `{path}` was null; omit field",
		standingRule: "Optional field: omit, never null.",
	},
	{
		name: "nullRequiredBounce",
		noteTemplate: "required `{path}` was null; send real value",
		standingRule: "Required field: real value, never null.",
	},
	{
		name: "jsonStringParse",
		noteTemplate: "`{path}` was quoted JSON; send raw array/object",
		standingRule: "Schema array/object: raw JSON, never quoted JSON string.",
	},
	{
		name: "jsonObjectPropertySalvage",
		noteTemplate: "`{path}` was malformed JSON; retained declared properties",
		standingRule: "JSON object: strict syntax, commas between properties, no extra inner text.",
	},
	{
		name: "singleObjectWrap",
		noteTemplate: "`{path}` needs list; wrap object in [ ]",
		standingRule: "List schema: wrap one object in [ ].",
	},
	{
		name: "bareScalarWrap",
		noteTemplate: "`{path}` needs list; wrap scalar in [ ]",
		standingRule: "List schema: wrap one scalar in [ ].",
	},
	{
		name: "emptyObjectPlaceholder",
		noteTemplate: "`{path}` was `{}` placeholder; omit for default",
		standingRule: "Defaulted object field: omit, never `{}` placeholder.",
	},
	{
		name: "numberFromString",
		noteTemplate: "`{path}` was quoted number; send bare number",
		standingRule: "Number schema: bare number, never quoted.",
	},
	{
		name: "boolFromString",
		noteTemplate: "`{path}` was quoted boolean; send bare true/false",
		standingRule: "Boolean schema: bare true/false, never quoted.",
	},
	{
		name: "enumCaseNormalize",
		noteTemplate: "`{path}` normalized to declared enum case/spacing",
		standingRule: "Enum value: exact declared case/spacing.",
	},
	{
		name: "propertyCaseNormalize",
		noteTemplate: "`{path}` used wrong key case; use schema case",
		standingRule: "Argument property: exact schema name/case.",
	},
	{
		name: "propertyAliasNormalize",
		noteTemplate: "`{path}` used property alias; mapped to schema property",
		standingRule: "Argument property: exact schema property name.",
	},
	{
		name: "singleElementUnwrap",
		noteTemplate: "`{path}` needs scalar; unwrap 1-item list",
		standingRule: "Scalar schema: direct value, never 1-item list.",
	},
	{
		name: "stringifiedNumberInArray",
		noteTemplate: "number list `{path}` held quoted values; send bare numbers",
		standingRule: "Number array: bare numbers, never quoted.",
	},
	{
		name: "bashCommandArgvJoin",
		noteTemplate: "bash needs one command string; joined argv values",
		standingRule: "bash command: one string, never argv array.",
	},
	{
		name: "bashCommandUnwrap",
		noteTemplate: "bash `command` needs string; unwrapped object",
		standingRule: "bash `command`: string, never object wrapper.",
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
		"Use prior successful result; continue. Task complete: answer user. Otherwise call different required tool. Never retry unchanged.",
} as const;

/** Stable marker for a tool-owned guard that rejects one operation before external execution. */
export const TOOL_OPERATION_REJECTED_MARKER = "PI_TOOL_OPERATION_REJECTED";
/**
 * bash.ts is the only emitter (`${TOOL_OPERATION_REJECTED_MARKER}: ...`) and always places the
 * marker at the very start of the thrown error's message, never mid-sentence. Anchor to a line
 * start so captured stdout/stderr that merely echoes the marker (e.g. a `grep` of this file)
 * cannot masquerade as a tool-owned rejection.
 */
const TOOL_OPERATION_REJECTED_LINE_PATTERN = new RegExp(`^${TOOL_OPERATION_REJECTED_MARKER}:`, "m");

interface ToolExecutionErrorCatalogueEntry {
	name: string;
	phase: ToolFailurePhase;
	guidance: string;
	failureCode?: string;
	attemptMemory?: ToolExecutionAttemptMemory;
	retainDiagnostic?: boolean;
	/** Number of unchanged executions permitted after the first failure in one recovery window. */
	unchangedRetryLimit?: number;
	matches(message: string): boolean;
}

export const TOOL_EXECUTION_ERROR_CATALOGUE = [
	{
		name: "operationRejected",
		phase: "policy",
		failureCode: "operation_rejected",
		attemptMemory: "discard",
		retainDiagnostic: true,
		guidance:
			"Operation rejected before execution. Follow the diagnostic: correct or narrow the call, or continue independent work. The runtime remains available.",
		matches(message: string): boolean {
			return TOOL_OPERATION_REJECTED_LINE_PATTERN.test(message);
		},
	},
	{
		name: "provisioningFailed",
		phase: "provisioning",
		failureCode: "provisioning_failed",
		retainDiagnostic: true,
		guidance: "Provisioning failed. Use exact diagnostic, fix cause; retry only after environment changes.",
		matches(message: string): boolean {
			return /\bPI_TOOL_PROVISIONING_FAILED\b/i.test(message);
		},
	},
	{
		name: "commandNotFound",
		phase: "provisioning",
		guidance: "Command not found. Check exact name/available tools before retry.",
		matches(message: string): boolean {
			return /^spawn \S+ ENOENT\b/i.test(message) || /(?:^|\n|:)\s*command not found\b/i.test(message);
		},
	},
	{
		name: "bashNoOutput",
		phase: "execution",
		guidance: "Command failed without output. Verify syntax, exact command documentation before retry.",
		matches(message: string): boolean {
			return message === "(no output)";
		},
	},
	{
		name: "bashPosixNotSupported",
		phase: "execution",
		guidance: "Windows host rejects POSIX .sh scripts. Use PowerShell equivalent or invoke executable directly.",
		matches(message: string): boolean {
			return /POSIX shell scripts are not supported by the Windows shell contract router/i.test(message);
		},
	},
	{
		name: "bashNestedShell",
		phase: "execution",
		guidance: "Never wrap command in powershell.exe/pwsh. Invoke .ps1 or command directly.",
		matches(message: string): boolean {
			return /Nested shell execution is not supported by the Windows shell contract router/i.test(message);
		},
	},
	{
		name: "bashMissingCommandWord",
		phase: "execution",
		guidance: "Missing shell command word. Fix empty pipeline element or string quoting before retry.",
		matches(message: string): boolean {
			return /Missing command: a pipeline\/list element has no command word/i.test(message);
		},
	},
	{
		name: "bashEmptyRedirectTarget",
		phase: "execution",
		guidance: "Empty redirect target. Supply valid file path before retry.",
		matches(message: string): boolean {
			return /redirect target expanded to nothing/i.test(message);
		},
	},
	{
		name: "encodingCorruption",
		phase: "execution",
		failureCode: "encoding_corruption",
		attemptMemory: "discard",
		guidance:
			"Change approach: exact UTF-8 replacement unsafe. Use encoding-aware/byte-safe tool; never replay text edit.",
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
			"Harness retained mutation. Choose corrected target path, reuse exact diagnostic payloadRef; never regenerate content/edits.",
		matches(message: string): boolean {
			return /\bPI_FILE_MUTATION_RETARGET\b/i.test(message);
		},
	},
	{
		name: "fileNotFound",
		phase: "execution",
		failureCode: "file_not_found",
		guidance: "Path not found. List parent directory or re-read path before retry.",
		matches(message: string): boolean {
			return (
				/\bENOENT\b/i.test(message) ||
				/no such file or directory/i.test(message) ||
				/\b(?:file|path) not found\b/i.test(message)
			);
		},
	},
	{
		name: "editOldTextNotFound",
		phase: "execution",
		failureCode: "edit_old_text_not_found",
		guidance: "Re-read target; use exact current text before retry.",
		matches(message: string): boolean {
			return /(?:oldText|old text|exact text).*(?:not found|no match|failed to match|must match)/is.test(message);
		},
	},
	{
		name: "pathOutsideCwd",
		phase: "policy",
		guidance: "Choose path inside current working directory; ask before scope change.",
		matches(message: string): boolean {
			return /outside (?:the )?(?:current working directory|cwd|workspace|root)/i.test(message);
		},
	},
	{
		name: "permissionDenied",
		phase: "policy",
		failureCode: "permission_denied",
		retainDiagnostic: true,
		guidance: "Access denied. Verify target/current authority; obtain permissions before retry.",
		matches(message: string): boolean {
			return /\b(?:EACCES|EPERM)\b/i.test(message) || /(?:permission|access) (?:is )?denied/i.test(message);
		},
	},
	{
		name: "invalidOption",
		phase: "execution",
		failureCode: "invalid_option",
		retainDiagnostic: true,
		guidance: "Option rejected. Read command help; remove/replace option before retry.",
		matches(message: string): boolean {
			return /\b(?:invalid|unknown|unrecognized) (?:command-line )?(?:option|argument)\b/i.test(message);
		},
	},
	{
		name: "invalidPattern",
		phase: "execution",
		failureCode: "invalid_pattern",
		retainDiagnostic: true,
		guidance: "Invalid search pattern. Simplify or fix regex/glob escaping before retry.",
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
		guidance: "Output exceeded bound. Narrow scope, page request, or use retained artifact before retry.",
		matches(message: string): boolean {
			return /\b(?:output|result|response).*(?:limit|truncat|too large)\b/i.test(message);
		},
	},
	{
		name: "timedOut",
		phase: "timeout",
		failureCode: "timeout",
		unchangedRetryLimit: 1,
		guidance: "Operation timed out. Narrow/split work; one unchanged retry only when safe, still required.",
		matches(message: string): boolean {
			return (
				/\b(?:command|operation|process|request|tool)\s+(?:timed out|timeout(?: after)?)\b/i.test(message) ||
				/\bETIMEDOUT\b/i.test(message)
			);
		},
	},
	{
		name: "ownerAuthorizationRequired",
		phase: "policy",
		failureCode: "owner_authorization_required",
		guidance:
			"Owner authorization is missing from the current prompt. Do not retry start. Continue without a goal or wait for owner speech.",
		matches(message: string): boolean {
			return (
				/goal start requires explicit owner authorization/i.test(message) ||
				/tokenBudget requires an exact numeric token ceiling in the current owner prompt/i.test(message) ||
				/tokenBudget must equal the owner-requested ceiling/i.test(message)
			);
		},
	},
	{
		name: "exclusiveArguments",
		phase: "validation",
		failureCode: "invalid_arguments",
		guidance: "Provide exactly one of the mutually exclusive fields. Do not send both, and do not omit both.",
		matches(message: string): boolean {
			return /Provide exactly one of /i.test(message);
		},
	},
	{
		name: "skillNotEligible",
		phase: "policy",
		failureCode: "skill_not_eligible",
		guidance: "Skill name is not eligible. Search, then load an exact listed name. Do not retry the same name.",
		matches(message: string): boolean {
			return /No eligible skill named/i.test(message);
		},
	},
	{
		name: "cancelled",
		phase: "cancelled",
		failureCode: "cancelled",
		guidance: "Operation cancelled. Retry only when still required, cancellation condition cleared.",
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
	unchangedRetryLimit: number;
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
		unchangedRetryLimit: entry.unchangedRetryLimit ?? 0,
	};
}

export function getToolExecutionAttemptMemory(failureCode: string): ToolExecutionAttemptMemory {
	const entry = executionErrorCatalogue.find((candidate) => candidate.failureCode === failureCode);
	return entry?.attemptMemory ?? "retain";
}

export function getToolExecutionUnchangedRetryLimit(failureCode: string): number {
	const entry = executionErrorCatalogue.find((candidate) => candidate.failureCode === failureCode);
	return entry?.unchangedRetryLimit ?? 0;
}

export function getToolExecutionErrorGuidance(errorMessage: string): string | undefined {
	return getToolExecutionErrorPolicy(errorMessage)?.guidance;
}
