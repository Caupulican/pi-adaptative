import { existsSync } from "node:fs";
import * as nodePath from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import type { ModelTier } from "../autonomy/contracts.ts";
import { isLocalExecutionModel } from "../background-lane-controller.ts";
import { HF_TRANSFORMERS_PROVIDER, OLLAMA_PROVIDER } from "../models/local-registration.ts";
import { isPiManagedPrismLlamaCppModel } from "../models/prism-llamacpp-lifecycle.ts";
import { parseShellCommandSequence, parseShellInvocationPrefixes } from "../tools/shell-command-parser.ts";

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
const EFFECTFUL_INTERPRETERS = new Set([
	"awk",
	"curl",
	"env",
	"npm",
	"pnpm",
	"powershell",
	"pwsh",
	"sed",
	"ssh",
	"tsc",
	"yarn",
]);
const SHELL_WRAPPERS = new Set(["bash", "dash", "sh", "zsh"]);

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
	"get-psdrive",
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
// A Git subcommand is a whole shell token: the hyphen in `merge-base` is not a
// mutation boundary. Parsed Git commands still pass the subcommand allowlist below.
const MUTATING_SHELL_TOKEN_RE =
	/(^|\s)(>|>>|2>|&>|tee\b|rm\b|mv\b|cp\b|mkdir\b|touch\b|chmod\b|chown\b|install\b|commit\b|push\b|publish\b|deploy\b|apply\b|add\b|checkout\b|switch\b|reset\b|clean\b|stash\b|merge(?=\s|$)|rebase\b|remove-item\b|move-item\b|copy-item\b|new-item\b|rename-item\b|set-content\b|add-content\b|out-file\b|set-item\b|start-process\b|npm\s+(?:i|install|ci|update|publish|run)\b|pnpm\s+(?:i|install|update|publish|run)\b|yarn\s+(?:add|install|upgrade|publish|run)\b)/i;
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

const SAFE_SSH_FLAGS = new Set(["-4", "-6", "-q", "-t"]);
const SAFE_SSH_VALUE_FLAGS = new Set(["-l", "-p"]);
const SAFE_SSH_OPTIONS = new Set([
	"batchmode",
	"connectionattempts",
	"connecttimeout",
	"loglevel",
	"serveralivecountmax",
	"serveraliveinterval",
]);
const MAX_READ_ONLY_WRAPPER_DEPTH = 2;

function executableName(token: string): string {
	return (token.replace(/\\/gu, "/").split("/").at(-1) ?? token).toLowerCase().replace(/\.exe$/u, "");
}

function isSafeSshOption(value: string): boolean {
	const separator = value.indexOf("=");
	if (separator <= 0 || separator === value.length - 1) return false;
	return SAFE_SSH_OPTIONS.has(value.slice(0, separator).toLowerCase());
}

function isReadOnlyPowerShellInvocation(args: readonly string[], depth: number, admitTestRuns: boolean): boolean {
	let index = 1;
	while (index < args.length) {
		const option = args[index]!.toLowerCase();
		if (option === "-nologo" || option === "-noninteractive" || option === "-noprofile") {
			index++;
			continue;
		}
		if (option !== "-c" && option !== "-command") return false;
		const command = args
			.slice(index + 1)
			.join(" ")
			.trim();
		return command.length > 0 && isReadOnlyShellCommand(command, depth + 1, admitTestRuns);
	}
	return false;
}

function isReadOnlySshInvocation(args: readonly string[], depth: number, admitTestRuns: boolean): boolean {
	let index = 1;
	while (index < args.length) {
		const option = args[index]!;
		if (option === "--") {
			index++;
			break;
		}
		if (!option.startsWith("-")) break;
		if (SAFE_SSH_FLAGS.has(option)) {
			index++;
			continue;
		}
		if (SAFE_SSH_VALUE_FLAGS.has(option)) {
			const value = args[index + 1];
			if (!value || value.startsWith("-")) return false;
			index += 2;
			continue;
		}
		if (option === "-o") {
			const value = args[index + 1];
			if (!value || !isSafeSshOption(value)) return false;
			index += 2;
			continue;
		}
		if (option.startsWith("-o") && isSafeSshOption(option.slice(2))) {
			index++;
			continue;
		}
		return false;
	}
	const destination = args[index++];
	if (!destination || !/^[A-Za-z0-9._%+@:-]+$/u.test(destination)) return false;
	const remoteCommand = args.slice(index).join(" ").trim();
	return remoteCommand.length > 0 && isReadOnlyShellCommand(remoteCommand, depth + 1, admitTestRuns);
}

