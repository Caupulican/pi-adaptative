import {
	type AgentTool,
	AgentToolExecutionError,
	type AgentToolResult,
	type ExecutionContext,
	type ExecutionPathAuthority,
} from "@caupulican/pi-agent-core";
import type { TSchema } from "typebox";
import { extractToolPathArguments } from "../autonomy/envelope-enforcement.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { parseShellSearchInvocationScope, type ShellContentSearchTool } from "../tools/search-command-guard.ts";
import { type ShellToken, tokenizeShellCommand } from "../tools/shell-command-parser.ts";
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
	executionContext?: ExecutionContext,
	pathAuthority?: ExecutionPathAuthority,
): boolean {
	return createCredentialPathPolicy(
		cwd,
		boundary,
		executionContext,
		boundary?.getPathProbe?.(executionContext),
		pathAuthority,
	).isProtected(rawPath);
}

export async function isProtectedCredentialPathAsync(
	rawPath: string,
	cwd: string,
	boundary?: CredentialExposureBoundary,
	executionContext?: ExecutionContext,
	pathAuthority?: ExecutionPathAuthority,
	signal?: AbortSignal,
): Promise<boolean> {
	return createCredentialPathPolicy(
		cwd,
		boundary,
		executionContext,
		boundary?.getPathProbe?.(executionContext),
		pathAuthority,
	).isProtectedAsync(rawPath, signal);
}

interface ShellInvocationSegment {
	invocation: string[];
	readsPipe: boolean;
}

function parseShellInvocations(tokens: readonly ShellToken[]): ShellInvocationSegment[] {
	const segments: ShellInvocationSegment[] = [];
	let invocation: string[] = [];
	let skipRedirectTarget = false;
	let readsPipe = false;
	for (const token of tokens) {
		if (token.kind === "arg") {
			if (skipRedirectTarget) skipRedirectTarget = false;
			else invocation.push(token.value);
			continue;
		}
		if (token.kind === "redirect") {
			skipRedirectTarget = !/^\d*[<>]&[\d-]+$/u.test(token.value);
			continue;
		}
		if (invocation.length > 0) segments.push({ invocation, readsPipe });
		invocation = [];
		skipRedirectTarget = false;
		readsPipe = token.kind === "pipe";
	}
	if (invocation.length > 0) segments.push({ invocation, readsPipe });
	return segments;
}

function extractFallbackSearchLines(command: string): string[] {
	const lines: string[] = [];
	for (const line of command.split(/\r?\n/u)) {
		const trimmed = line.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/u, "");
		if (/^(?:rg|ripgrep|grep)\b/iu.test(trimmed)) lines.push(trimmed);
	}
	return lines;
}

function inspectToolCredentialRisk(
	toolName: string,
	args: readonly string[],
): { searchTool?: ShellContentSearchTool; risk?: "process_environment" } {
	if (toolName === "jq") {
		const filter = jqFilterFromArgs([...args]);
		if (filter && jqFilterReadsProcessEnvironment(filter)) return { risk: "process_environment" };
	}
	const searchTool: ShellContentSearchTool | undefined =
		toolName === "rg" || toolName === "ripgrep" ? "rg" : toolName === "grep" ? "grep" : undefined;
	return { searchTool };
}

function hasProtectedArgumentToken(args: readonly string[], paths: CredentialPathPolicy): boolean {
	return args.some((token) =>
		Boolean(token && !token.startsWith("-") && token !== "." && paths.isProtectedToken(token)),
	);
}

async function hasProtectedArgumentTokenAsync(
	args: readonly string[],
	paths: CredentialPathPolicy,
	signal?: AbortSignal,
): Promise<boolean> {
	for (const token of args) {
		signal?.throwIfAborted();
		if (token && !token.startsWith("-") && token !== "." && (await paths.isProtectedTokenAsync(token, signal))) {
			return true;
		}
	}
	return false;
}

interface ParsedInvocationCommand {
	args: string[];
	searchTool?: ShellContentSearchTool;
	envRisk?: "process_environment";
	isInspectionCommand: boolean;
}

function parseInvocationCommand(invocation: readonly string[], index: number): ParsedInvocationCommand {
	const toolName = (invocation[index].split(/[\\/]/u).at(-1) ?? "").toLowerCase().replace(/\.exe$/u, "");
	const args = invocation.slice(index + 1);
	const inspected = inspectToolCredentialRisk(toolName, args);
	return {
		args,
		searchTool: inspected.searchTool,
		envRisk: inspected.risk,
		isInspectionCommand: SHELL_INSPECTION_COMMANDS.has(toolName),
	};
}

