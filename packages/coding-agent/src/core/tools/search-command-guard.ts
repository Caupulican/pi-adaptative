import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { tokenizeShellCommand } from "./shell-command-parser.ts";

export const BROAD_SEARCH_OUTPUT_ROUTE = "route-to-file" as const;

export type SearchScopeAssessment =
	| { kind: "scoped" }
	| { kind: "broad"; searchTool: "rg" | "grep" | "find" | "fd"; reason: string };

const RG_LONG_VALUE_FLAGS = new Set([
	"--after-context",
	"--before-context",
	"--color",
	"--colors",
	"--context",
	"--context-separator",
	"--encoding",
	"--engine",
	"--field-context-separator",
	"--field-match-separator",
	"--glob",
	"--iglob",
	"--ignore-file",
	"--max-columns",
	"--max-count",
	"--max-depth",
	"--max-filesize",
	"--path-separator",
	"--pre",
	"--pre-glob",
	"--replace",
	"--sort",
	"--sortr",
	"--threads",
	"--type",
	"--type-add",
	"--type-clear",
	"--type-not",
]);
const RG_SHORT_VALUE_FLAGS = new Set("ABCEMTdfgjmrt".split(""));
const RG_SCOPE_LONG_FLAGS = new Set(["--glob", "--iglob", "--max-depth", "--type", "--type-not"]);
const RG_SCOPE_SHORT_FLAGS = new Set(["g", "t", "T"]);
const RG_META_FLAGS = new Set(["--generate", "--help", "--pcre2-version", "--type-list", "--version", "-h"]);

type TargetScope = "current" | "global" | "narrow";

export type ShellContentSearchTool = "rg" | "grep";

export interface ShellSearchInvocationScope {
	targets: string[];
	positiveGlobs: string[];
	hasScopeFilter: boolean;
	readsStdin: boolean;
	metaOnly: boolean;
}

function targetScope(target: string, cwd: string): TargetScope {
	const normalized = target.trim().replace(/[\\/]+$/u, "") || target.trim();
	if (
		normalized === "/" ||
		normalized === "\\" ||
		/^[A-Za-z]:$/u.test(normalized) ||
		normalized === "~" ||
		normalized === "$HOME" ||
		normalized === "%USERPROFILE%" ||
		resolve(normalized) === resolve(homedir())
	) {
		return "global";
	}
	if (
		normalized === "." ||
		normalized === "*" ||
		normalized === "**" ||
		normalized === "./*" ||
		normalized === "./**" ||
		normalized === "$PWD" ||
		normalized === "$(pwd)" ||
		normalized === "%CD%" ||
		resolve(cwd, normalized) === resolve(cwd)
	)
		return "current";
	return "narrow";
}

function hasSafeTarget(targets: string[], cwd: string, hasScopeFilter: boolean): boolean {
	if (targets.includes("-")) return true;
	const scopes = (targets.length > 0 ? targets : ["."]).map((target) => targetScope(target, cwd));
	if (scopes.includes("global")) return false;
	return scopes.includes("narrow") || hasScopeFilter;
}

interface RgArguments {
	filesMode: boolean;
	hasPatternOption: boolean;
	hasScopeFilter: boolean;
	metaOnly: boolean;
	positionals: string[];
	positiveGlobs: string[];
}

