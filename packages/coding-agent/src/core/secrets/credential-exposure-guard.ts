import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@caupulican/pi-agent-core";
import type { TSchema } from "typebox";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { parseShellSearchInvocationScope, type ShellContentSearchTool } from "../tools/search-command-guard.ts";
import { tokenizeShellCommand } from "../tools/shell-command-parser.ts";
import type { SecretVault } from "./secret-vault.ts";

const DIRECT_PATH_TOOLS = new Set(["read", "edit", "write", "ls"]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

export function isProtectedCredentialPath(rawPath: string, cwd: string, vault?: SecretVault): boolean {
	const resolved = resolve(cwd, rawPath);
	const candidates = [resolved];
	try {
		const canonical = realpathSync.native(resolved);
		if (canonical !== resolved) candidates.push(canonical);
	} catch {
		// Nonexistent write targets still receive the lexical filename check.
	}
	const vaultPaths = vault ? [resolve(vault.vaultPath)] : [];
	const materializedRoots = vault ? [resolve(vault.materializedDir)] : [];
	if (vault) {
		try {
			vaultPaths.push(realpathSync.native(vault.vaultPath));
		} catch {
			// A not-yet-created vault still retains its lexical protected path.
		}
		try {
			materializedRoots.push(realpathSync.native(vault.materializedDir));
		} catch {
			// A not-yet-created materialization directory still retains its lexical protected root.
		}
	}
	return candidates.some((candidate) => {
		if (vault && (vaultPaths.includes(candidate) || materializedRoots.some((root) => isInside(root, candidate)))) {
			return true;
		}
		const fileName = basename(candidate);
		return fileName === ".env" || fileName.startsWith(".env.") || fileName.endsWith(".env");
	});
}

function shellCredentialRisk(
	command: string,
	cwd: string,
	vault?: SecretVault,
): "broad_search" | "credential_path" | "process_environment" | undefined {
	const shellTokens = tokenizeShellCommand(command);
	if (!shellTokens) return /\b(?:grep|rg)\b/iu.test(command) ? "broad_search" : undefined;

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
				const scope = parseShellSearchInvocationScope(searchTool, args, readsPipe);
				if (scope.targets.some((target) => target !== "-" && isProtectedCredentialPath(target, cwd, vault))) {
					return "credential_path";
				}
				const hasSafeGlob =
					scope.positiveGlobs.length > 0 && scope.positiveGlobs.every((glob) => isCredentialSafeGlob(glob));
				const hasOnlyExplicitFiles =
					scope.targets.length > 0 &&
					scope.targets.every((target) => target === "-" || isExistingRegularFile(target, cwd));
				if (!scope.metaOnly && !scope.readsStdin && !hasSafeGlob && !hasOnlyExplicitFiles) return "broad_search";
				continue;
			}
			for (const token of args) {
				if (!token || token.startsWith("-") || token === ".") continue;
				if (isProtectedCredentialPath(token, cwd, vault)) return "credential_path";
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
	const suffix = filePattern.match(/\.([A-Za-z0-9_-]+)$/)?.[1]?.toLowerCase();
	return suffix !== undefined && suffix !== "env";
}

function isExistingRegularFile(rawPath: string, cwd: string): boolean {
	try {
		return statSync(resolve(cwd, rawPath)).isFile();
	} catch {
		return false;
	}
}

function pythonInspectsCredentialPath(code: string, cwd: string, vault?: SecretVault): boolean {
	if (!PYTHON_INSPECTION_RE.test(code)) return false;
	QUOTED_TEXT_RE.lastIndex = 0;
	for (const match of code.matchAll(QUOTED_TEXT_RE)) {
		const candidate = match[2]?.replace(/\\([\\"'])/g, "$1");
		if (candidate && isProtectedCredentialPath(candidate, cwd, vault)) return true;
	}
	return false;
}

function directPathFromArgs(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	return typeof args.path === "string" ? args.path : undefined;
}

/** Stable model-facing refusal for direct inspection/mutation of credential material. */
export function credentialToolBlockReason(
	toolName: string,
	args: unknown,
	cwd: string,
	vault?: SecretVault,
): string | undefined {
	if (toolName === "secret_store" || !isRecord(args)) return undefined;
	if (DIRECT_PATH_TOOLS.has(toolName)) {
		const path = directPathFromArgs(args);
		if (path && isProtectedCredentialPath(path, cwd, vault)) {
			return "Credential file access is model-blind. Use secret_store to edit or materialize the bound profile, then run the consuming application without inspecting the dotenv file.";
		}
	}
	if (toolName === "grep") {
		const path = typeof args.path === "string" ? args.path : undefined;
		const glob = typeof args.glob === "string" ? args.glob : undefined;
		if (
			(path && isProtectedCredentialPath(path, cwd, vault)) ||
			(glob && /(?:^|[\\/])?\.env(?:\.|\*|$)/i.test(glob))
		) {
			return "Credential dotenv files are excluded from model-facing search. Use secret_store metadata instead.";
		}
		if (!(path && isExistingRegularFile(path, cwd)) && !(glob && isCredentialSafeGlob(glob))) {
			return "Credential-safe grep requires one explicit regular file or a narrow non-dotenv file glob (for example *.ts). Refine the search instead of scanning a directory without a file filter.";
		}
	}
	if (toolName === "find") {
		const path = typeof args.path === "string" ? args.path : undefined;
		const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
		if (
			(path && isProtectedCredentialPath(path, cwd, vault)) ||
			(pattern && /(?:^|[\\/])?\.env(?:\.|\*|$)/i.test(pattern))
		) {
			return "Credential dotenv files are excluded from model-facing discovery. Use secret_store list instead.";
		}
	}
	if (toolName === "bash" || toolName === "powershell" || toolName === "run_process") {
		const command = typeof args.command === "string" ? args.command : "";
		const shellRisk = shellCredentialRisk(command, cwd, vault);
		if (shellRisk === "broad_search") {
			return "Credential-safe shell search requires a narrow non-dotenv file glob (for example -g '*.ts') or one explicit regular file. Refine the rg/grep command before retrying.";
		}
		if (shellRisk === "process_environment") {
			return "Direct jq projection of the process environment is blocked because it can expose credentials. Query bounded JSON inputs instead.";
		}
		if (SHELL_SECRET_READ_RE.test(command) || shellRisk === "credential_path") {
			return "Direct shell inspection of credential dotenv files is blocked. Use secret_store, then run the credential-consuming command normally.";
		}
	}
	if (toolName === "python") {
		const code = typeof args.code === "string" ? args.code : "";
		const scriptPath = typeof args.scriptPath === "string" ? args.scriptPath : undefined;
		if (
			PYTHON_SECRET_READ_RE.test(code) ||
			pythonInspectsCredentialPath(code, cwd, vault) ||
			(scriptPath !== undefined && isProtectedCredentialPath(scriptPath, cwd, vault))
		) {
			return "Direct Python inspection of credential dotenv files is blocked. Use secret_store, then run the credential-consuming program normally.";
		}
	}
	return undefined;
}

function redactResult<T>(result: AgentToolResult<T>, vault?: SecretVault): AgentToolResult<T> {
	const redact = (text: string) => (vault ? vault.redactSensitiveText(text) : redactKnownSecrets(text));
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
	vault?: SecretVault,
): AgentTool<TParameters, TDetails> {
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate) {
			const refusal = credentialToolBlockReason(tool.name, params, cwd, vault);
			if (refusal) throw new Error(refusal);
			const safeUpdate = onUpdate
				? (partial: AgentToolResult<TDetails>) => {
						onUpdate(redactResult(partial, vault));
					}
				: undefined;
			try {
				return redactResult(await tool.execute(toolCallId, params, signal, safeUpdate), vault);
			} catch (error) {
				if (error instanceof Error) {
					throw new Error(vault ? vault.redactSensitiveText(error.message) : redactKnownSecrets(error.message));
				}
				throw new Error("Credential-safe tool execution failed without retaining raw error output.");
			}
		},
	};
}
