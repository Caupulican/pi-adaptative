import { existsSync } from "node:fs";
import * as nodePath from "node:path";
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
	"command",
	"curl",
	"free",
	"hostname",
	"id",
	"lsof",
	"netstat",
	"pgrep",
	"ps",
	"ss",
	"systemctl",
	"basename",
	"cat",
	"cd",
	"column",
	"comm",
	"cut",
	"date",
	"df",
	"diff",
	"dirname",
	"du",
	"echo",
	"env",
	"fd",
	"file",
	"find",
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
	"md5sum",
	"nl",
	"node",
	"npm",
	"pnpm",
	"printf",
	"pwd",
	"readlink",
	"realpath",
	"resolve-path",
	"rg",
	"sed",
	"select-object",
	"select-string",
	"sha1sum",
	"sha256sum",
	"sleep",
	"sort",
	"stat",
	"tail",
	"test",
	"test-path",
	"tr",
	"tree",
	"tsc",
	"uniq",
	"uname",
	"wc",
	"whoami",
	"where-object",
	"which",
	"write-output",
	"yarn",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"blame",
	"cat-file",
	"describe",
	"diff",
	"grep",
	"log",
	"ls-files",
	"ls-tree",
	"merge-base",
	"name-rev",
	"rev-list",
	"rev-parse",
	"shortlog",
	"show",
	"show-ref",
	"status",
]);
/** `git branch` and `git tag` list refs, but a positional name or a ref-changing flag creates, moves or deletes one. */
const GIT_REF_LISTING_SUBCOMMANDS = new Set(["branch", "tag"]);
const GIT_REF_MUTATING_FLAG_RE =
	/^(?:-[dDmMcCfu]|--delete|--move|--copy|--force|--set-upstream-to(?:=.*)?|--unset-upstream|--edit-description|-a|--annotate|-s|--sign|-F|--file(?:=.*)?)$/;
const READ_ONLY_SYSTEMCTL_SUBCOMMANDS = new Set([
	"cat",
	"is-active",
	"is-enabled",
	"is-failed",
	"list-timers",
	"list-unit-files",
	"list-units",
	"show",
	"status",
]);
const CURL_MUTATING_OPTION_RE =
	/(?:^|\s)(?:-[a-zA-Z]*[XdFToO][a-zA-Z]*|--(?:request|data[a-z-]*|form[a-z-]*|upload-file|output|remote-name[a-z-]*|json|post[a-z0-9-]*))(?:[\s=]|$)/u;
const READ_ONLY_NPM_SUBCOMMANDS = new Set(["info", "list", "ls", "outdated", "view", "whoami"]);
const MUTATING_SHELL_TOKEN_RE =
	/(^|\s)(>|>>|2>|&>|tee\b|rm\b|mv\b|cp\b|mkdir\b|touch\b|chmod\b|chown\b|install\b|commit\b|push\b|publish\b|deploy\b|apply\b|add\b|checkout\b|switch\b|reset\b|clean\b|stash\b|merge\b|rebase\b|remove-item\b|move-item\b|copy-item\b|new-item\b|rename-item\b|set-content\b|add-content\b|out-file\b|set-item\b|start-process\b|npm\s+(?:i|install|ci|update|publish|run)\b|pnpm\s+(?:i|install|update|publish|run)\b|yarn\s+(?:add|install|upgrade|publish|run)\b)/i;