function parseRgArguments(args: string[]): RgArguments {
	const parsed: RgArguments = {
		filesMode: false,
		hasPatternOption: false,
		hasScopeFilter: false,
		metaOnly: false,
		positionals: [],
		positiveGlobs: [],
	};
	let pastDoubleDash = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (pastDoubleDash) {
			parsed.positionals.push(arg);
			continue;
		}
		if (arg === "--") {
			pastDoubleDash = true;
			continue;
		}
		if (RG_META_FLAGS.has(arg)) {
			parsed.metaOnly = true;
			continue;
		}
		if (arg === "--files") {
			parsed.filesMode = true;
			continue;
		}
		if (arg === "--regexp" || arg === "--file") {
			parsed.hasPatternOption = true;
			index++;
			continue;
		}
		if (arg.startsWith("--regexp=") || arg.startsWith("--file=")) {
			parsed.hasPatternOption = true;
			continue;
		}
		if (arg === "--glob" || arg === "--iglob") {
			parsed.hasScopeFilter = true;
			const glob = args[++index];
			if (glob && !glob.startsWith("!")) parsed.positiveGlobs.push(glob);
			continue;
		}
		if (arg.startsWith("--glob=") || arg.startsWith("--iglob=")) {
			parsed.hasScopeFilter = true;
			const glob = arg.slice(arg.indexOf("=") + 1);
			if (glob && !glob.startsWith("!")) parsed.positiveGlobs.push(glob);
			continue;
		}
		if (arg.startsWith("--")) {
			const flag = arg.split("=", 1)[0];
			if (RG_SCOPE_LONG_FLAGS.has(flag)) parsed.hasScopeFilter = true;
			if (RG_LONG_VALUE_FLAGS.has(flag) && !arg.includes("=")) index++;
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) {
			const cluster = arg.slice(1);
			for (let flagIndex = 0; flagIndex < cluster.length; flagIndex++) {
				const flag = cluster[flagIndex];
				if (flag === "e" || flag === "f") parsed.hasPatternOption = true;
				if (RG_SCOPE_SHORT_FLAGS.has(flag)) parsed.hasScopeFilter = true;
				if (flag === "g") {
					const attachedGlob = cluster.slice(flagIndex + 1);
					const glob = attachedGlob || args[++index];
					if (glob && !glob.startsWith("!")) parsed.positiveGlobs.push(glob);
					break;
				}
				if (flag === "e" || RG_SHORT_VALUE_FLAGS.has(flag)) {
					if (flagIndex === cluster.length - 1) index++;
					break;
				}
			}
			continue;
		}
		parsed.positionals.push(arg);
	}

	return parsed;
}

function rgTargets(parsed: RgArguments): string[] {
	return parsed.filesMode
		? parsed.positionals
		: parsed.hasPatternOption
			? parsed.positionals
			: parsed.positionals.slice(1);
}

interface GrepArguments {
	recursive: boolean;
	hasScopeFilter: boolean;
	targets: string[];
	positiveGlobs: string[];
}

function parseGrepArguments(args: string[]): GrepArguments {
	const recursive = args.some(
		(arg) => arg === "-r" || arg === "-R" || arg === "--recursive" || /^-[^-]*[rR]/u.test(arg),
	);
	let hasPatternOption = false;
	let hasScopeFilter = false;
	const positiveGlobs: string[] = [];
	const positionals: string[] = [];
	const valueFlags = new Set(["-A", "-B", "-C", "-D", "-d", "-e", "-f", "-m", "--regexp", "--file"]);
	let pastDoubleDash = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (pastDoubleDash) {
			positionals.push(arg);
			continue;
		}
		if (arg === "--") {
			pastDoubleDash = true;
			continue;
		}
		if (arg === "--include") {
			hasScopeFilter = true;
			const glob = args[++index];
			if (glob) positiveGlobs.push(glob);
			continue;
		}
		if (arg.startsWith("--include=")) {
			hasScopeFilter = true;
			const glob = arg.slice("--include=".length);
			if (glob) positiveGlobs.push(glob);
			continue;
		}
		if (["--exclude", "--exclude-dir"].includes(arg)) {
			hasScopeFilter = true;
			index++;
			continue;
		}
		if (arg.startsWith("--exclude=") || arg.startsWith("--exclude-dir=")) {
			hasScopeFilter = true;
			continue;
		}
		if (arg === "-e" || arg === "-f" || arg === "--regexp" || arg === "--file") {
			hasPatternOption = true;
			index++;
			continue;
		}
		if (arg.startsWith("--regexp=") || arg.startsWith("--file=")) {
			hasPatternOption = true;
			continue;
		}
		if (valueFlags.has(arg)) {
			index++;
			continue;
		}
		if (!arg.startsWith("-")) positionals.push(arg);
	}

	return {
		recursive,
		hasScopeFilter,
		targets: hasPatternOption ? positionals : positionals.slice(1),
		positiveGlobs,
	};
}

