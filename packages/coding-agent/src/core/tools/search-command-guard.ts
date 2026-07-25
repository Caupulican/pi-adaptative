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
}

function parseRgArguments(args: string[]): RgArguments {
	const parsed: RgArguments = {
		filesMode: false,
		hasPatternOption: false,
		hasScopeFilter: false,
		metaOnly: false,
		positionals: [],
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

function assessRg(args: string[], cwd: string, readsPipe: boolean): SearchScopeAssessment {
	const parsed = parseRgArguments(args);
	if (parsed.metaOnly) return { kind: "scoped" };
	const targets = parsed.filesMode
		? parsed.positionals
		: parsed.hasPatternOption
			? parsed.positionals
			: parsed.positionals.slice(1);
	if (readsPipe && targets.length === 0 && !parsed.filesMode) return { kind: "scoped" };
	if (hasSafeTarget(targets, cwd, parsed.hasScopeFilter)) return { kind: "scoped" };
	return {
		kind: "broad",
		searchTool: "rg",
		reason: "rg would search the whole working tree without a narrow path, glob, or type filter",
	};
}

function assessRecursiveGrep(args: string[], cwd: string, readsPipe: boolean): SearchScopeAssessment {
	const recursive = args.some(
		(arg) => arg === "-r" || arg === "-R" || arg === "--recursive" || /^-[^-]*[rR]/u.test(arg),
	);
	if (!recursive || readsPipe) return { kind: "scoped" };
	const hasPatternOption = args.some((arg) => arg === "-e" || arg.startsWith("-e") || arg === "--regexp");
	const hasScopeFilter = args.some(
		(arg) =>
			arg === "--include" ||
			arg.startsWith("--include=") ||
			arg === "--exclude" ||
			arg.startsWith("--exclude=") ||
			arg === "--exclude-dir" ||
			arg.startsWith("--exclude-dir="),
	);
	const valueFlags = new Set(["-A", "-B", "-C", "-D", "-d", "-e", "-f", "-m", "--regexp"]);
	const positionals: string[] = [];
	let pastDoubleDash = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (pastDoubleDash) positionals.push(arg);
		else if (arg === "--") pastDoubleDash = true;
		else if (valueFlags.has(arg) || ["--include", "--exclude", "--exclude-dir"].includes(arg)) index++;
		else if (!arg.startsWith("-")) positionals.push(arg);
	}
	const targets = hasPatternOption ? positionals : positionals.slice(1);
	if (hasSafeTarget(targets, cwd, hasScopeFilter)) return { kind: "scoped" };
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