const UNSAFE_NESTED_SHELL_EXECUTION_RE =
	/(`|\$\(|\bfind\b[\s\S]*\s-(?:exec(?:dir)?|ok(?:dir)?|delete|fprint(?:0|f)?|fls)\b|\bxargs\b)/i;
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

function isReadOnlyGitRefListing(segment: string, subcommand: string): boolean {
	const rest = segment.trim().split(/\s+/).slice(2);
	const listing = rest.some((token) => token === "-l" || token === "--list");
	for (const token of rest) {
		// `git tag -a` annotates, but `git branch -a` lists all branches.
		if (subcommand === "branch" && token === "-a") continue;
		if (GIT_REF_MUTATING_FLAG_RE.test(token)) return false;
		if (!token.startsWith("-") && !listing) return false;
	}
	return true;
}

/** A leading `NAME=value`: sets a shell variable, or one command's environment when a command follows. */
const LEADING_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s"']*)(?:\s+|$)/u;
/** Variables the shell, the loader or a common tool consults to decide what runs: setting one can turn a read into anything. */
const EXECUTION_STEERING_VARIABLE_RE =
	/^(?:PATH|IFS|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|PAGER|[A-Z0-9_]*_PAGER|EDITOR|VISUAL|BROWSER|LESSOPEN|LESSCLOSE|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|GIT_[A-Z0-9_]*|NODE_OPTIONS|NODE_PATH|PYTHON[A-Z0-9_]*|PERL5[A-Z0-9_]*|RUBY[A-Z0-9_]*|SSH_[A-Z0-9_]*)$/u;

function isReadOnlyShellSegment(segment: string): boolean {
	let rest = segment.trim();
	for (let assignment = LEADING_ASSIGNMENT_RE.exec(rest); assignment; assignment = LEADING_ASSIGNMENT_RE.exec(rest)) {
		if (EXECUTION_STEERING_VARIABLE_RE.test(assignment[1]!)) return false;
		rest = rest.slice(assignment[0].length);
	}
	// A bare assignment changes only the shell's own variables.
	if (!rest) return segment.trim().length > 0;
	return isReadOnlyCommandSegment(rest);
}

function isReadOnlyCommandSegment(segment: string): boolean {
	const name = commandName(segment);
	if (!name || !READ_ONLY_COMMANDS.has(name)) return false;
	if (name === "git") {
		const subcommand = commandArg(segment, 1);
		if (subcommand && GIT_REF_LISTING_SUBCOMMANDS.has(subcommand))
			return isReadOnlyGitRefListing(segment, subcommand);
		return Boolean(subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand));
	}
	// In-place editing and emitting compilers change files.
	if (name === "sed" && /(?:^|\s)(?:-[a-zA-Z]*i[a-zA-Z]*|--in-place(?:=\S*)?)(?:\s|$)/.test(segment)) return false;
	if (name === "tsc" && !/(?:^|\s)--noEmit(?:\s|$)/.test(segment)) return false;
	if (name === "npm" || name === "pnpm" || name === "yarn") {
		const subcommand = commandArg(segment, 1);
		return Boolean(subcommand && READ_ONLY_NPM_SUBCOMMANDS.has(subcommand));
	}
	// `command -v`/`-V` looks a name up; plain `command x` runs x.
	if (name === "command") return /^command\s+-[vV]\s/u.test(segment.trim());
	if (name === "systemctl") {
		const subcommand = segment
			.trim()
			.split(/\s+/u)
			.slice(1)
			.find((token) => !token.startsWith("-"));
		return Boolean(subcommand && READ_ONLY_SYSTEMCTL_SUBCOMMANDS.has(subcommand));
	}
	// A GET that writes nothing: no request body, upload, non-GET method, or output file.
	if (name === "curl") return !CURL_MUTATING_OPTION_RE.test(segment);
	return true;
}

const SHELL_SEGMENT_SEPARATOR_RE = /\s*(?:&&|\|\||[;|\r\n])\s*/;

function isReadOnlyShellCommand(command: string): boolean {
	if (!command || MUTATING_SHELL_TOKEN_RE.test(command) || UNSAFE_NESTED_SHELL_EXECUTION_RE.test(command))
		return false;
	const segments = command.split(SHELL_SEGMENT_SEPARATOR_RE).map((segment) => segment.trim());
	return segments.length > 0 && segments.every((segment) => segment.length > 0 && isReadOnlyShellSegment(segment));
}

/** An output redirection and its target: `>`, `>>`, `2>`, `&>`, `&>>`; `2>&1`-style fd duplication is not a file. */
const OUTPUT_REDIRECTION_RE = /(?:^|(?<=\s))(?:\d|&)?>>?\s*("[^"]*"|'[^']*'|&\d+|&-|[^\s;&|<>]+)/g;
const STREAM_TARGET_RE = /^(?:&\d+|&-|\/dev\/(?:null|stdout|stderr|tty))$/;

function unquoteShellWord(word: string): string {
	return (word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))
		? word.slice(1, -1)
		: word;
}

/**
 * Why a read-only lane may not run `command`, or undefined when it may. Read-only means nothing that
 * already exists is edited: output may still be redirected or `tee`d into a NEW file (a report, a
 * scratch capture), but a redirect or tee onto an existing path, and every command the read/write
 * line above calls mutating, is refused. This inspects the command text; it is not OS isolation.
 */
export function readOnlyShellViolation(command: string, cwd: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;
	const targetExists = (word: string): string | undefined => {
		const target = unquoteShellWord(word);
		if (STREAM_TARGET_RE.test(target)) return undefined;
		return existsSync(nodePath.resolve(cwd, target)) ? target : undefined;
	};
	for (const match of trimmed.matchAll(OUTPUT_REDIRECTION_RE)) {
		const existing = targetExists(match[1]!);
		if (existing) return `it writes into the existing path ${existing}`;
	}
	const withoutRedirections = trimmed.replace(OUTPUT_REDIRECTION_RE, " ");
	const remaining: string[] = [];
	for (const segment of withoutRedirections.split(SHELL_SEGMENT_SEPARATOR_RE).map((part) => part.trim())) {
		if (!segment) continue;
		if (commandName(segment) !== "tee") {
			remaining.push(segment);
			continue;
		}
		for (const word of segment.split(/\s+/).slice(1)) {
			if (word.startsWith("-")) continue;
			const existing = targetExists(word);
			if (existing) return `it writes into the existing path ${existing}`;
		}
	}
	if (remaining.length === 0) return undefined;
	return isReadOnlyShellCommand(remaining.join(" ; ")) ? undefined : "it may change files or repository state";
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
