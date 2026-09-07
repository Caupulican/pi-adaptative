import {
	type AgentTool,
	AgentToolExecutionError,
	type AgentToolResult,
	type ExecutionContext,
} from "@caupulican/pi-agent-core";
import type { TSchema } from "typebox";
import { extractToolPathArguments } from "../autonomy/envelope-enforcement.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { parseShellSearchInvocationScope, type ShellContentSearchTool } from "../tools/search-command-guard.ts";
import { tokenizeShellCommand } from "../tools/shell-command-parser.ts";
import { wrapToolExecution } from "../tools/tool-execution-wrapper.ts";
import { isMissingPathError } from "../util/filesystem-errors.ts";
import type { CredentialPathPolicy, CredentialPathProbe, CredentialPathProtection } from "./credential-path-policy.ts";
import { createCredentialPathPolicy } from "./native-credential-path-probe.ts";

const DIRECT_PATH_TOOLS = new Set(["read", "edit", "write", "ls", "image_generate"]);
const SHELL_INSPECTION_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"sed",
	"awk",
	"grep",
	"rg",
	"ripgrep",
	"type",
	"get-content",
	"select-string",
	"source",
]);
const SHELL_SECRET_READ_RE =
	/\b(?:cat|head|tail|less|more|sed|awk|grep|rg|type|get-content|select-string|source)\b[^\n;&|]*(?:^|[\\/])?\.env(?:\.[A-Za-z0-9._-]+)?\b/i;
const PYTHON_SECRET_READ_RE = /\b(?:open|read_text|read_bytes)\s*\([^\n)]*(?:^|[\\/])?\.env(?:\.[A-Za-z0-9._-]+)?\b/i;
const PYTHON_INSPECTION_RE = /\b(?:open|read_text|read_bytes)\b/;
const QUOTED_TEXT_RE = /(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\1/g;
const MAX_REDACTED_DETAIL_DEPTH = 8;
const MAX_REDACTED_DETAIL_NODES = 10_000;
const JQ_OPTIONS_WITH_ONE_OPERAND = new Set(["-L", "--indent"]);
const JQ_OPTIONS_WITH_TWO_OPERANDS = new Set(["--arg", "--argjson", "--rawfile", "--slurpfile"]);

export interface CredentialExposureBoundary extends CredentialPathProtection {
	redactSensitiveText(text: string): string;
	/** Explicit backend facts; errors never substitute native filesystem results. */
	getPathProbe?(context?: ExecutionContext): CredentialPathProbe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProtectedCredentialPath(
	rawPath: string,
	cwd: string,
	boundary?: CredentialExposureBoundary,
): boolean {
	return createCredentialPathPolicy(cwd, boundary, undefined, boundary?.getPathProbe?.()).isProtected(rawPath);
}

function shellCredentialRisk(
	command: string,
	paths: CredentialPathPolicy,
): "broad_search" | "credential_path" | "process_environment" | undefined {
	const shellTokens = tokenizeShellCommand(command);
	if (!shellTokens) {
		// The whole script did not tokenize (a heredoc, an unbalanced quote). Refusing on the bare
		// word `rg`/`grep` anywhere in it refused a 14-line deploy script for its last line (measured
		// live); assess each search line on its own instead, and let the rest pass.
		for (const line of command.split(/\r?\n/u)) {
			const trimmed = line.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/u, "");
			if (!/^(?:rg|ripgrep|grep)\b/iu.test(trimmed)) continue;
			const lineTokens = tokenizeShellCommand(trimmed);
			if (!lineTokens) continue;
			const risk = shellCredentialRisk(trimmed, paths);
			if (risk) return risk;
		}
		return undefined;
	}

	const assessInvocation = (
		invocation: string[],
		readsPipe: boolean,
	): "broad_search" | "credential_path" | "process_environment" | undefined => {
		for (let commandIndex = 0; commandIndex < invocation.length; commandIndex++) {
			const toolName = (invocation[commandIndex].split(/[\\/]/u).at(-1) ?? "").toLowerCase().replace(/\.exe$/u, "");
			if (toolName === "jq") {
				const filter = jqFilterFromArgs(invocation.slice(commandIndex + 1));
				if (filter && jqFilterReadsProcessEnvironment(filter)) return "process_environment";
			}
			if (!SHELL_INSPECTION_COMMANDS.has(toolName)) continue;
			const args = invocation.slice(commandIndex + 1);
			const searchTool: ShellContentSearchTool | undefined =
				toolName === "rg" || toolName === "ripgrep" ? "rg" : toolName === "grep" ? "grep" : undefined;
			if (searchTool) {
				const searchRisk = searchCredentialRisk(searchTool, args, readsPipe, paths, true);
				if (searchRisk) return searchRisk;
				continue;
			}
			for (const token of args) {
				if (!token || token.startsWith("-") || token === ".") continue;
				if (paths.isProtectedToken(token)) return "credential_path";
			}
		}
		return undefined;
	};

	let invocation: string[] = [];
	let skipRedirectTarget = false;
	let readsPipe = false;
	for (const token of shellTokens) {
		if (token.kind === "arg") {
			if (skipRedirectTarget) skipRedirectTarget = false;
			else invocation.push(token.value);
			continue;
		}
		if (token.kind === "redirect") {
			// Descriptor duplication (`2>&1`) has no following path operand. Other
			// redirects do, and that target must never count as search scope.
			skipRedirectTarget = !/^\d*[<>]&[\d-]+$/u.test(token.value);
			continue;
		}
		const risk = assessInvocation(invocation, readsPipe);
		if (risk) return risk;
		invocation = [];
		skipRedirectTarget = false;
		readsPipe = token.kind === "pipe";
	}
	return assessInvocation(invocation, readsPipe);
}

function jqFilterFromArgs(args: string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (token === "--") return args[index + 1];
		if (JQ_OPTIONS_WITH_TWO_OPERANDS.has(token)) {
			index += 2;
			continue;
		}
		if (JQ_OPTIONS_WITH_ONE_OPERAND.has(token)) {
			index++;
			continue;
		}
		if (token.startsWith("-")) continue;
		return token;
	}
	return undefined;
}