function isReadOnlyInvocation(args: readonly string[], depth: number, admitTestRuns = false): boolean {
	let index = 0;
	while (index < args.length) {
		const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(args[index]!);
		if (!assignment) break;
		if (EXECUTION_STEERING_VARIABLE_RE.test(assignment[1]!)) return false;
		index++;
	}
	if (index === args.length) return args.length > 0;
	const commandArgs = args.slice(index);
	const name = executableName(commandArgs[0]!);
	if (name === "bash" || name === "sh" || name === "dash" || name === "zsh") {
		if (depth >= MAX_READ_ONLY_WRAPPER_DEPTH) return false;
		let commandIndex = 1;
		if (name === "bash") {
			while (commandArgs[commandIndex] === "--noprofile" || commandArgs[commandIndex] === "--norc") commandIndex++;
		}
		// Login shells, scripts and positional arguments can execute or reinterpret other code.
		const inner = commandArgs[commandIndex + 1];
		return (
			commandArgs[commandIndex] === "-c" &&
			commandArgs.length === commandIndex + 2 &&
			Boolean(inner?.trim()) &&
			isReadOnlyShellCommand(inner!, depth + 1, admitTestRuns)
		);
	}
	if (name === "ssh")
		return depth < MAX_READ_ONLY_WRAPPER_DEPTH && isReadOnlySshInvocation(commandArgs, depth, admitTestRuns);
	if (name === "powershell" || name === "pwsh") {
		return depth < MAX_READ_ONLY_WRAPPER_DEPTH && isReadOnlyPowerShellInvocation(commandArgs, depth, admitTestRuns);
	}
	const segment = commandArgs.join(" ");
	return (
		(admitTestRuns && isTestRunSegment(segment)) ||
		(!MUTATING_SHELL_TOKEN_RE.test(segment) && isReadOnlyCommandSegment(segment))
	);
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

function gitCommandAfterGlobalOptions(segment: string): string | undefined {
	const tokens = segment.trim().split(/\s+/u);
	let index = 1;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (token === "-C" || token === "--git-dir" || token === "--work-tree") {
			if (index + 1 >= tokens.length) return undefined;
			index += 2;
			continue;
		}
		if (
			token.startsWith("--git-dir=") ||
			token.startsWith("--work-tree=") ||
			token === "--no-pager" ||
			token === "--literal-pathspecs" ||
			token === "--glob-pathspecs" ||
			token === "--noglob-pathspecs" ||
			token === "--icase-pathspecs"
		) {
			index++;
			continue;
		}
		if (token.startsWith("-")) return undefined;
		return ["git", ...tokens.slice(index)].join(" ");
	}
	return undefined;
}

/** A leading `NAME=value`: sets a shell variable, or one command's environment when a command follows. */
const LEADING_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s"']*)(?:\s+|$)/u;
/** Variables the shell, the loader or a common tool consults to decide what runs: setting one can turn a read into anything. */
const EXECUTION_STEERING_VARIABLE_RE =
	/^(?:PATH|IFS|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|PAGER|[A-Z0-9_]*_PAGER|EDITOR|VISUAL|BROWSER|LESSOPEN|LESSCLOSE|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|GIT_[A-Z0-9_]*|NODE_OPTIONS|NODE_PATH|PYTHON[A-Z0-9_]*|PERL5[A-Z0-9_]*|RUBY[A-Z0-9_]*|SSH_[A-Z0-9_]*)$/u;

/** The segment after its leading assignments, or undefined when one of them steers what runs. */
function withoutLeadingAssignments(segment: string): string | undefined {
	let rest = segment.trim();
	for (let assignment = LEADING_ASSIGNMENT_RE.exec(rest); assignment; assignment = LEADING_ASSIGNMENT_RE.exec(rest)) {
		if (EXECUTION_STEERING_VARIABLE_RE.test(assignment[1]!)) return undefined;
		rest = rest.slice(assignment[0].length);
	}
	return rest;
}

function isReadOnlyShellSegment(segment: string): boolean {
	const rest = withoutLeadingAssignments(segment);
	if (rest === undefined) return false;
	// A bare assignment changes only the shell's own variables.
	if (!rest) return segment.trim().length > 0;
	return isReadOnlyShellCommand(rest);
}

/** `env`'s options that change neither what runs nor anything on disk. */
const ENV_OPTION_RE = /^(?:-i|-0|--ignore-environment|--null|--|-u\s+\S+|--unset=\S+|-C\s+\S+|--chdir=\S+)(?:\s+|$)/u;