/** One owner for filesystem targets, include globs, and stdin across both shell search guards. */
export function parseShellSearchInvocationScope(
	searchTool: ShellContentSearchTool,
	args: string[],
	readsPipe: boolean,
): ShellSearchInvocationScope {
	if (searchTool === "rg") {
		const parsed = parseRgArguments(args);
		const targets = rgTargets(parsed);
		return {
			targets,
			positiveGlobs: parsed.positiveGlobs,
			hasScopeFilter: parsed.hasScopeFilter,
			readsStdin: readsPipe && targets.length === 0 && !parsed.filesMode,
			metaOnly: parsed.metaOnly,
		};
	}

	const parsed = parseGrepArguments(args);
	return {
		targets: parsed.targets,
		positiveGlobs: parsed.positiveGlobs,
		hasScopeFilter: parsed.hasScopeFilter,
		readsStdin: readsPipe && parsed.targets.length === 0,
		metaOnly: false,
	};
}

function assessRg(args: string[], cwd: string, readsPipe: boolean): SearchScopeAssessment {
	const scope = parseShellSearchInvocationScope("rg", args, readsPipe);
	if (scope.metaOnly || scope.readsStdin) return { kind: "scoped" };
	if (hasSafeTarget(scope.targets, cwd, scope.hasScopeFilter)) return { kind: "scoped" };
	return {
		kind: "broad",
		searchTool: "rg",
		reason: "rg would search the whole working tree without a narrow path, glob, or type filter",
	};
}

function assessRecursiveGrep(args: string[], cwd: string, readsPipe: boolean): SearchScopeAssessment {
	const parsed = parseGrepArguments(args);
	if (!parsed.recursive) return { kind: "scoped" };
	const scope = parseShellSearchInvocationScope("grep", args, readsPipe);
	if (scope.readsStdin || hasSafeTarget(scope.targets, cwd, scope.hasScopeFilter)) return { kind: "scoped" };
	return {
		kind: "broad",
		searchTool: "grep",
		reason: "recursive grep would scan the whole working tree without a narrow path or include filter",
	};
}

function assessFind(args: string[], cwd: string): SearchScopeAssessment {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "-H" || arg === "-L" || arg === "-P" || /^-O\d*$/u.test(arg)) index++;
		else if (arg === "-D") index += 2;
		else break;
	}
	const targets: string[] = [];
	while (index < args.length && !args[index].startsWith("-") && args[index] !== "!" && args[index] !== "(") {
		targets.push(args[index++]);
	}
	const hasScopeFilter = args.some((arg) => ["-iname", "-ipath", "-iregex", "-name", "-path", "-regex"].includes(arg));
	if (hasSafeTarget(targets, cwd, hasScopeFilter)) return { kind: "scoped" };
	return {
		kind: "broad",
		searchTool: "find",
		reason: "find would enumerate the whole working tree without a narrow path or name/path predicate",
	};
}

function assessFd(args: string[], cwd: string): SearchScopeAssessment {
	const positionals: string[] = [];
	let hasScopeFilter = false;
	let pastDoubleDash = false;
	const valueFlags = new Set([
		"-d",
		"--max-depth",
		"--min-depth",
		"-e",
		"--extension",
		"-E",
		"--exclude",
		"-t",
		"--type",
		"--base-directory",
		"--changed-before",
		"--changed-within",
		"--color",
		"--owner",
		"--path-separator",
		"--search-path",
	]);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (pastDoubleDash) positionals.push(arg);
		else if (arg === "--") pastDoubleDash = true;
		else if (arg === "-e" || arg === "--extension") {
			hasScopeFilter = true;
			index++;
		} else if (arg.startsWith("--extension=")) hasScopeFilter = true;
		else if (valueFlags.has(arg)) index++;
		else if (!arg.startsWith("-")) positionals.push(arg);
	}
	const pattern = positionals[0];
	const targets = positionals.slice(1);
	const meaningfulPattern = Boolean(pattern && pattern !== "." && pattern !== ".*" && pattern !== "*");
	if (meaningfulPattern || hasSafeTarget(targets, cwd, hasScopeFilter)) return { kind: "scoped" };
	return {
		kind: "broad",
		searchTool: "fd",
		reason: "fd would enumerate the whole working tree without a narrow pattern, path, glob, extension, or type",
	};
}