function jqFilterReadsProcessEnvironment(filter: string): boolean {
	return /(?:^|[\s|,(:;[])(?:env|\$ENV)(?=$|[\s|),.;[\]}])/u.test(filter);
}

function isCredentialSafeGlob(glob: string): boolean {
	if (/(?:^|[\\/])?\.env(?:\.|\*|$)/i.test(glob)) return false;
	const filePattern = glob.replace(/\\/g, "/").split("/").at(-1) ?? "";
	// A literal filename prefix (`Buildfile*`, `report-*`) is as narrow as a suffix glob: it names a
	// family of files, not a directory (measured live: refused with the suffix-only rule).
	if (/^[A-Za-z0-9_][A-Za-z0-9_.-]{2,}\*$/u.test(filePattern) && !/\.env/i.test(filePattern)) return true;
	const braceSuffixes = filePattern.match(/\.\{([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)+)\}$/)?.[1];
	const suffixes = braceSuffixes
		? braceSuffixes.split(",").map((suffix) => suffix.toLowerCase())
		: [filePattern.match(/\.([A-Za-z0-9_-]+)$/)?.[1]?.toLowerCase()].filter(
				(suffix): suffix is string => suffix !== undefined,
			);
	return suffixes.length > 0 && suffixes.every((suffix) => suffix !== "env");
}

function isCredentialSafeExplicitFile(rawPath: string, paths: CredentialPathPolicy, allowMissing: boolean): boolean {
	try {
		return paths.isFile(rawPath) ?? (allowMissing && isCredentialSafeGlob(rawPath));
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
		return allowMissing && isCredentialSafeGlob(rawPath);
	}
}

function searchCredentialRisk(
	searchTool: ShellContentSearchTool,
	args: readonly string[],
	readsPipe: boolean,
	paths: CredentialPathPolicy,
	allowShellVariables: boolean,
): "broad_search" | "credential_path" | undefined {
	const scope = parseShellSearchInvocationScope(searchTool, [...args], readsPipe);
	return contentSearchCredentialRisk(scope, paths, true, allowShellVariables);
}

function contentSearchCredentialRisk(
	scope: { targets: readonly string[]; positiveGlobs: readonly string[]; metaOnly: boolean; readsStdin: boolean },
	paths: CredentialPathPolicy,
	commandLineOperands: boolean,
	allowShellVariables: boolean,
): "broad_search" | "credential_path" | undefined {
	if (scope.targets.some((target) => target !== "-" && paths.isProtected(target))) {
		return "credential_path";
	}
	const hasSafeGlob =
		scope.positiveGlobs.length > 0 && scope.positiveGlobs.every((glob) => isCredentialSafeGlob(glob));
	const hasOnlyExplicitFiles =
		scope.targets.length > 0 &&
		scope.targets.every(
			(target) =>
				(commandLineOperands && target === "-") ||
				// A shell variable names one file the lexical guard cannot resolve; it is not a directory scan.
				(allowShellVariables && /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/u.test(target)) ||
				isCredentialSafeExplicitFile(target, paths, commandLineOperands) ||
				paths.isHarnessOwnedSearchTarget(target),
		);
	if (!scope.metaOnly && !scope.readsStdin && !hasSafeGlob && !hasOnlyExplicitFiles) return "broad_search";
	return undefined;
}

