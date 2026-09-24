import type { Api, Model } from "@caupulican/pi-ai";
import type { ModelTier } from "../autonomy/contracts.ts";
import { isLocalExecutionModel } from "../background-lane-controller.ts";
import { HF_TRANSFORMERS_PROVIDER, OLLAMA_PROVIDER } from "../models/local-registration.ts";
import { isPiManagedPrismLlamaCppModel } from "../models/prism-llamacpp-lifecycle.ts";

/**
 * True for a model the capability-gate spine treats as LOCAL/MANAGED — never cloud.
 * Shared by agent-session.ts's validation-escalation branch and model-router-controller.ts's
 * tier-resolution verdict consultation so there is exactly one place composing this
 * predicate, instead of two divergent copies. Reuses {@link isLocalExecutionModel} (any
 * ollama/transformers/llama-cpp provider, or a localhost-family baseUrl) OR'd with the same
 * provider/managed-prism check `LocalRuntimeController.isManagedLocalModel` uses internally — built
 * from the identical exported provider constants ({@link OLLAMA_PROVIDER}, {@link
 * HF_TRANSFORMERS_PROVIDER}) and {@link isPiManagedPrismLlamaCppModel}, so there is no second,
 * drifting definition of "is this ollama/transformers/pi-managed-prism" (that method itself is
 * private to LocalRuntimeController, which this module does not own/import). A cloud model (a
 * known-capable provider on a non-local baseUrl) always returns false.
 */
export function isLocalOrManagedRouterModel(model: Model<Api>): boolean {
	return (
		isLocalExecutionModel(model) ||
		model.provider === OLLAMA_PROVIDER ||
		model.provider === HF_TRANSFORMERS_PROVIDER ||
		isPiManagedPrismLlamaCppModel(model)
	);
}

const READ_ONLY_TOOL_NAMES = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"list",
	"search",
	"glob",
	"view_file",
	"list_dir",
	"grep_search",
	"search_web",
	"read_url_content",
	"read_browser_page",
]);

const SHELL_TOOL_NAMES = new Set(["bash", "powershell", "exec", "execute", "run", "run_command", "shell"]);

const READ_ONLY_COMMANDS = new Set([
	"awk",
	"cat",
	"date",
	"df",
	"du",
	"env",
	"format-list",
	"format-table",
	"get-childitem",
	"get-command",
	"get-content",
	"get-item",
	"get-location",
	"get-process",
	"git",
	"grep",
	"head",
	"jq",
	"ls",
	"node",
	"npm",
	"pnpm",
	"pwd",
	"resolve-path",
	"rg",
	"sed",
	"select-object",
	"select-string",
	"tail",
	"test",
	"test-path",
	"tsc",
	"wc",
	"where-object",
	"which",
	"write-output",
	"yarn",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set(["branch", "diff", "log", "rev-parse", "show", "status", "tag"]);
const READ_ONLY_NPM_SUBCOMMANDS = new Set(["info", "list", "ls", "outdated", "view", "whoami"]);
const MUTATING_SHELL_TOKEN_RE =
	/(^|\s)(>|>>|2>|&>|tee\b|rm\b|mv\b|cp\b|mkdir\b|touch\b|chmod\b|chown\b|install\b|commit\b|push\b|publish\b|deploy\b|apply\b|add\b|checkout\b|switch\b|reset\b|clean\b|stash\b|merge\b|rebase\b|remove-item\b|move-item\b|copy-item\b|new-item\b|rename-item\b|set-content\b|add-content\b|out-file\b|set-item\b|start-process\b|npm\s+(?:i|install|ci|update|publish|run)\b|pnpm\s+(?:i|install|update|publish|run)\b|yarn\s+(?:add|install|upgrade|publish|run)\b)/i;
const UNSAFE_NESTED_SHELL_EXECUTION_RE = /(`|\$\(|\bfind\b[\s\S]*\s-exec(?:dir)?\b|\bxargs\b)/i;
const MUTATING_TOOL_NAME_RE =
	/(bash|powershell|exec|execute|run|shell|write|edit|patch|replace|delete|remove|move|rename|create|mkdir|touch|install|commit|push|publish|deploy|apply)/i;

function getShellCommand(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	const command = record.command ?? record.cmd ?? record.shellCommand;
	return typeof command === "string" ? command.trim() : undefined;
}

function commandName(segment: string): string | undefined {
	const first = segment.trim().match(/^[A-Za-z0-9_./-]+/)?.[0];
	if (!first) return undefined;
	const parts = first.split("/");
	return parts[parts.length - 1]?.toLowerCase();
}

function commandArg(segment: string, index: number): string | undefined {
	return segment.trim().split(/\s+/)[index]?.toLowerCase();
}

function isReadOnlyShellSegment(segment: string): boolean {
	const name = commandName(segment);
	if (!name || !READ_ONLY_COMMANDS.has(name)) return false;
	if (name === "git") {
		const subcommand = commandArg(segment, 1);
		return Boolean(subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand));
	}
	if (name === "npm" || name === "pnpm" || name === "yarn") {
		const subcommand = commandArg(segment, 1);
		return Boolean(subcommand && READ_ONLY_NPM_SUBCOMMANDS.has(subcommand));
	}
	return true;
}

function isReadOnlyShellCommand(command: string): boolean {
	if (!command || MUTATING_SHELL_TOKEN_RE.test(command) || UNSAFE_NESTED_SHELL_EXECUTION_RE.test(command))
		return false;
	const segments = command.split(/\s*(?:&&|\|\||[;|\r\n])\s*/).map((segment) => segment.trim());
	return segments.length > 0 && segments.every((segment) => segment.length > 0 && isReadOnlyShellSegment(segment));
}

/**
 * Whether some call of this tool can run on a cheap turn without escalating: the read-only tools, and the
 * shell tools, whose read-only commands run while the escalation gate reruns a mutating one elsewhere.
 * Every call of any other tool escalates, so a side trip that carries it only pays for its schema.
 */
export function mayRunWithoutEscalation(tool: { readonly name: string; readonly readOnly?: boolean }): boolean {
	const name = tool.name.trim().toLowerCase();
	return SHELL_TOOL_NAMES.has(name) || !isMutatingToolCall(name, undefined, tool.readOnly);
}

export function shouldEscalateModelRouterTool(options: {
	tier: ModelTier;
	toolName: string;
	args?: unknown;
	/** The tool's own `readOnly` declaration, when it made one. */
	readOnly?: boolean;
}): boolean {
	if (options.tier !== "cheap") return false;
	return isMutatingToolCall(options.toolName, options.args, options.readOnly);
}

/**
 * Whether a tool call may change the world (files, processes, remote state): anything but a tool that
 * declares itself read-only, the known read-only tools and read-only shell commands. The one read/write line the router escalation and the
 * work boundary both draw.
 */
export function isMutatingToolCall(toolName: string, args?: unknown, declaredReadOnly?: boolean): boolean {
	// A tool's own declaration outranks its name; the name rules below judge tools that declared nothing.
	if (declaredReadOnly === true) return false;
	const name = toolName.trim().toLowerCase();
	if (!name) return true;
	if (READ_ONLY_TOOL_NAMES.has(name)) return false;
	if (SHELL_TOOL_NAMES.has(name)) {
		const command = getShellCommand(args);
		return command ? !isReadOnlyShellCommand(command) : true;
	}
	return MUTATING_TOOL_NAME_RE.test(name) || !name.startsWith("read_");
}