/** What `env` runs: "" when it only prints the environment, undefined for an option not judged here (`-S` splits a string into a command). */
function envWrappedCommand(segment: string): string | undefined {
	let rest = segment.trim().replace(/^\S+\s*/u, "");
	for (let option = ENV_OPTION_RE.exec(rest); option; option = ENV_OPTION_RE.exec(rest)) {
		rest = rest.slice(option[0].length);
	}
	return rest.startsWith("-") ? undefined : rest;
}

/** Node runs arbitrary code; only printing its version and syntax-checking a file read nothing else. */
const NODE_READ_ONLY_RE = /^\S+\s+(?:-v|--version|(?:-c|--check)\s+\S+)$/u;

/**
 * A run of the project's own tests: how a requirement check proves code works. It executes project
 * code the agent may already run, and may write the runner's own caches and reports; an option that
 * rewrites project files (snapshot update, fix) or never finishes (watch) is not a test run.
 */
const TEST_RUN_RE =
	/^(?:(?:(?:npx|bunx)|(?:pnpm|yarn)\s+exec)\s+)?(?:vitest\s+run|jest|mocha|pytest)(?:\s|$)|^node\s+--test(?:\s|$)|^python3?\s+-m\s+(?:pytest|unittest)(?:\s|$)|^(?:go|cargo|deno|bun)\s+test(?:\s|$)|^(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/u;
const TEST_RUN_WRITE_OPTION_RE = /(?:^|\s)(?:-u|--update\S*|--watch\S*|--fix\S*)(?:\s|=|$)/u;

function isTestRunSegment(segment: string): boolean {
	const rest = withoutLeadingAssignments(segment);
	return (
		rest !== undefined &&
		TEST_RUN_RE.test(rest) &&
		!TEST_RUN_WRITE_OPTION_RE.test(rest) &&
		!UNSAFE_NESTED_SHELL_EXECUTION_RE.test(rest)
	);
}

function isReadOnlyCommandSegment(segment: string): boolean {
	const name = commandName(segment);
	if (!name || !READ_ONLY_COMMANDS.has(name)) return false;
	if (name === "git") {
		const command = gitCommandAfterGlobalOptions(segment);
		if (!command) return false;
		const subcommand = commandArg(command, 1);
		if (subcommand && GIT_REF_LISTING_SUBCOMMANDS.has(subcommand))
			return isReadOnlyGitRefListing(command, subcommand);
		return Boolean(subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand));
	}
	// In-place editing and emitting compilers change files.
	if (name === "sed" && /(?:^|\s)(?:-[a-zA-Z]*i[a-zA-Z]*|--in-place(?:=\S*)?)(?:\s|$)/.test(segment)) return false;
	if (name === "tsc" && !/(?:^|\s)--noEmit(?:\s|$)/.test(segment)) return false;
	if (name === "npm" || name === "pnpm" || name === "yarn") {
		const subcommand = commandArg(segment, 1);
		return Boolean(subcommand && READ_ONLY_NPM_SUBCOMMANDS.has(subcommand));
	}
	if (name === "env") {
		const wrapped = envWrappedCommand(segment);
		return wrapped !== undefined && (wrapped === "" || isReadOnlyShellSegment(wrapped));
	}
	if (name === "node") return NODE_READ_ONLY_RE.test(segment.trim());
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

function readOnlyShellInvocations(command: string, depth = 0, admitTestRuns = false): string[][] | undefined {
	const commandWithoutStreamRedirections = stripSafeStreamRedirections(command);
	if (
		!commandWithoutStreamRedirections ||
		(!admitTestRuns && MUTATING_SHELL_TOKEN_RE.test(commandWithoutStreamRedirections)) ||
		UNSAFE_NESTED_SHELL_EXECUTION_RE.test(commandWithoutStreamRedirections)
	)
		return undefined;
	const sequence = parseShellCommandSequence(commandWithoutStreamRedirections);
	if (
		!sequence ||
		sequence.invocations.length === 0 ||
		!sequence.invocations.every((args) => isReadOnlyInvocation(args, depth, admitTestRuns))
	)
		return undefined;
	return sequence.invocations;
}

function isReadOnlyShellCommand(command: string, depth = 0, admitTestRuns = false): boolean {
	return readOnlyShellInvocations(command, depth, admitTestRuns) !== undefined;
}

function hasProvablyObservationalShellEffects(command: string): boolean {
	const invocations = readOnlyShellInvocations(command);
	if (!invocations) return false;
	return invocations.every((args) => {
		const prefix = parseShellInvocationPrefixes(args);
		if (prefix.envExecutable) return false;
		if (prefix.nonExecutingQuery) return true;
		const commandArgs = prefix.args;
		const name = executableName(commandArgs[0] ?? "");
		// These programs can execute code, invoke other programs, contact remote systems, or write
		// tool-managed state. Their effects remain available to semantic recovery judgment.
		if (EFFECTFUL_INTERPRETERS.has(name) || SHELL_WRAPPERS.has(name)) return false;
		// These read-only command families have flags or operands that can create output or launch code.
		if (["diff", "git", "sort", "tree"].includes(name)) {
			if (
				commandArgs.some(
					(arg) =>
						arg === "-o" ||
						(arg.startsWith("-o") && !arg.startsWith("--")) ||
						arg.startsWith("--output") ||
						arg === "--ext-diff" ||
						arg === "--textconv" ||
						arg.startsWith("--open-files-in-pager") ||
						arg.startsWith("--compress-program"),
				)
			)
				return false;
		}
		if (
			name === "date" &&
			commandArgs.some((arg) => arg === "-s" || arg.startsWith("-s") || arg === "--set" || arg.startsWith("--set="))
		)
			return false;
		if (name === "file" && commandArgs.some((arg) => arg === "-C" || arg === "--compile")) return false;
		if (name === "rg" && commandArgs.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) return false;
		if (name === "fd" && commandArgs.some((arg) => arg === "-x" || arg === "-X" || arg.startsWith("--exec")))
			return false;
		if (name === "hostname" && commandArgs.length > 1) return false;
		// GNU uniq's optional second positional operand names an output file.
		if (name === "uniq" && commandArgs.slice(1).filter((arg) => !arg.startsWith("-")).length > 1) return false;
		return true;
	});
}

/**
 * True only when the tool contract or parsed invocation proves that the call observes state without
 * changing it. Unknown and executable commands remain available to the caller's semantic gate.
 */
export function isProvablyObservationalToolCall(toolName: string, args?: unknown, declaredReadOnly?: boolean): boolean {
	if (declaredReadOnly === true) return true;
	const name = toolName.trim().toLowerCase();
	if (!name) return false;
	if (READ_ONLY_TOOL_NAMES.has(name)) return true;
	if (!SHELL_TOOL_NAMES.has(name)) return false;
	const command = getShellCommand(args);
	return command !== undefined && hasProvablyObservationalShellEffects(command);
}

/** An output redirection and its target: `>`, `>>`, `2>`, `&>`, `&>>`; `2>&1`-style fd duplication is not a file. */
const OUTPUT_REDIRECTION_RE = /(?:^|(?<=\s))(?:\d|&)?>>?\s*("[^"]*"|'[^']*'|&\d+|&-|[^\s;&|<>]+)/g;
const STREAM_TARGET_RE = /^(?:&\d+|&-|\/dev\/(?:null|stdout|stderr|tty))$/;

function unquoteShellWord(word: string): string {
	return (word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))
		? word.slice(1, -1)
		: word;
}