function pythonInspectsCredentialPath(code: string, paths: CredentialPathPolicy): boolean {
	if (!PYTHON_INSPECTION_RE.test(code)) return false;
	QUOTED_TEXT_RE.lastIndex = 0;
	for (const match of code.matchAll(QUOTED_TEXT_RE)) {
		// A literal used as the left operand of membership is search data, not a filename.
		// Keep inspecting every other literal: assignments, Path/open operands, and the source
		// being searched still pass through the protected-path check. This remains a lexical
		// guard, not authorization for arbitrary Python or dynamically constructed paths.
		if (/^\s+(?:not\s+)?in\b/u.test(code.slice(match.index + match[0].length))) continue;
		const candidate = match[2]?.replace(/\\([\\"'])/g, "$1");
		if (candidate && paths.isProtectedToken(candidate)) return true;
	}
	return false;
}

/**
 * Inspect direct argv values only. A process may still construct paths inside its own code or
 * environment; that host-trust residual requires OS-level isolation and is deliberately outside
 * this lexical boundary.
 */
function runProcessCredentialRisk(
	executable: string,
	args: readonly string[],
	paths: CredentialPathPolicy,
): "broad_search" | "credential_path" | "process_environment" | undefined {
	if (paths.isProtected(executable)) return "credential_path";
	if (args.some((argument) => paths.isProtectedToken(argument))) return "credential_path";

	const executableName = paths.executableName(executable);
	if (executableName === "jq") {
		const filter = jqFilterFromArgs([...args]);
		if (filter && jqFilterReadsProcessEnvironment(filter)) return "process_environment";
	}
	const searchTool: ShellContentSearchTool | undefined =
		executableName === "rg" || executableName === "ripgrep" ? "rg" : executableName === "grep" ? "grep" : undefined;
	if (!searchTool) return undefined;
	return searchCredentialRisk(searchTool, args, false, paths, false);
}

/** Stable model-facing refusal for direct inspection/mutation of credential material. */
export function credentialToolBlockReason(
	toolName: string,
	args: unknown,
	cwd: string,
	boundary?: CredentialExposureBoundary,
	executionContext?: ExecutionContext,
): string | undefined {
	if (toolName === "secret_store" || !isRecord(args)) return undefined;
	const paths = createCredentialPathPolicy(
		cwd,
		boundary,
		executionContext,
		boundary?.getPathProbe?.(executionContext),
	);
	if (DIRECT_PATH_TOOLS.has(toolName)) {
		if (extractToolPathArguments(toolName, args).some((path) => paths.isProtected(path))) {
			return "Credential file access is model-blind. Use secret_store migrate with this path, or activate an existing profile, without inspecting credential data.";
		}
	}
	if (toolName === "grep") {
		const path = typeof args.path === "string" ? args.path : undefined;
		const glob = typeof args.glob === "string" ? args.glob : undefined;
		const risk = contentSearchCredentialRisk(
			{
				targets: path ? [path] : [],
				positiveGlobs: glob ? [glob] : [],
				metaOnly: false,
				readsStdin: false,
			},
			paths,
			false,
			false,
		);
		if (risk === "credential_path" || (glob && /(?:^|[\\/])?\.env(?:\.|\*|$)/i.test(glob))) {
			return "Credential dotenv files are model-blind. Use secret_store discover instead of searching their contents.";
		}
		if (risk === "broad_search") {
			return "Credential-safe grep requires one explicit regular file or a narrow non-dotenv file glob (for example *.ts). Refine the search instead of scanning a directory without a file filter.";
		}
	}
	if (toolName === "find") {
		const path = typeof args.path === "string" ? args.path : undefined;
		const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
		if ((path && paths.isProtected(path)) || (pattern && /(?:^|[\\/])?\.env(?:\.|\*|$)/i.test(pattern))) {
			return "Credential dotenv files are model-blind. Use secret_store discover instead of searching their contents.";
		}
	}
	if (toolName === "run_process") {
		const executable = typeof args.executable === "string" ? args.executable : undefined;
		const processArgs = Array.isArray(args.args)
			? args.args.filter((argument): argument is string => typeof argument === "string")
			: [];
		const processRisk = executable ? runProcessCredentialRisk(executable, processArgs, paths) : undefined;
		if (processRisk === "broad_search") {
			return "Credential-safe shell search requires a narrow non-dotenv file glob (for example -g '*.ts') or one explicit regular file. Refine the rg/grep command before retrying.";
		}
		if (processRisk === "process_environment") {
			return "Direct process-environment projection is blocked because it can expose credentials. Use secret_store discover to list eligible source names without exposing values.";
		}
		if (processRisk === "credential_path") {
			return "Direct shell inspection of credential files is blocked. Use secret_store migrate with the file path, then run the credential-consuming command normally.";
		}
	}
	if (toolName === "bash" || toolName === "powershell") {
		const command = typeof args.command === "string" ? args.command : "";
		const shellRisk = shellCredentialRisk(command, paths);
		if (shellRisk === "broad_search") {
			return "Credential-safe shell search requires a narrow non-dotenv file glob (for example -g '*.ts') or one explicit regular file. Refine the rg/grep command before retrying.";
		}
		if (shellRisk === "process_environment") {
			return "Direct process-environment projection is blocked because it can expose credentials. Use secret_store discover to list eligible source names without exposing values.";
		}
		if (SHELL_SECRET_READ_RE.test(command) || shellRisk === "credential_path") {
			return "Direct shell inspection of credential files is blocked. Use secret_store migrate with the file path, then run the credential-consuming command normally.";
		}
	}
	if (toolName === "python") {
		const code = typeof args.code === "string" ? args.code : "";
		const scriptPath = typeof args.scriptPath === "string" ? args.scriptPath : undefined;
		if (
			PYTHON_SECRET_READ_RE.test(code) ||
			pythonInspectsCredentialPath(code, paths) ||
			(scriptPath !== undefined && paths.isProtected(scriptPath))
		) {
			return "Direct Python inspection of credential files is blocked. Use secret_store migrate with the file path, then run the credential-consuming program normally.";
		}
	}
	return undefined;
}

function redactResult<T>(result: AgentToolResult<T>, boundary?: CredentialExposureBoundary): AgentToolResult<T> {
	const redact = (text: string) => (boundary ? boundary.redactSensitiveText(text) : redactKnownSecrets(text));
	const budget = { nodes: 0 };
	return {
		...result,
		content: result.content.map((block) => (block.type === "text" ? { ...block, text: redact(block.text) } : block)),
		details: redactStructuredDetails(result.details, redact, budget) as T,
	};
}

function redactStructuredDetails(
	value: unknown,
	redact: (text: string) => string,
	budget: { nodes: number },
	depth = 0,
): unknown {
	if (typeof value === "string") return redact(value);
	if (value === null || typeof value !== "object") return value;
	budget.nodes++;
	if (depth >= MAX_REDACTED_DETAIL_DEPTH || budget.nodes > MAX_REDACTED_DETAIL_NODES) {
		return "[DETAIL OMITTED AT CREDENTIAL BOUNDARY]";
	}
	if (Array.isArray(value)) {
		return value.map((entry) => redactStructuredDetails(entry, redact, budget, depth + 1));
	}
	let prototype: object | null;
	try {
		prototype = Object.getPrototypeOf(value);
	} catch {
		return "[UNREADABLE DETAIL OMITTED AT CREDENTIAL BOUNDARY]";
	}
	if (prototype !== Object.prototype && prototype !== null) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, redactStructuredDetails(entry, redact, budget, depth + 1)]),
	);
}

