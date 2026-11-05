import { existsSync } from "node:fs";
import * as nodePath from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import { globIterateSync } from "glob";
import type { ModelTier } from "../autonomy/contracts.ts";
import { isPathWithinScope, safeRealpathSync } from "../autonomy/path-scope.ts";
import { HF_TRANSFORMERS_PROVIDER, OLLAMA_PROVIDER } from "../models/local-registration.ts";
import { isLocalExecutionModel } from "../models/model-endpoint.ts";
import { isPiManagedPrismLlamaCppModel } from "../models/prism-llamacpp-lifecycle.ts";
import {
	parseShellCommandSequence,
	parseShellInvocationPrefixes,
	type ShellCommandDialect,
	tokenizeShellCommand,
} from "../tools/shell-command-parser.ts";

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
	if (invocationEffect(commandArgs)) return false;
	const segment = commandArgs.join(" ");
	// The raw command was already screened for nested execution, but quoting hides a flag from that
	// screen (`find . "-delete"`): the parsed arguments are screened again with the quotes removed.
	if (UNSAFE_NESTED_SHELL_EXECUTION_RE.test(segment)) return false;
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
		// Options that write files or launch programs (`sort -o`, `rg --pre`, ...) were already refused by
		// `invocationEffect` on the way through `readOnlyShellInvocations`.
		return !EFFECTFUL_INTERPRETERS.has(name) && !SHELL_WRAPPERS.has(name);
	});
}

/** awk program text that runs a command, pipes to or from one, reads a named file or prints into one. */
const AWK_PROGRAM_EFFECT_RE =
	/\bsystem\s*\(|(?<!\|)\|(?!\|)|\bgetline\b[^;{}]*<|\bprintf?\b[^;{}]*>|@(?:load|include|namespace)\b/u;
/** awk options that load code, read the program from a file or write a profile, dump or pretty-print file. */
const AWK_EFFECT_OPTION_LETTERS = "fiolpdDEW";
const AWK_EFFECT_LONG_OPTION_RE = /^--(?:file|include|load|pretty-print|profile|dump-variables|debug|exec)(?:=|$)/u;

/**
 * awk program text with the contents of its string and regular-expression literals removed, so a `|` in
 * `/a|b/` or a `>` in `"a > b"` is not read as a pipe or an output redirection. A `/` opens a regular
 * expression only where an operand cannot precede it; after an operand it divides.
 */
function awkCodeOutsideLiterals(program: string): string {
	let code = "";
	let previous = "";
	for (let index = 0; index < program.length; index++) {
		const char = program[index]!;
		if (char === '"' || (char === "/" && (previous === "" || "(,~!{};&|?:".includes(previous)))) {
			index++;
			while (index < program.length && program[index] !== char) index += program[index] === "\\" ? 2 : 1;
			code += `${char}${char}`;
			previous = char;
			continue;
		}
		code += char;
		if (!/\s/u.test(char)) previous = char;
	}
	return code;
}

/**
 * The program texts of an awk/sed-style invocation: those its options give, else its first operand.
 * `option` reads one option word (`next()` consumes the following word) and returns a program text, nothing,
 * or `null` when the option takes the program from somewhere the gate cannot read; the result is then undefined.
 */
function programTextsOf(
	args: readonly string[],
	option: (arg: string, next: () => string) => string | null | undefined,
): string[] | undefined {
	const programs: string[] = [];
	const positional: string[] = [];
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--") {
			positional.push(...args.slice(index + 1));
			break;
		}
		if (!arg.startsWith("-") || arg.length === 1) {
			positional.push(arg);
			continue;
		}
		const program = option(arg, () => args[++index] ?? "");
		if (program === null) return undefined;
		if (program !== undefined) programs.push(program);
	}
	if (programs.length === 0 && positional[0] !== undefined) programs.push(positional[0]);
	return programs;
}

/** The awk program texts in `args`, or undefined when an option loads code or writes a file. */
function awkProgramTexts(args: readonly string[]): string[] | undefined {
	return programTextsOf(args, (arg, next) => {
		if (arg.startsWith("--")) {
			if (AWK_EFFECT_LONG_OPTION_RE.test(arg)) return null;
			if (arg === "--source") return next();
			if (arg.startsWith("--source=")) return arg.slice("--source=".length);
			if (arg === "--field-separator" || arg === "--assign") next();
			return undefined;
		}
		const letter = arg[1]!;
		if (AWK_EFFECT_OPTION_LETTERS.includes(letter)) return null;
		const attached = arg.slice(2);
		if (letter === "e") return attached || next();
		if ((letter === "F" || letter === "v") && !attached) next();
		return undefined;
	});
}

/** The sed scripts in `args`, or undefined when a script comes from a file the gate cannot read. */
function sedScripts(args: readonly string[]): string[] | undefined {
	return programTextsOf(args, (arg, next) => {
		if (arg.startsWith("--")) {
			if (arg === "--file" || arg.startsWith("--file=")) return null;
			if (arg === "--expression") return next();
			if (arg.startsWith("--expression=")) return arg.slice("--expression=".length);
			if (arg === "--line-length") next();
			return undefined;
		}
		for (let letterIndex = 1; letterIndex < arg.length; letterIndex++) {
			const letter = arg[letterIndex];
			if (letter === "f") return null;
			if (letter === "e") return arg.slice(letterIndex + 1) || next();
			if (letter === "l") {
				if (letterIndex === arg.length - 1) next();
				return undefined;
			}
		}
		return undefined;
	});
}

