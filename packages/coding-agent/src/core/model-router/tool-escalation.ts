import type { ModelRouterIntent } from "./intent-classifier.ts";

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

const SHELL_TOOL_NAMES = new Set(["bash", "exec", "execute", "run", "run_command", "shell"]);

const READ_ONLY_COMMANDS = new Set([
	"awk",
	"cat",
	"date",
	"df",
	"du",
	"env",
	"git",
	"grep",
	"head",
	"jq",
	"ls",
	"node",
	"npm",
	"pnpm",
	"pwd",
	"rg",
	"sed",
	"tail",
	"test",
	"tsc",
	"wc",
	"which",
	"yarn",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set(["branch", "diff", "log", "rev-parse", "show", "status", "tag"]);
const READ_ONLY_NPM_SUBCOMMANDS = new Set(["info", "list", "ls", "outdated", "view", "whoami"]);
const MUTATING_SHELL_TOKEN_RE =
	/(^|\s)(>|>>|2>|&>|tee\b|rm\b|mv\b|cp\b|mkdir\b|touch\b|chmod\b|chown\b|install\b|commit\b|push\b|publish\b|deploy\b|apply\b|add\b|checkout\b|switch\b|reset\b|clean\b|stash\b|merge\b|rebase\b|npm\s+(?:i|install|ci|update|publish|run)\b|pnpm\s+(?:i|install|update|publish|run)\b|yarn\s+(?:add|install|upgrade|publish|run)\b)/i;
const MUTATING_TOOL_NAME_RE =
	/(bash|exec|execute|run|shell|write|edit|patch|replace|delete|remove|move|rename|create|mkdir|touch|install|commit|push|publish|deploy|apply)/i;

type ToolEscalationOptions = { intent: ModelRouterIntent; toolName: string; args?: unknown };

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
	if (!command || MUTATING_SHELL_TOKEN_RE.test(command)) return false;
	const segments = command.split(/\s*&&\s*/).map((segment) => segment.trim());
	return segments.length > 0 && segments.every(isReadOnlyShellSegment);
}

export function shouldEscalateModelRouterTool(options: ToolEscalationOptions): boolean {
	if (options.intent !== "research") return false;
	const toolName = options.toolName.trim().toLowerCase();
	if (!toolName) return true;
	if (READ_ONLY_TOOL_NAMES.has(toolName)) return false;
	if (SHELL_TOOL_NAMES.has(toolName)) {
		const command = getShellCommand(options.args);
		return command ? !isReadOnlyShellCommand(command) : true;
	}
	return MUTATING_TOOL_NAME_RE.test(toolName) || !toolName.startsWith("read_");
}