/** Apply the same path refusal and output redaction to foreground, extension, scout, and lane tools. */
export function wrapToolWithCredentialExposureGuard<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
	cwd: string,
	boundary?: CredentialExposureBoundary,
): AgentTool<TParameters, TDetails> {
	return wrapToolExecution(tool, (executor, executionContext) => ({
		...executor,
		failureRecovery: {
			...executor.failureRecovery,
			getFailureCorrection(params, failure) {
				if (failure.failureCode === "credential_access_blocked") return failure.message;
				return executor.failureRecovery?.getFailureCorrection?.(params, failure);
			},
		},
		async execute(toolCallId, params, signal, onUpdate) {
			const safeUpdate = onUpdate
				? (partial: AgentToolResult<TDetails>) => {
						onUpdate(redactResult(partial, boundary));
					}
				: undefined;
			try {
				signal?.throwIfAborted();
				const blockReason = credentialToolBlockReason(tool.name, params, cwd, boundary, executionContext);
				if (blockReason) {
					throw new AgentToolExecutionError(
						blockReason,
						"credential_access_blocked",
						"credential-access-blocked",
						"tool_failure",
					);
				}
				signal?.throwIfAborted();
				return redactResult(await executor.execute(toolCallId, params, signal, safeUpdate), boundary);
			} catch (error) {
				if (error instanceof Error) {
					const message = boundary
						? boundary.redactSensitiveText(error.message)
						: redactKnownSecrets(error.message);
					if (error instanceof AgentToolExecutionError) {
						throw new AgentToolExecutionError(message, error.failureCode, error.outputSignature, error.errorKind);
					}
					throw new Error(message);
				}
				throw new Error("Credential-safe tool execution failed without retaining raw error output.");
			}
		},
	}));
}