function shellCredentialRisk(
	command: string,
	paths: CredentialPathPolicy,
): "broad_search" | "credential_path" | "process_environment" | undefined {
	const shellTokens = tokenizeShellCommand(command);
	if (!shellTokens) {
		for (const trimmed of extractFallbackSearchLines(command)) {
			const lineTokens = tokenizeShellCommand(trimmed);
			if (!lineTokens) continue;
			const risk = shellCredentialRisk(trimmed, paths);
			if (risk) return risk;
		}
		return undefined;
	}

	for (const segment of parseShellInvocations(shellTokens)) {
		for (let i = 0; i < segment.invocation.length; i++) {
			const cmd = parseInvocationCommand(segment.invocation, i);
			if (cmd.envRisk) return cmd.envRisk;
			if (!cmd.isInspectionCommand) continue;
			if (cmd.searchTool) {
				const searchRisk = searchCredentialRisk(cmd.searchTool, cmd.args, segment.readsPipe, paths, true);
				if (searchRisk) return searchRisk;
				continue;
			}
			if (hasProtectedArgumentToken(cmd.args, paths)) return "credential_path";
		}
	}
	return undefined;
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
	if (/^[A-Za-z0-9_][A-Za-z0-9_.-]{2,}\*$/u.test(filePattern) && !/\.env/i.test(filePattern)) return true;
	const braceSuffixes = filePattern.match(/\.\{([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)+)\}$/)?.[1];
	const suffixes = braceSuffixes
		? braceSuffixes.split(",").map((suffix) => suffix.toLowerCase())
		: [filePattern.match(/\.([A-Za-z0-9_-]+)$/)?.[1]?.toLowerCase()].filter(
				(suffix): suffix is string => suffix !== undefined,
			);
	return suffixes.length > 0 && suffixes.every((suffix) => suffix !== "env");
}

function resolveExplicitFileSafety(isFileResult: boolean | undefined, rawPath: string, allowMissing: boolean): boolean {
	return isFileResult ?? (allowMissing && isCredentialSafeGlob(rawPath));
}

function isCredentialSafeExplicitFile(rawPath: string, paths: CredentialPathPolicy, allowMissing: boolean): boolean {
	try {
		return resolveExplicitFileSafety(paths.isFile(rawPath), rawPath, allowMissing);
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
		return allowMissing && isCredentialSafeGlob(rawPath);
	}
}

async function isCredentialSafeExplicitFileAsync(
	rawPath: string,
	paths: CredentialPathPolicy,
	allowMissing: boolean,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		return resolveExplicitFileSafety(await paths.isFileAsync(rawPath, signal), rawPath, allowMissing);
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
		return allowMissing && isCredentialSafeGlob(rawPath);
	}
}

function isBroadSearchScope(
	scope: { metaOnly: boolean; readsStdin: boolean; positiveGlobs: readonly string[] },
	hasOnlyExplicitFiles: boolean,
): boolean {
	const hasSafeGlob = scope.positiveGlobs.length > 0 && scope.positiveGlobs.every(isCredentialSafeGlob);
	return !scope.metaOnly && !scope.readsStdin && !hasSafeGlob && !hasOnlyExplicitFiles;
}