/**
 * Whether a sed script runs a command (`e`, `s///e`), writes a file (`w`, `W`, `s///w`) or reads one into
 * its output (`r`, `R`). Addresses, substitution bodies, inserted text and labels are skipped, so a
 * letter left over is a command.
 */
function sedScriptHasEffects(script: string): boolean {
	let index = 0;
	const skipUntil = (stops: string) => {
		while (index < script.length && !stops.includes(script[index]!)) index++;
	};
	// From just after an opening delimiter to just after its closing one; false when it never closes.
	const skipDelimited = (delimiter: string): boolean => {
		while (index < script.length) {
			const char = script[index]!;
			index += char === "\\" ? 2 : 1;
			if (char === delimiter) return true;
		}
		return false;
	};
	while (index < script.length) {
		const char = script[index]!;
		if (char === "/" || char === "\\") {
			const delimiter = char === "/" ? "/" : script[index + 1];
			if (delimiter === undefined) return true;
			index += char === "/" ? 1 : 2;
			if (!skipDelimited(delimiter)) return true;
			continue;
		}
		if (char === "s" || char === "y") {
			const delimiter = script[index + 1];
			if (delimiter === undefined || delimiter === "\\" || delimiter === "\n") return true;
			index += 2;
			if (!skipDelimited(delimiter) || !skipDelimited(delimiter)) return true;
			if (char === "s") {
				const flagsStart = index;
				skipUntil(";}\n");
				if (/[ewW]/u.test(script.slice(flagsStart, index))) return true;
			}
			continue;
		}
		if (char === "a" || char === "i" || char === "c" || char === "#") {
			skipUntil("\n");
			continue;
		}
		if (char === ":" || char === "b" || char === "t" || char === "T") {
			index++;
			skipUntil(";\n");
			continue;
		}
		if ("erRwW".includes(char)) return true;
		index++;
	}
	return false;
}

/** PowerShell cmdlets on the read-only list that also accept a script block, which runs arbitrary code. */
const SCRIPT_BLOCK_CMDLETS = new Set(["where-object", "select-object", "format-list", "format-table"]);

/**
 * Why a program on the read-only list would still run another program, write a file or read a file its
 * command line does not name, through an option or its own program text; undefined when it does not.
 * Shared by every caller of the read/write line, so `sort -o`, `rg --pre` or awk's `system()` never
 * passes as a read.
 */