function commandName(value: string): string {
	return basename(value)
		.toLowerCase()
		.replace(/\.exe$/u, "");
}

function stripInvocationPrefixes(args: string[]): string[] {
	let index = 0;
	while (index < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(args[index])) index++;
	if (args[index] === "command") {
		index++;
		while (args[index]?.startsWith("-")) index++;
	}
	if (args[index] === "env") {
		index++;
		while (args[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(args[index] ?? "")) index++;
	}
	return args.slice(index);
}

function assessInvocation(args: string[], cwd: string, readsPipe: boolean): SearchScopeAssessment {
	const invocation = stripInvocationPrefixes(args);
	const name = commandName(invocation[0] ?? "");
	const commandArgs = invocation.slice(1);
	switch (name) {
		case "rg":
		case "ripgrep":
			return assessRg(commandArgs, cwd, readsPipe);
		case "grep":
			return assessRecursiveGrep(commandArgs, cwd, readsPipe);
		case "find":
			return assessFind(commandArgs, cwd);
		case "fd":
		case "fdfind":
			return assessFd(commandArgs, cwd);
		default:
			return { kind: "scoped" };
	}
}

/**
 * Reject shell searches whose filesystem scope cannot be proven narrow. Dedicated grep/find
 * tools already own result caps and artifacts; this closes the raw-shell bypass before execution.
 */
export function assessShellSearchScope(command: string, cwd: string): SearchScopeAssessment {
	const tokens = tokenizeShellCommand(command);
	if (!tokens) {
		return { kind: "scoped" };
	}

	let invocation: string[] = [];
	let ignoreRedirectTarget = false;
	let readsPipe = false;
	const assessCurrent = (): SearchScopeAssessment => assessInvocation(invocation, cwd, readsPipe);

	for (const token of tokens) {
		if (token.kind === "arg") {
			if (!ignoreRedirectTarget) invocation.push(token.value);
			continue;
		}
		if (token.kind === "redirect") {
			ignoreRedirectTarget = true;
			continue;
		}
		const assessment = assessCurrent();
		if (assessment.kind === "broad") return assessment;
		invocation = [];
		ignoreRedirectTarget = false;
		readsPipe = token.kind === "pipe";
	}

	return assessCurrent();
}

/**
 * Ripgrep and grep reserve exit code 1 for a successful search with zero matches. Shell lists
 * return the final command's status, so compound diagnostics ending in either search must preserve
 * that semantic instead of turning an empty result into a tool failure. This scans the
 * already-bounded command once and only accepts an unambiguous final invocation; syntax, IO, and
 * regex errors remain exit code 2.
 */
export function expectedContentSearchNoMatch(
	command: string,
	exitCode: number | null,
): ShellContentSearchTool | undefined {
	if (exitCode !== 1) return undefined;
	const tokens = tokenizeShellCommand(command);
	if (!tokens) return undefined;

	let invocation: string[] = [];
	let ignoreRedirectTarget = false;
	let connector: string | undefined;
	let invocationConnector: string | undefined;
	let finalInvocation: string[] | undefined;
	let finalInvocationConnector: string | undefined;
	const finishInvocation = () => {
		if (invocation.length > 0) {
			finalInvocation = invocation;
			finalInvocationConnector = invocationConnector;
		}
		invocation = [];
		invocationConnector = undefined;
	};
	for (const token of tokens) {
		if (token.kind === "arg") {
			if (!ignoreRedirectTarget) {
				if (invocation.length === 0) invocationConnector = connector;
				invocation.push(token.value);
			}
			continue;
		}
		if (token.kind === "redirect") {
			ignoreRedirectTarget = true;
			continue;
		}
		finishInvocation();
		ignoreRedirectTarget = false;
		connector = token.value;
	}
	finishInvocation();

	// `prior && search` can return the prior command's exit 1 without executing the search.
	if (!finalInvocation || finalInvocationConnector === "&&") return undefined;
	const normalizedInvocation = stripInvocationPrefixes(finalInvocation);
	const name = commandName(normalizedInvocation[0] ?? "");
	if (name === "rg" || name === "ripgrep") return "rg";
	return name === "grep" ? "grep" : undefined;
}