function stripSafeStreamRedirections(command: string): string {
	return command.replace(OUTPUT_REDIRECTION_RE, (match, target: string) =>
		STREAM_TARGET_RE.test(unquoteShellWord(target)) ? " " : match,
	);
}

/**
 * Why a read-only lane may not run `command`, or undefined when it may. Read-only means nothing that
 * already exists is edited: output may still be redirected or `tee`d into a NEW file (a report, a
 * scratch capture), but a redirect or tee onto an existing path, and every command the read/write
 * line above calls mutating, is refused. This inspects the command text; it is not OS isolation.
 */
export function readOnlyShellViolation(
	command: string,
	cwd: string,
	options: {
		/** A requirement check may run the project's tests (see TEST_RUN_RE); a read-only lane may not. */
		admitTestRuns?: boolean;
	} = {},
): string | undefined {
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
	if (UNSAFE_NESTED_SHELL_EXECUTION_RE.test(withoutRedirections)) {
		return "it may change files or repository state";
	}
	const sequence = parseShellCommandSequence(withoutRedirections);
	if (!sequence) return "it may change files or repository state";
	const remaining: string[][] = [];
	for (const invocation of sequence.invocations) {
		const segment = invocation.join(" ");
		if (options.admitTestRuns && isTestRunSegment(segment)) continue;
		if (executableName(invocation[0] ?? "") !== "tee") {
			remaining.push(invocation);
			continue;
		}
		for (const word of invocation.slice(1)) {
			if (word.startsWith("-")) continue;
			const existing = targetExists(word);
			if (existing) return `it writes into the existing path ${existing}`;
		}
	}
	if (remaining.length === 0) return undefined;
	return remaining.every((invocation) => isReadOnlyInvocation(invocation, 0, options.admitTestRuns ?? false))
		? undefined
		: "it may change files or repository state";
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