function invocationEffect(commandArgs: readonly string[]): string | undefined {
	const name = executableName(commandArgs[0] ?? "");
	const rest = commandArgs.slice(1);
	const found = (test: (arg: string) => boolean): string | undefined => rest.find(test);
	let effect: string | undefined;
	switch (name) {
		case "sort":
			effect = found((arg) => /^-[^-]*o/u.test(arg) || /^--(?:output|compress-program)(?:=|$)/u.test(arg));
			break;
		case "tree":
			effect = found((arg) => arg === "-R" || /^-o/u.test(arg) || /^--output(?:=|$)/u.test(arg));
			break;
		case "git":
			effect = found(
				(arg) => /^-O/u.test(arg) || /^--(?:output|ext-diff|textconv|open-files-in-pager)(?:=|$)/u.test(arg),
			);
			break;
		case "date":
			effect = found((arg) => arg.startsWith("-s") || /^--set(?:=|$)/u.test(arg));
			break;
		case "file":
			effect = found((arg) => arg === "-C" || arg === "--compile");
			break;
		case "rg":
			effect = found((arg) => /^--(?:pre|hostname-bin)(?:=|$)/u.test(arg));
			break;
		case "fd":
			effect = found((arg) => arg === "-x" || arg === "-X" || /^--exec(?:-batch)?(?:=|$)/u.test(arg));
			break;
		case "hostname":
			// A positional name or a name file sets the host name.
			effect = found((arg) => !arg.startsWith("-") || /^(?:-F|-b|--file(?:=|$)|--boot$)/u.test(arg));
			break;
		case "uniq": {
			// GNU uniq's optional second positional operand names an output file.
			let positional = 0;
			for (let index = 0; index < rest.length; index++) {
				const arg = rest[index]!;
				if (arg === "-f" || arg === "-s" || arg === "-w") index++;
				else if (!arg.startsWith("-") && ++positional > 1) effect = arg;
			}
			break;
		}
		case "sed": {
			const scripts = sedScripts(commandArgs);
			if (!scripts) effect = "-f";
			else effect = scripts.find(sedScriptHasEffects);
			break;
		}
		case "awk": {
			const programs = awkProgramTexts(commandArgs);
			if (!programs) effect = "option";
			else effect = programs.find((program) => AWK_PROGRAM_EFFECT_RE.test(awkCodeOutsideLiterals(program)));
			break;
		}
		default:
			if (SCRIPT_BLOCK_CMDLETS.has(name)) effect = found((arg) => arg.includes("{"));
	}
	return effect === undefined
		? undefined
		: `${name} ${JSON.stringify(effect)} can run another program or touch a file`;
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
 * What a read-only worker lane may reach beyond the read/write line, supplied by the lane's own tool
 * surface. A lane reaches the network only with `network.http`, creates files only inside its own
 * scratch directory and reads no private harness or credential path.
 */
export interface ReadOnlyShellLaneScope {
	/** The lane holds `network.http`; without it every network client is refused. */
	readonly network: boolean;
	/**
	 * The lane's own scratch directory, exported to its commands as TMPDIR/TMP/TEMP and removed when the
	 * lane ends: as exported first, then canonical. The only place the lane may create a file; empty when
	 * the lane has none.
	 */
	readonly scratchRoots: readonly string[];
	/** The directory `~`, `$HOME` and `$env:USERPROFILE` name. */
	readonly homeDir: string;
	/** The `CDPATH` entries the lane's shell inherited: `cd name` may land below any of them. */
	readonly cdPath: readonly string[];
	/** Absolute harness storage paths (credentials, memory, sessions, state) no recursive search may descend into. */
	readonly harnessStoragePaths: readonly string[];
	/** The credential guard's path policy over the lane's denied paths (canonical paths, case rules, dotenv names). */
	isDeniedPath(absolutePath: string): boolean;
}

/** Programs whose purpose is to reach another host. */
const NETWORK_CLIENTS = new Set([
	"aria2c",
	"bunx",
	"curl",
	"dig",
	"ftp",
	"host",
	"http",
	"https",
	"invoke-restmethod",
	"invoke-webrequest",
	"irm",
	"iwr",
	"nc",
	"ncat",
	"netcat",
	"npx",
	"nslookup",
	"ping",
	"pnpx",
	"resolve-dnsname",
	"rsync",
	"scp",
	"sftp",
	"socat",
	"ssh",
	"start-bitstransfer",
	"telnet",
	"test-connection",
	"test-netconnection",
	"tftp",
	"uvx",
	"wget",
	"xh",
]);
const NPM_FAMILY_NETWORK_SUBCOMMANDS = [
	"access",
	"add",
	"adduser",
	"audit",
	"bugs",
	"ci",
	"create",
	"dedupe",
	"deprecate",
	"dist-tag",
	"dlx",
	"docs",
	"doctor",
	"exec",
	"fetch",
	"find",
	"fund",
	"home",
	"i",
	"info",
	"init",
	"install",
	"login",
	"logout",
	"outdated",
	"owner",
	"ping",
	"publish",
	"repo",
	"s",
	"search",
	"show",
	"star",
	"team",
	"token",
	"unpublish",
	"up",
	"update",
	"upgrade",
	"v",
	"view",
	"whoami",
	"x",
];
const PYTHON_PACKAGE_NETWORK_SUBCOMMANDS = [
	"add",
	"download",
	"index",
	"install",
	"lock",
	"pip",
	"search",
	"sync",
	"tool",
	"wheel",
];
const SYSTEM_PACKAGE_NETWORK_SUBCOMMANDS = [
	"download",
	"fetch",
	"info",
	"install",
	"search",
	"show",
	"source",
	"update",
	"upgrade",
];
/** Package-manager subcommands that talk to a registry, an index or a mirror. */
const PACKAGE_MANAGER_NETWORK_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
	(
		[
			["npm", NPM_FAMILY_NETWORK_SUBCOMMANDS],
			["pnpm", NPM_FAMILY_NETWORK_SUBCOMMANDS],
			["yarn", NPM_FAMILY_NETWORK_SUBCOMMANDS],
			["bun", NPM_FAMILY_NETWORK_SUBCOMMANDS],
			["pip", PYTHON_PACKAGE_NETWORK_SUBCOMMANDS],
			["pip3", PYTHON_PACKAGE_NETWORK_SUBCOMMANDS],
			["uv", PYTHON_PACKAGE_NETWORK_SUBCOMMANDS],
			["cargo", ["add", "fetch", "install", "login", "owner", "publish", "search", "update", "yank"]],
			["go", ["download", "get", "install", "mod"]],
			["gem", ["fetch", "install", "push", "search", "sources", "update"]],
			["dotnet", ["add", "restore", "tool", "workload"]],
			["apt", SYSTEM_PACKAGE_NETWORK_SUBCOMMANDS],
			["apt-get", SYSTEM_PACKAGE_NETWORK_SUBCOMMANDS],
			["brew", SYSTEM_PACKAGE_NETWORK_SUBCOMMANDS],
			["choco", SYSTEM_PACKAGE_NETWORK_SUBCOMMANDS],
			["scoop", SYSTEM_PACKAGE_NETWORK_SUBCOMMANDS],
			["winget", SYSTEM_PACKAGE_NETWORK_SUBCOMMANDS],
		] as const
	).map(([name, subcommands]): [string, ReadonlySet<string>] => [name, new Set<string>(subcommands)]),
);
const GIT_NETWORK_SUBCOMMANDS = new Set([
	"clone",
	"fetch",
	"fetch-pack",
	"ls-remote",
	"pull",
	"push",
	"request-pull",
	"send-pack",
]);
const GIT_NETWORK_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["remote", new Set(["prune", "set-head", "show", "update"])],
	["submodule", new Set(["add", "update"])],
]);
const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--config-env", "--git-dir", "--namespace", "--work-tree"]);
const GH_LOCAL_SUBCOMMANDS = new Set(["alias", "completion", "config", "help", "version"]);
/** A .NET networking type named in a PowerShell type literal (`[Net.WebClient]`, `[System.Net.Http.HttpClient]`). */
const DOTNET_NETWORK_TYPE_LITERAL_RE = /\[(?:system\.)?net\./iu;
const DOTNET_NETWORK_TYPE_NAME_RE = /^(?:system\.)?net\./iu;
/** Programs that run the command after their own options: what they run is judged instead. */
const COMMAND_WRAPPERS = new Set([
	"chrt",
	"doas",
	"exec",
	"ionice",
	"nice",
	"nohup",
	"setsid",
	"stdbuf",
	"strace",
	"sudo",
	"taskset",
	"time",
	"timeout",
	"watch",
	"xargs",
]);
const MAX_WRAPPER_SCAN_DEPTH = 3;
/** `networkReach` result for a command nested deeper in wrapper programs than the gate inspects. */
const WRAPPED_TOO_DEEP = "\0wrapped-too-deep";

function gitNetworkReach(args: readonly string[]): string | undefined {
	let index = 1;
	while (index < args.length && args[index]!.startsWith("-"))
		index += GIT_GLOBAL_VALUE_OPTIONS.has(args[index]!) ? 2 : 1;
	const subcommand = args[index]?.toLowerCase();
	if (subcommand === undefined) return undefined;
	const rest = args.slice(index + 1);
	if (GIT_NETWORK_SUBCOMMANDS.has(subcommand)) return `git ${subcommand}`;
	if (subcommand === "archive" && rest.some((arg) => /^--remote(?:=|$)/u.test(arg))) return "git archive --remote";
	const action = rest.find((arg) => !arg.startsWith("-"))?.toLowerCase();
	return action !== undefined && GIT_NETWORK_ACTIONS.get(subcommand)?.has(action)
		? `git ${subcommand} ${action}`
		: undefined;
}

/** The network client a command runs (`curl`, `git fetch`, `npm view`), looking through wrapper programs. */
function networkReach(args: readonly string[], depth = 0): string | undefined {
	const prefix = parseShellInvocationPrefixes([...args]);
	if (prefix.nonExecutingQuery) return undefined;
	const commandArgs = prefix.args;
	const name = executableName(commandArgs[0] ?? "").replace(/^\(/u, "");
	if (!name) return undefined;
	if (COMMAND_WRAPPERS.has(name)) {
		// Fail closed: a program behind more wrappers than the gate inspects may be a network client.
		if (depth >= MAX_WRAPPER_SCAN_DEPTH) return WRAPPED_TOO_DEEP;
		for (let index = 1; index < commandArgs.length; index++) {
			const reach = networkReach(commandArgs.slice(index), depth + 1);
			if (reach) return reach;
		}
		return undefined;
	}
	if (NETWORK_CLIENTS.has(name)) return name;
	if (
		commandArgs.some((arg) => DOTNET_NETWORK_TYPE_LITERAL_RE.test(arg)) ||
		(name === "new-object" && commandArgs.some((arg) => DOTNET_NETWORK_TYPE_NAME_RE.test(arg)))
	)
		return "System.Net";
	if (name === "git") return gitNetworkReach(commandArgs);
	const subcommand = commandArgs
		.slice(1)
		.find((arg) => !arg.startsWith("-"))
		?.toLowerCase();
	if (name === "gh")
		return subcommand === undefined || GH_LOCAL_SUBCOMMANDS.has(subcommand) ? undefined : `gh ${subcommand}`;
	return subcommand !== undefined && PACKAGE_MANAGER_NETWORK_SUBCOMMANDS.get(name)?.has(subcommand)
		? `${name} ${subcommand}`
		: undefined;
}

/**
 * Variables the gate resolves paths with (`$TMPDIR`, `~`, `cd`): a lane command may not reassign them, so
 * they keep meaning what the gate assumes. The lane's shell keeps its variables between calls.
 */
const PATH_VARIABLE_NAMES = new Set(["CDPATH", "HOME", "OLDPWD", "PWD", "TEMP", "TMP", "TMPDIR", "USERPROFILE"]);
const PATH_VARIABLE_DEFAULTING_RE = /\$\{(CDPATH|HOME|OLDPWD|PWD|TEMP|TMP|TMPDIR|USERPROFILE):?=/u;
const ASSIGNMENT_NAME_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/u;
const POSIX_PATH_VARIABLE_RE =
	/\$(?:\{(TMPDIR|TMP|TEMP|HOME|USERPROFILE)\}|(TMPDIR|TMP|TEMP|HOME|USERPROFILE)(?![A-Za-z0-9_]))/gu;
const POWERSHELL_PATH_VARIABLE_RE =
	/\$(?:\{env:(TMPDIR|TMP|TEMP|HOME|USERPROFILE)\}|env:(TMPDIR|TMP|TEMP|HOME|USERPROFILE)(?![A-Za-z0-9_])|(HOME)(?![A-Za-z0-9_]))/giu;
const POWERSHELL_NULL_TARGET_RE = /^(?:\$null|nul)$/iu;
/** A word the shell expands into a list of existing paths: a glob or a brace list. */
const GLOB_WORD_RE = /[*?[]|\{[^}]*(?:,|\.\.)[^}]*\}/u;
const MAX_GLOB_MATCHES = 2000;
const MAX_TRACKED_DIRECTORIES = 16;

/** Programs on the read-only list that open none of their operands. */
const NON_PATH_PROGRAMS = new Set([
	"[",
	"basename",
	"date",
	"dirname",
	"echo",
	"false",
	"format-list",
	"format-table",
	"free",
	"get-command",
	"get-location",
	"get-process",
	"get-psdrive",
	"hostname",
	"id",
	"lsof",
	"netstat",
	"pgrep",
	"printf",
	"ps",
	"pwd",
	"select-object",
	"sleep",
	"ss",
	"systemctl",
	"test",
	"tr",
	"true",
	"uname",
	"where-object",
	"which",
	"whoami",
	"write-output",
]);

/** How a program's arguments separate program text, patterns and counts from the paths it opens. */
interface OperandSyntax {
	/** Options whose value is text (a pattern, count or name), never a path. */
	readonly textValues: ReadonlySet<string>;
	/** Options that supply the program text, so no positional program text follows. */
	readonly programSources: ReadonlySet<string>;
	/** The first positional operand is program text: an awk program, a sed script, a jq filter, a pattern. */
	readonly positionalProgram: boolean;
	/** Options followed by a name and then a path (jq `--rawfile name file`). */
	readonly namedPaths?: ReadonlySet<string>;
	/** Options followed by two text values (jq `--arg name value`). */
	readonly pairValues?: ReadonlySet<string>;
	/** Only the operands before the first predicate are paths (find). */
	readonly pathsBeforePredicates?: boolean;
}

const SEARCH_PROGRAM_SOURCES = new Set(["-e", "--regexp", "-f", "--file"]);
const OPERAND_SYNTAX: ReadonlyMap<string, OperandSyntax> = new Map([
	[
		"grep",
		{
			textValues: new Set([
				"-e",
				"--regexp",
				"-m",
				"--max-count",
				"-A",
				"--after-context",
				"-B",
				"--before-context",
				"-C",
				"--context",
				"-d",
				"--directories",
				"-D",
				"--devices",
				"--label",
				"--include",
				"--exclude",
				"--exclude-dir",
				"--binary-files",
			]),
			programSources: SEARCH_PROGRAM_SOURCES,
			positionalProgram: true,
		},
	],
	[
		"rg",
		{
			textValues: new Set([
				"-e",
				"--regexp",
				"-g",
				"--glob",
				"--iglob",
				"-t",
				"--type",
				"-T",
				"--type-not",
				"--type-add",
				"--type-clear",
				"-m",
				"--max-count",
				"-A",
				"--after-context",
				"-B",
				"--before-context",
				"-C",
				"--context",
				"-j",
				"--threads",
				"-M",
				"--max-columns",
				"-d",
				"--max-depth",
				"-E",
				"--encoding",
				"-r",
				"--replace",
				"--sort",
				"--sortr",
				"--color",
				"--colors",
				"--path-separator",
				"--max-filesize",
				"--engine",
				"--context-separator",
				"--field-match-separator",
				"--field-context-separator",
			]),
			programSources: SEARCH_PROGRAM_SOURCES,
			positionalProgram: true,
		},
	],
	[
		"sed",
		{
			textValues: new Set(["-e", "--expression", "-l", "--line-length"]),
			programSources: new Set(["-e", "--expression", "-f", "--file"]),
			positionalProgram: true,
		},
	],
	[
		"awk",
		{
			textValues: new Set(["-F", "--field-separator", "-v", "--assign", "-e", "--source"]),
			programSources: new Set(["-e", "--source", "-f", "--file"]),
			positionalProgram: true,
		},
	],
	[
		"jq",
		{
			textValues: new Set(["--indent"]),
			programSources: new Set(["-f", "--from-file"]),
			positionalProgram: true,
			namedPaths: new Set(["--rawfile", "--slurpfile"]),
			pairValues: new Set(["--arg", "--argjson"]),
		},
	],
	[
		"select-string",
		{
			textValues: new Set(["-pattern", "-encoding", "-context", "-culture"]),
			programSources: new Set(["-pattern"]),
			positionalProgram: true,
		},
	],
	[
		"get-childitem",
		{
			textValues: new Set(["-filter", "-include", "-exclude", "-depth", "-attributes"]),
			programSources: new Set(),
			positionalProgram: false,
		},
	],
	[
		"fd",
		{
			textValues: new Set([
				"-e",
				"--extension",
				"-t",
				"--type",
				"-E",
				"--exclude",
				"-d",
				"--max-depth",
				"--min-depth",
				"--exact-depth",
				"-S",
				"--size",
				"--changed-within",
				"--changed-before",
				"-o",
				"--owner",
				"-j",
				"--threads",
				"--max-results",
			]),
			programSources: new Set(),
			positionalProgram: true,
		},
	],
	[
		"tree",
		{
			textValues: new Set(["-I", "-P", "-L", "--filelimit", "--charset"]),
			programSources: new Set(),
			positionalProgram: false,
		},
	],
	[
		"find",
		{ textValues: new Set(), programSources: new Set(), positionalProgram: false, pathsBeforePredicates: true },
	],
]);
const PLAIN_OPERAND_SYNTAX: OperandSyntax = {
	textValues: new Set(),
	programSources: new Set(),
	positionalProgram: false,
};

/** The words of one invocation the program opens as paths (option values after `=` and attached paths included). */
function pathOperands(name: string, args: readonly string[]): string[] {
	const syntax = OPERAND_SYNTAX.get(name) ?? PLAIN_OPERAND_SYNTAX;
	// PowerShell parameters are case-insensitive; POSIX short options are not (`-A` takes a value, `-a` does not).
	const optionKey = (option: string) => (name.includes("-") ? option.toLowerCase() : option);
	const operands: string[] = [];
	let programGiven = !syntax.positionalProgram;
	let endOfOptions = false;
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]!;
		if (syntax.pathsBeforePredicates && /^[-(!]/u.test(arg)) break;
		if (!endOfOptions && arg === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && arg.length > 1 && arg.startsWith("-")) {
			const separator = arg.startsWith("--") ? arg.indexOf("=") : -1;
			const option = optionKey(separator > 0 ? arg.slice(0, separator) : arg.slice(0, 2));
			const whole = optionKey(separator > 0 ? option : arg);
			if (syntax.programSources.has(whole) || syntax.programSources.has(option)) programGiven = true;
			if (syntax.pairValues?.has(whole)) {
				index += 2;
				continue;
			}
			if (syntax.namedPaths?.has(whole)) {
				index++;
				const path = args[++index];
				if (path !== undefined) operands.push(path);
				continue;
			}
			if (syntax.textValues.has(whole)) {
				if (separator < 0) index++;
				continue;
			}
			if (separator > 0) {
				if (!syntax.textValues.has(option)) operands.push(arg.slice(separator + 1));
				continue;
			}
			// A short option with its value attached (`-f/path`); a text option's value (`-e'x$'`) is text.
			if (!arg.startsWith("--") && arg.length > 2 && !syntax.textValues.has(option)) {
				const attached = arg.slice(2);
				if (/^[~$]|[\\/]/u.test(attached)) operands.push(attached);
			}
			continue;
		}
		if (!programGiven) {
			programGiven = true;
			continue;
		}
		operands.push(arg);
	}
	return operands;
}

/** Whether the program reads the contents of every file below a directory operand. */
function searchesRecursively(name: string, args: readonly string[]): boolean {
	const rest = args.slice(1);
	switch (name) {
		case "rg":
		case "git":
			return true;
		case "grep":
			return rest.some(
				(arg, index) =>
					/^-[A-Za-z]*[rR]/u.test(arg) ||
					/^--(?:recursive|dereference-recursive|directories=recurse)$/u.test(arg) ||
					((arg === "-d" || arg === "--directories") && rest[index + 1] === "recurse"),
			);
		case "diff":
			return rest.some((arg) => /^-[A-Za-z]*r/u.test(arg) || arg === "--recursive");
		case "get-childitem":
			return rest.some((arg) => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/iu.test(arg));
		default:
			return false;
	}
}

interface LaneShellContext {
	readonly lane: ReadOnlyShellLaneScope;
	readonly dialect: ShellCommandDialect;
	readonly depth: number;
}

function insideScratch(target: string, lane: ReadOnlyShellLaneScope): boolean {
	return lane.scratchRoots.some((root) => isPathWithinScope(target, root));
}

/** A word with `~`, `$HOME` and the scratch variables expanded the way the lane's shell expands them; undefined when anything else would expand. */
function expandLaneWord(word: string, context: LaneShellContext): string | undefined {
	const { lane } = context;
	let value = word;
	if (value === "~" || /^~[\\/]/u.test(value)) value = `${lane.homeDir}${value.slice(1)}`;
	else if (value.startsWith("~")) return undefined;
	let unresolved = false;
	value = value.replace(
		context.dialect === "powershell" ? POWERSHELL_PATH_VARIABLE_RE : POSIX_PATH_VARIABLE_RE,
		(_match: string, braced?: string, bare?: string, home?: string) => {
			const variable = (braced ?? bare ?? home ?? "").toUpperCase();
			if (variable === "HOME" || variable === "USERPROFILE") return lane.homeDir;
			const scratch = lane.scratchRoots[0];
			if (scratch === undefined) unresolved = true;
			return scratch ?? "";
		},
	);
	return unresolved || value.includes("$") ? undefined : value;
}

/** The existing paths a glob word names from `cwd`, or undefined when there are more than the gate checks. */
function globMatches(pattern: string, cwd: string): string[] | undefined {
	const matches: string[] = [];
	// Without the globstar option (which no read-only command can set) `**` matches what `*` matches.
	for (const match of globIterateSync(pattern.replace(/\*\*+/gu, "*"), {
		cwd,
		absolute: true,
		windowsPathsNoEscape: process.platform === "win32",
	})) {
		if (matches.length === MAX_GLOB_MATCHES) return undefined;
		matches.push(match);
	}
	return matches;
}

function deniedPathViolation(target: string, recursive: boolean, lane: ReadOnlyShellLaneScope): string | undefined {
	if (insideScratch(target, lane)) return undefined;
	if (lane.isDeniedPath(target)) return `it reads ${target}, a private harness or credential path`;
	if (!recursive) return undefined;
	let canonical: string;
	try {
		canonical = safeRealpathSync(target);
	} catch {
		return `it searches ${target}, a path the gate cannot resolve`;
	}
	const roots = [...new Set([target, canonical])];
	const reached = lane.harnessStoragePaths.find((storage) => roots.some((root) => isPathWithinScope(storage, root)));
	return reached === undefined ? undefined : `it searches ${target}, which holds the private harness path ${reached}`;
}

function lanePathViolation(
	word: string,
	cwds: readonly string[],
	recursive: boolean,
	context: LaneShellContext,
): string | undefined {
	const expanded = expandLaneWord(word, context);
	if (expanded === undefined) return `it names ${word}, a path the gate cannot resolve`;
	for (const cwd of cwds) {
		const targets = [nodePath.resolve(cwd, expanded)];
		if (GLOB_WORD_RE.test(expanded)) {
			const matches = globMatches(expanded, cwd);
			if (!matches) return `it names more than ${MAX_GLOB_MATCHES} paths through ${word}`;
			targets.push(...matches);
		}
		for (const target of targets) {
			const violation = deniedPathViolation(target, recursive, context.lane);
			if (violation) return violation;
		}
	}
	return undefined;
}

function laneWriteViolation(word: string, cwds: readonly string[], context: LaneShellContext): string | undefined {
	if (STREAM_TARGET_RE.test(word) || (context.dialect === "powershell" && POWERSHELL_NULL_TARGET_RE.test(word)))
		return undefined;
	const { lane } = context;
	if (lane.scratchRoots.length === 0) return `it writes ${word} and this worker has no scratch directory`;
	const expanded = expandLaneWord(word, context);
	if (expanded === undefined || GLOB_WORD_RE.test(expanded))
		return `it writes to ${word}, a path the gate cannot resolve`;
	const outside = cwds.map((cwd) => nodePath.resolve(cwd, expanded)).find((target) => !insideScratch(target, lane));
	return outside === undefined ? undefined : `it writes ${outside}, outside this worker's scratch directory`;
}

function pathVariableViolation(name: string): string {
	return `it reassigns ${name}, which the gate resolves paths with`;
}

/** The nested command text of `bash|sh|dash|zsh -c` or `powershell|pwsh -c|-Command`, with its dialect. */
function nestedShellCommand(
	name: string,
	commandArgs: readonly string[],
): { command: string; dialect: ShellCommandDialect } | undefined {
	if (SHELL_WRAPPERS.has(name)) {
		const index = commandArgs.indexOf("-c");
		const command = index > 0 ? commandArgs[index + 1] : undefined;
		return command === undefined ? undefined : { command, dialect: "posix" };
	}
	if (name === "powershell" || name === "pwsh") {
		const index = commandArgs.findIndex((arg) => /^-(?:c|command)$/iu.test(arg));
		return index > 0 ? { command: commandArgs.slice(index + 1).join(" "), dialect: "powershell" } : undefined;
	}
	return undefined;
}

/** The lane rules for one simple command; `cwds` are the directories it may run in. */
function laneInvocationViolation(
	args: readonly string[],
	cwds: readonly string[],
	context: LaneShellContext,
): string | undefined {
	const { lane } = context;
	for (const arg of args) {
		const defaulted = PATH_VARIABLE_DEFAULTING_RE.exec(arg);
		if (defaulted) return pathVariableViolation(defaulted[1]!);
	}
	// Assignments, `command` and `env` (any number of them), with `env`'s own directory and environment options.
	let commandArgs = [...args];
	let invocationCwds = [...cwds];
	// Every pass strips at least one word or stops, so this ends; the read/write line unwraps `env` without bound too.
	for (;;) {
		const prefix = parseShellInvocationPrefixes(commandArgs);
		if (prefix.nonExecutingQuery) return undefined;
		for (let index = 0; index < prefix.prefixes.length; index++) {
			const token = prefix.prefixes[index]!;
			const assignment = ASSIGNMENT_NAME_RE.exec(token);
			if (assignment && PATH_VARIABLE_NAMES.has(assignment[1]!)) return pathVariableViolation(assignment[1]!);
			if (!prefix.envExecutable) continue;
			const unset =
				token === "-u" || token === "--unset" ? prefix.prefixes[index + 1] : /^--unset=(.*)$/u.exec(token)?.[1];
			if (unset !== undefined && PATH_VARIABLE_NAMES.has(unset)) return pathVariableViolation(unset);
			if ((token === "-i" || token === "-" || token === "--ignore-environment") && prefix.args.length > 0)
				return "it clears the environment the gate resolves paths with (env -i)";
			const directory =
				token === "-C" || token === "--chdir" ? prefix.prefixes[index + 1] : /^--chdir=(.*)$/u.exec(token)?.[1];
			if (directory !== undefined) {
				const expanded = expandLaneWord(directory, context);
				if (expanded === undefined || GLOB_WORD_RE.test(expanded))
					return `it changes to ${directory}, a directory the gate cannot resolve`;
				const violation = lanePathViolation(directory, invocationCwds, false, context);
				if (violation) return violation;
				invocationCwds = invocationCwds.map((cwd) => nodePath.resolve(cwd, expanded));
			}
		}
		const unchanged = prefix.args.length === commandArgs.length;
		commandArgs = prefix.args;
		if (unchanged) break;
	}
	if (commandArgs.length === 0) return undefined;
	const programToken = commandArgs[0]!;
	const name = executableName(programToken);
	if (/[\\/]/u.test(programToken)) {
		const expanded = expandLaneWord(programToken, context);
		if (expanded !== undefined && invocationCwds.some((cwd) => insideScratch(nodePath.resolve(cwd, expanded), lane)))
			return "it runs a program from this worker's scratch directory";
	}
	if (!lane.network) {
		const reach = networkReach(commandArgs);
		if (reach === WRAPPED_TOO_DEEP)
			return "it nests a program in more wrapper programs than the gate inspects, so it may reach the network";
		if (reach) return `${reach} reaches the network and this worker holds no network grant`;
	}
	const effect = invocationEffect(commandArgs);
	if (effect) return effect;
	const nested = nestedShellCommand(name, commandArgs);
	if (nested) {
		// Deeper nesting is refused by the read/write line below.
		if (context.depth >= MAX_READ_ONLY_WRAPPER_DEPTH) return undefined;
		return laneShellViolation(nested.command, invocationCwds, {
			lane,
			dialect: nested.dialect,
			depth: context.depth + 1,
		});
	}
	if (name === "printf" && commandArgs.some((arg) => arg.startsWith("-v")))
		return "it sets a shell variable (printf -v)";
	if (name === "tee") {
		for (const word of commandArgs.slice(1)) {
			if (word.startsWith("-")) continue;
			const violation = laneWriteViolation(word, invocationCwds, context);
			if (violation) return violation;
		}
		return undefined;
	}
	if (NON_PATH_PROGRAMS.has(name)) return undefined;
	const recursive = searchesRecursively(name, commandArgs);
	const operands = pathOperands(name, commandArgs);
	if (name === "git") {
		// `git -C <dir>` runs (and resolves its paths) from <dir>.
		for (let index = 1; index < commandArgs.length - 1 && commandArgs[index]!.startsWith("-"); index++) {
			if (commandArgs[index] !== "-C") continue;
			const expanded = expandLaneWord(commandArgs[index + 1]!, context);
			if (expanded === undefined)
				return `it changes to ${commandArgs[index + 1]}, a directory the gate cannot resolve`;
			invocationCwds = [...invocationCwds, ...invocationCwds.map((cwd) => nodePath.resolve(cwd, expanded))];
		}
	}
	for (const operand of operands) {
		const violation = lanePathViolation(operand, invocationCwds, recursive, context);
		if (violation) return violation;
	}
	// A recursive search without a path operand searches where it runs; git always reads its work tree.
	if (recursive && (operands.length === 0 || name === "git")) {
		for (const cwd of invocationCwds) {
			const violation = deniedPathViolation(cwd, true, lane);
			if (violation) return violation;
		}
	}
	return undefined;
}

/** The directories `cd <target>` may leave the shell in, or a refusal when the target cannot be resolved. */
function changedDirectories(
	args: readonly string[],
	cwds: readonly string[],
	context: LaneShellContext,
): string[] | string {
	const operands = args.slice(1).filter((arg) => arg === "-" || !/^-(?:[LPe@]+|-)$/u.test(arg));
	const target = operands[0] ?? "~";
	if (target === "-") return "it returns to the previous directory (cd -), which the gate cannot resolve";
	const expanded = expandLaneWord(target, context);
	if (expanded === undefined || GLOB_WORD_RE.test(expanded))
		return `it changes to ${target}, a directory the gate cannot resolve`;
	const violation = lanePathViolation(target, cwds, false, context);
	if (violation) return violation;
	// The shell may stay where it was when `cd` fails, so both stay possible for what follows. A bare
	// relative name may also resolve below an inherited CDPATH entry.
	const viaCdPath =
		/^\.{1,2}(?:[\\/]|$)/u.test(expanded) || nodePath.isAbsolute(expanded)
			? []
			: cwds.flatMap((cwd) => context.lane.cdPath.map((entry) => nodePath.resolve(cwd, entry, expanded)));
	for (const directory of viaCdPath) {
		const violation = deniedPathViolation(directory, false, context.lane);
		if (violation) return violation;
	}
	const next = [...new Set([...cwds, ...cwds.map((cwd) => nodePath.resolve(cwd, expanded)), ...viaCdPath])];
	return next.length > MAX_TRACKED_DIRECTORIES ? "it changes directory more often than the gate tracks" : next;
}

/**
 * The lane rules over a whole command: every simple command (split on `;`, `&&`, `||`, `|`, `&` and
 * newlines by the shared tokenizer), every output redirection and every nested `bash -c`/`powershell -c`,
 * with `cd` tracked. Undefined when nothing breaks them; the read/write line still judges the command.
 */
function laneShellViolation(command: string, cwds: readonly string[], context: LaneShellContext): string | undefined {
	const tokens = tokenizeShellCommand(command, context.dialect);
	// The read/write line refuses a command it cannot parse.
	if (!tokens) return undefined;
	let possibleCwds = [...cwds];
	let invocation: string[] = [];
	const finishInvocation = (): string | undefined => {
		const args = invocation;
		invocation = [];
		if (args.length === 0) return undefined;
		const violation = laneInvocationViolation(args, possibleCwds, context);
		if (violation) return violation;
		const program = args.findIndex((arg) => !ASSIGNMENT_NAME_RE.test(arg));
		if (program < 0 || executableName(args[program]!) !== "cd") return undefined;
		const next = changedDirectories(args.slice(program), possibleCwds, context);
		if (typeof next === "string") return next;
		possibleCwds = next;
		return undefined;
	};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token.kind === "arg") {
			invocation.push(token.value);
			continue;
		}
		if (token.kind === "redirect") {
			// Input redirections are refused by the read/write line; `2>&1` and `>&-` name no file.
			if (!token.value.includes(">") || /&[\d-]+$/u.test(token.value)) continue;
			const target = tokens[index + 1];
			if (target?.kind !== "arg") return "it redirects output without naming a file";
			index++;
			const violation = laneWriteViolation(target.value, possibleCwds, context);
			if (violation) return violation;
			continue;
		}
		const violation = finishInvocation();
		if (violation) return violation;
	}
	return finishInvocation();
}