function isCommandLineExplicitOperand(
	target: string,
	commandLineOperands: boolean,
	allowShellVariables: boolean,
): boolean {
	return (
		(commandLineOperands && target === "-") ||
		(allowShellVariables && /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/u.test(target))
	);
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

async function searchCredentialRiskAsync(
	searchTool: ShellContentSearchTool,
	args: readonly string[],
	readsPipe: boolean,
	paths: CredentialPathPolicy,
	allowShellVariables: boolean,
	signal?: AbortSignal,
): Promise<"broad_search" | "credential_path" | undefined> {
	const scope = parseShellSearchInvocationScope(searchTool, [...args], readsPipe);
	return contentSearchCredentialRiskAsync(scope, paths, true, allowShellVariables, signal);
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
	const hasOnlyExplicitFiles =
		scope.targets.length > 0 &&
		scope.targets.every(
			(target) =>
				isCommandLineExplicitOperand(target, commandLineOperands, allowShellVariables) ||
				isCredentialSafeExplicitFile(target, paths, commandLineOperands) ||
				paths.isHarnessOwnedSearchTarget(target),
		);
	if (isBroadSearchScope(scope, hasOnlyExplicitFiles)) return "broad_search";
	return undefined;
}

async function contentSearchCredentialRiskAsync(
	scope: { targets: readonly string[]; positiveGlobs: readonly string[]; metaOnly: boolean; readsStdin: boolean },
	paths: CredentialPathPolicy,
	commandLineOperands: boolean,
	allowShellVariables: boolean,
	signal?: AbortSignal,
): Promise<"broad_search" | "credential_path" | undefined> {
	for (const target of scope.targets) {
		signal?.throwIfAborted();
		if (target !== "-" && (await paths.isProtectedAsync(target, signal))) {
			return "credential_path";
		}
	}
	let hasOnlyExplicitFiles = scope.targets.length > 0;
	if (hasOnlyExplicitFiles) {
		for (const target of scope.targets) {
			signal?.throwIfAborted();
			const isExplicit =
				isCommandLineExplicitOperand(target, commandLineOperands, allowShellVariables) ||
				(await isCredentialSafeExplicitFileAsync(target, paths, commandLineOperands, signal)) ||
				paths.isHarnessOwnedSearchTarget(target);
			if (!isExplicit) {
				hasOnlyExplicitFiles = false;
				break;
			}
		}
	}
	if (isBroadSearchScope(scope, hasOnlyExplicitFiles)) return "broad_search";
	return undefined;
}

function pythonInspectsCredentialPath(code: string, paths: CredentialPathPolicy): boolean {
	if (!PYTHON_INSPECTION_RE.test(code)) return false;
	QUOTED_TEXT_RE.lastIndex = 0;
	for (const match of code.matchAll(QUOTED_TEXT_RE)) {
		if (/^\s+(?:not\s+)?in\b/u.test(code.slice(match.index + match[0].length))) continue;
		const candidate = match[2]?.replace(/\\([\\"'])/g, "$1");
		if (candidate && paths.isProtectedToken(candidate)) return true;
	}
	return false;
}

async function pythonInspectsCredentialPathAsync(
	code: string,
	paths: CredentialPathPolicy,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!PYTHON_INSPECTION_RE.test(code)) return false;
	QUOTED_TEXT_RE.lastIndex = 0;
	for (const match of code.matchAll(QUOTED_TEXT_RE)) {
		signal?.throwIfAborted();
		if (/^\s+(?:not\s+)?in\b/u.test(code.slice(match.index + match[0].length))) continue;
		const candidate = match[2]?.replace(/\\([\\"'])/g, "$1");
		if (candidate && (await paths.isProtectedTokenAsync(candidate, signal))) return true;
	}
	return false;
}

async function shellCredentialRiskAsync(
	command: string,
	paths: CredentialPathPolicy,
	signal?: AbortSignal,
): Promise<"broad_search" | "credential_path" | "process_environment" | undefined> {
	const shellTokens = tokenizeShellCommand(command);
	if (!shellTokens) {
		for (const trimmed of extractFallbackSearchLines(command)) {
			const lineTokens = tokenizeShellCommand(trimmed);
			if (!lineTokens) continue;
			const risk = await shellCredentialRiskAsync(trimmed, paths, signal);
			if (risk) return risk;
		}
		return undefined;
	}

	for (const segment of parseShellInvocations(shellTokens)) {
		for (let i = 0; i < segment.invocation.length; i++) {
			signal?.throwIfAborted();
			const cmd = parseInvocationCommand(segment.invocation, i);
			if (cmd.envRisk) return cmd.envRisk;
			if (!cmd.isInspectionCommand) continue;
			if (cmd.searchTool) {
				const searchRisk = await searchCredentialRiskAsync(
					cmd.searchTool,
					cmd.args,
					segment.readsPipe,
					paths,
					true,
					signal,
				);
				if (searchRisk) return searchRisk;
				continue;
			}
			if (await hasProtectedArgumentTokenAsync(cmd.args, paths, signal)) return "credential_path";
		}
	}
	return undefined;
}

function runProcessCredentialRisk(
	executable: string,
	args: readonly string[],
	paths: CredentialPathPolicy,
): "broad_search" | "credential_path" | "process_environment" | undefined {
	if (paths.isProtected(executable)) return "credential_path";
	if (args.some((argument) => paths.isProtectedToken(argument))) return "credential_path";

	const inspected = inspectToolCredentialRisk(paths.executableName(executable), args);
	if (inspected.risk) return inspected.risk;
	if (!inspected.searchTool) return undefined;
	return searchCredentialRisk(inspected.searchTool, args, false, paths, false);
}

async function runProcessCredentialRiskAsync(
	executable: string,
	args: readonly string[],
	paths: CredentialPathPolicy,
	signal?: AbortSignal,
): Promise<"broad_search" | "credential_path" | "process_environment" | undefined> {
	signal?.throwIfAborted();
	if (await paths.isProtectedAsync(executable, signal)) return "credential_path";
	for (const argument of args) {
		signal?.throwIfAborted();
		if (await paths.isProtectedTokenAsync(argument, signal)) return "credential_path";
	}

	const inspected = inspectToolCredentialRisk(paths.executableName(executable), args);
	if (inspected.risk) return inspected.risk;
	if (!inspected.searchTool) return undefined;
	return searchCredentialRiskAsync(inspected.searchTool, args, false, paths, false, signal);
}

const CREDENTIAL_BLOCK_REASONS = {
	fileBlind:
		"Credential file access is model-blind. Use secret_store migrate with this path, or activate an existing profile, without inspecting credential data.",
	dotenvBlind:
		"Credential dotenv files are model-blind. Use secret_store discover instead of searching their contents.",
	grepFileRequired:
		"Credential-safe grep requires one explicit regular file or a narrow non-dotenv file glob (for example *.ts). Refine the search instead of scanning a directory without a file filter.",
	shellSearchRequired:
		"Credential-safe shell search requires a narrow non-dotenv file glob (for example -g '*.ts') or one explicit regular file. Refine the rg/grep command before retrying.",
	processEnvBlocked:
		"Direct process-environment projection is blocked because it can expose credentials. Use secret_store discover to list eligible source names without exposing values.",
	shellInspectionBlocked:
		"Direct shell inspection of credential files is blocked. Use secret_store migrate with the file path, then run the credential-consuming command normally.",
	pythonInspectionBlocked:
		"Direct Python inspection of credential files is blocked. Use secret_store migrate with the file path, then run the credential-consuming program normally.",
} as const;

function evaluateShellOrProcessRisk(
	risk: "broad_search" | "credential_path" | "process_environment" | undefined,
	extraDirectBlock = false,
): string | undefined {
	if (risk === "broad_search") return CREDENTIAL_BLOCK_REASONS.shellSearchRequired;
	if (risk === "process_environment") return CREDENTIAL_BLOCK_REASONS.processEnvBlocked;
	if (risk === "credential_path" || extraDirectBlock) return CREDENTIAL_BLOCK_REASONS.shellInspectionBlocked;
	return undefined;
}

function evaluateGrepRisk(risk: "broad_search" | "credential_path" | undefined, glob?: string): string | undefined {
	if (risk === "credential_path" || (glob && /(?:^|[\\/])?\.env(?:\.|\*|$)/i.test(glob))) {
		return CREDENTIAL_BLOCK_REASONS.dotenvBlind;
	}
	if (risk === "broad_search") {
		return CREDENTIAL_BLOCK_REASONS.grepFileRequired;
	}
	return undefined;
}

function evaluateFindRisk(pathIsProtected: boolean, pattern?: string): string | undefined {
	if (pathIsProtected || (pattern && /(?:^|[\\/])?\.env(?:\.|\*|$)/i.test(pattern))) {
		return CREDENTIAL_BLOCK_REASONS.dotenvBlind;
	}
	return undefined;
}

export function credentialToolBlockReason(
	toolName: string,
	args: unknown,
	cwd: string,
	boundary?: CredentialExposureBoundary,
	executionContext?: ExecutionContext,
	pathAuthority?: ExecutionPathAuthority,
): string | undefined {
	if (toolName === "secret_store" || !isRecord(args)) return undefined;
	const paths = createCredentialPathPolicy(
		cwd,
		boundary,
		executionContext,
		boundary?.getPathProbe?.(executionContext),
		pathAuthority,
	);
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
		case "patch":
			return extractToolPathArguments(toolName, args).some((p) => paths.isProtected(p))
				? CREDENTIAL_BLOCK_REASONS.fileBlind
				: undefined;
		case "grep": {
			const target = typeof args.path === "string" ? args.path : undefined;
			const patternGlob = typeof args.glob === "string" ? args.glob : undefined;
			const risk = contentSearchCredentialRisk(
				{
					targets: target ? [target] : [],
					positiveGlobs: patternGlob ? [patternGlob] : [],
					metaOnly: false,
					readsStdin: false,
				},
				paths,
				false,
				false,
			);
			return evaluateGrepRisk(risk, patternGlob);
		}
		case "find": {
			const target = typeof args.path === "string" ? args.path : undefined;
			const pat = typeof args.pattern === "string" ? args.pattern : undefined;
			return evaluateFindRisk(Boolean(target && paths.isProtected(target)), pat);
		}
		case "run_process": {
			const bin = typeof args.executable === "string" ? args.executable : undefined;
			const argv = Array.isArray(args.args)
				? args.args.filter((item): item is string => typeof item === "string")
				: [];
			return evaluateShellOrProcessRisk(bin ? runProcessCredentialRisk(bin, argv, paths) : undefined);
		}
		case "bash":
		case "powershell": {
			const script = typeof args.command === "string" ? args.command : "";
			return evaluateShellOrProcessRisk(shellCredentialRisk(script, paths), SHELL_SECRET_READ_RE.test(script));
		}
		case "python": {
			const src = typeof args.code === "string" ? args.code : "";
			const file = typeof args.scriptPath === "string" ? args.scriptPath : undefined;
			if (
				PYTHON_SECRET_READ_RE.test(src) ||
				pythonInspectsCredentialPath(src, paths) ||
				(file && paths.isProtected(file))
			) {
				return CREDENTIAL_BLOCK_REASONS.pythonInspectionBlocked;
			}
			return undefined;
		}
		default:
			if (DIRECT_PATH_TOOLS.has(toolName)) {
				return extractToolPathArguments(toolName, args).some((p) => paths.isProtected(p))
					? CREDENTIAL_BLOCK_REASONS.fileBlind
					: undefined;
			}
			return undefined;
	}
}

export async function credentialToolBlockReasonAsync(
	toolName: string,
	args: unknown,
	cwd: string,
	boundary?: CredentialExposureBoundary,
	executionContext?: ExecutionContext,
	pathAuthority?: ExecutionPathAuthority,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (toolName === "secret_store" || !isRecord(args)) return undefined;
	signal?.throwIfAborted();
	const paths = createCredentialPathPolicy(
		cwd,
		boundary,
		executionContext,
		boundary?.getPathProbe?.(executionContext),
		pathAuthority,
	);
	if (DIRECT_PATH_TOOLS.has(toolName)) {
		for (const path of extractToolPathArguments(toolName, args)) {
			signal?.throwIfAborted();
			if (await paths.isProtectedAsync(path, signal)) {
				return CREDENTIAL_BLOCK_REASONS.fileBlind;
			}
		}
	}
	if (toolName === "grep") {
		const path = typeof args.path === "string" ? args.path : undefined;
		const glob = typeof args.glob === "string" ? args.glob : undefined;
		const risk = await contentSearchCredentialRiskAsync(
			{ targets: path ? [path] : [], positiveGlobs: glob ? [glob] : [], metaOnly: false, readsStdin: false },
			paths,
			false,
			false,
			signal,
		);
		return evaluateGrepRisk(risk, glob);
	}
	if (toolName === "find") {
		const path = typeof args.path === "string" ? args.path : undefined;
		const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
		const isProt = Boolean(path && (await paths.isProtectedAsync(path, signal)));
		return evaluateFindRisk(isProt, pattern);
	}
	if (toolName === "run_process") {
		const executable = typeof args.executable === "string" ? args.executable : undefined;
		const processArgs = Array.isArray(args.args)
			? args.args.filter((argument): argument is string => typeof argument === "string")
			: [];
		const processRisk = executable
			? await runProcessCredentialRiskAsync(executable, processArgs, paths, signal)
			: undefined;
		return evaluateShellOrProcessRisk(processRisk);
	}
	if (toolName === "bash" || toolName === "powershell") {
		const command = typeof args.command === "string" ? args.command : "";
		const shellRisk = await shellCredentialRiskAsync(command, paths, signal);
		return evaluateShellOrProcessRisk(shellRisk, SHELL_SECRET_READ_RE.test(command));
	}
	if (toolName === "python") {
		const code = typeof args.code === "string" ? args.code : "";
		const scriptPath = typeof args.scriptPath === "string" ? args.scriptPath : undefined;
		if (
			PYTHON_SECRET_READ_RE.test(code) ||
			(await pythonInspectsCredentialPathAsync(code, paths, signal)) ||
			(scriptPath !== undefined && (await paths.isProtectedAsync(scriptPath, signal)))
		) {
			return CREDENTIAL_BLOCK_REASONS.pythonInspectionBlocked;
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
	return wrapToolExecution(tool, (executor, executionContext, pathAuthority) => ({
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
				const blockReason = await credentialToolBlockReasonAsync(
					tool.name,
					params,
					cwd,
					boundary,
					executionContext,
					pathAuthority,
					signal,
				);
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