/**
 * Why a read-only lane may not run `command`, or undefined when it may.
 *
 * The read/write line: nothing that already exists is edited, and every command it calls mutating is
 * refused, including programs on the read-only list whose options or program text run other programs or
 * write files (`invocationEffect`). Without `lane`, as for requirement checks, output may still be
 * redirected or `tee`d into a NEW file.
 *
 * With `lane` (a read-only worker), three rules are added and applied through every wrapper (`env`,
 * `command`, `sudo`, `xargs`, ...), chain and nested `bash -c`/`powershell -c`: no network client without a
 * `network.http` grant; redirections and `tee` write only inside the lane's own scratch directory
 * (`$TMPDIR`), which also means a lane file may be rewritten there; and no operand, `cd` target or glob
 * match names a private harness or credential path, nor does a recursive search descend into harness
 * storage. Variables the gate resolves paths with may not be reassigned. This inspects the command text;
 * it is a policy gate, not OS isolation.
 */
export function readOnlyShellViolation(
	command: string,
	cwd: string,
	options: {
		/** A requirement check may run the project's tests (see TEST_RUN_RE); a read-only lane may not. */
		admitTestRuns?: boolean;
		/** A read-only worker lane's network grant, scratch directory and private paths. */
		lane?: ReadOnlyShellLaneScope;
		/** How the tool that runs the command splits it; the bash tool is POSIX-like on every platform. */
		dialect?: ShellCommandDialect;
	} = {},
): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;
	const lane = options.lane;
	if (lane) {
		const violation = laneShellViolation(trimmed, [nodePath.resolve(cwd)], {
			lane,
			dialect: options.dialect ?? "posix",
			depth: 0,
		});
		if (violation) return violation;
	}
	const targetExists = (word: string): string | undefined => {
		// A lane's write targets were all confined to its scratch directory above.
		if (lane) return undefined;
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
