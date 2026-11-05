import { existsSync } from "node:fs";
import * as nodePath from "node:path";
import { globIterateSync } from "glob";
import { isPathWithinScope, physicalPathSync, safeRealpathSync } from "../autonomy/path-scope.ts";
import {
	MAX_TRACKED_DIRECTORIES,
	parseShellInvocationPrefixes,
	redirectTakesTarget,
	type ShellCommandDialect,
	type ShellToken,
	tokenizeShellCommand,
} from "../tools/shell-command-parser.ts";

/**
 * The read-only shell line: one structural walk over the shared tokenizer's output that every caller uses (the
 * router's mutation line, System One's observational line, requirement checks and read-only worker lanes). It judges
 * program and subcommand positions, options and redirections of each simple command, never raw command text, so a
 * pattern such as `rg "npm run"` or `awk '$3 > 100'` is data. It inspects the command text: a policy gate, not OS
 * isolation.
 */

/** Interpreters and clients whose effects stay with semantic judgment even when their arguments look read-only. */
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
	"yarn",
]);
const SHELL_WRAPPERS = new Set(["bash", "dash", "sh", "zsh"]);

/** Programs the read-only line admits; their options, subcommands and operands are judged below. */
const READ_ONLY_COMMANDS = new Set([
	":",
	"[",
	"[[",
	"awk",
	"basename",
	"cat",
	"cd",
	"cmp",
	"column",
	"comm",
	"curl",
	"cut",
	"date",
	"df",
	"diff",
	"dirname",
	"du",
	"echo",
	"false",
	"fd",
	"file",
	"find",
	"free",
	"git",
	"grep",
	"head",
	"hostname",
	"id",
	"journalctl",
	"jq",
	"ls",
	"lsof",
	"md5sum",
	"netstat",
	"nl",
	"node",
	"npm",
	"nproc",
	"od",
	"pgrep",
	"pnpm",
	"printf",
	"ps",
	"pwd",
	"readlink",
	"realpath",
	"rg",
	"sed",
	"seq",
	"sha1sum",
	"sha256sum",
	"sleep",
	"sort",
	"ss",
	"stat",
	"strings",
	"systemctl",
	"tac",
	"tail",
	"tee",
	"test",
	"tr",
	"tree",
	"true",
	"uname",
	"uniq",
	"uptime",
	"wc",
	"which",
	"whoami",
	"yarn",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"blame",
	"cat-file",
	"check-ignore",
	"describe",
	"diff",
	"diff-tree",
	"for-each-ref",
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
	"version",
]);
/** `git branch` and `git tag` list refs, but a positional name or a ref-changing flag creates, moves or deletes one. */
const GIT_REF_LISTING_SUBCOMMANDS = new Set(["branch", "tag"]);
const GIT_REF_MUTATING_FLAG_RE =
	/^(?:-[dDmMcCfu]|--delete|--move|--copy|--force|--set-upstream-to(?:=.*)?|--unset-upstream|--edit-description|-a|--annotate|-s|--sign|-F|--file(?:=.*)?)$/u;
/** Ref-listing options that take the next word as their value (a commit, a sort key, a format). */
const GIT_REF_LISTING_VALUE_OPTIONS = new Set([
	"--contains",
	"--no-contains",
	"--merged",
	"--no-merged",
	"--points-at",
	"--sort",
	"--format",
]);
const GIT_CONFIG_READ_OPTIONS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "-l", "--list"]);
const GIT_CONFIG_WRITE_OPTION_RE =
	/^(?:--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section|-e|--edit|--fixed-value)$/u;
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
const READ_ONLY_NPM_SUBCOMMANDS = new Set(["info", "list", "ls", "outdated", "view", "whoami"]);

/** Node runs arbitrary code; only printing its version and syntax-checking a file read nothing else. */
const NODE_READ_ONLY_RE = /^(?:-v|--version|-c|--check)$/u;

/**
 * Variables a command may set: none of them names a program, a library, a configuration file or a path that
 * another program reads, so setting one cannot turn a read into anything else. Every other variable can
 * (`RIPGREP_CONFIG_PATH`, `GIT_*`, `XDG_CONFIG_HOME`, `npm_config_*`, `LD_PRELOAD`, `PAGER`, ...).
 */
const ALLOWED_ASSIGNMENT_RE = /^(?:LANG|LC_[A-Z]+|TZ|NO_COLOR|COLUMNS|TERM|FORCE_COLOR)$/u;
/** A requirement check's test run may also select the project's own mode: it already executes project code. */
const TEST_RUN_ASSIGNMENT_RE = /^(?:CI|NODE_ENV)$/u;
const ALLOWED_ASSIGNMENT_TEXT = "LANG, LC_*, TZ, NO_COLOR, COLUMNS, TERM and FORCE_COLOR";
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/u;

/**
 * A run of the project's own tests: how a requirement check proves code works. It executes project
 * code the agent may already run, and may write the runner's own caches and reports; an option that
 * rewrites project files (snapshot update, fix) or never finishes (watch) is not a test run.
 */
const TEST_RUN_RE =
	/^(?:(?:(?:npx|bunx)|(?:pnpm|yarn)\s+exec)\s+)?(?:vitest\s+run|jest|mocha|pytest)(?:\s|$)|^node\s+--test(?:\s|$)|^python3?\s+-m\s+(?:pytest|unittest)(?:\s|$)|^(?:go|cargo|deno|bun)\s+test(?:\s|$)|^(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/u;
const TEST_RUN_WRITE_OPTION_RE = /^(?:-u|--update\S*|--watch\S*|--fix\S*)$/u;
/**
 * A type check a requirement check may run: `tsc --noEmit` emits nothing but may write its own incremental build
 * cache, as a test run writes its runner's caches. Options that create files, build projects or never finish are not.
 */
const TSC_CHECK_EFFECT_RE = /^(?:--init|--build|-b|--watch|-w|--generateTrace|--tsBuildInfoFile)(?:=|$)/u;

const MAX_NESTED_SHELL_DEPTH = 2;

export function executableName(token: string): string {
	return (token.replace(/\\/gu, "/").split("/").at(-1) ?? token).toLowerCase().replace(/\.exe$/u, "");
}

/**
 * What a read-only worker lane may reach beyond the read/write line, supplied by the lane's own tool
 * surface. A lane reaches the network only with `network.http`, creates files only inside its own
 * scratch directory and reads no private harness or credential path.
 */
export interface ReadOnlyShellLaneScope {
	/** The lane holds `network.http`; without it every network client and network share is refused. */
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
	/**
	 * The credential guard's path policy over the lane's denied paths (canonical paths, case rules, dotenv names), plus
	 * everything outside the lane's read scope when its host confines reads.
	 */
	isDeniedPath(absolutePath: string): boolean;
}

/**
 * How a judged command may write files. `none`: not at all (the router's mutation line). `new`: only into a path
 * that does not exist yet (requirement checks). `scratch`: only inside the lane's scratch directory.
 */
type WriteRule = "none" | "new" | "scratch";

interface JudgeContext {
	readonly dialect: ShellCommandDialect;
	readonly depth: number;
	readonly writes: WriteRule;
	readonly admitTestRuns: boolean;
	readonly lane: ReadOnlyShellLaneScope | undefined;
	/** Every program judged (wrappers and wrapped programs included), for the observational line. */
	readonly programs: string[];
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

/** A program the gate judges by name: what a wrapper program (`timeout 5 curl ...`) runs. */
function isKnownProgram(name: string): boolean {
	return (
		COMMAND_WRAPPERS.has(name) ||
		NETWORK_CLIENTS.has(name) ||
		READ_ONLY_COMMANDS.has(name) ||
		SHELL_WRAPPERS.has(name) ||
		EFFECTFUL_INTERPRETERS.has(name) ||
		PACKAGE_MANAGER_NETWORK_SUBCOMMANDS.has(name) ||
		name === "gh" ||
		name === "new-object"
	);
}

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
function networkReach(args: readonly string[]): string | undefined {
	const prefix = parseShellInvocationPrefixes([...args]);
	if (prefix.nonExecutingQuery) return undefined;
	const commandArgs = prefix.args;
	const name = executableName(commandArgs[0] ?? "").replace(/^\(/u, "");
	if (!name) return undefined;
	if (COMMAND_WRAPPERS.has(name)) {
		// The wrapped program is the first word naming a program the gate knows; options and their values
		// (`-s KILL`, `5`, `-I {}`) are skipped, and a later word (`xargs grep -l curl`) is that program's operand.
		// Every pass consumes a word, so the walk ends. The read/write line refuses wrapper programs too.
		const wrapped = commandArgs.findIndex((arg, index) => index > 0 && isKnownProgram(executableName(arg)));
		return wrapped < 0 ? undefined : networkReach(commandArgs.slice(wrapped));
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
 * awk program text that runs a command, pipes to or from one, reads a named file, prints into one, or rewrites
 * ARGV/ARGC (which name the files awk opens next, so a program can read a file its command line never names).
 */
const AWK_PROGRAM_EFFECT_RE =
	/\bsystem\s*\(|(?<!\|)\|(?!\|)|\bgetline\b[^;{}]*<|\bprintf?\b[^;{}]*>|@(?:load|include|namespace)\b|\bARG[VC]\b/u;
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

/** jq program text that imports or includes a module file: jq reads it from its library path. */
const JQ_MODULE_DIRECTIVE_RE = /(?:^|[^\w$."])(?:import|include)\s+"/u;
/** curl short options that write a file, read a configuration, upload or send a request body, or change the method. */
const CURL_EFFECT_LETTERS = "oODcKTdFXn";
/** curl short options that take a value: the rest of the cluster, else the next word. */
const CURL_VALUE_LETTERS = "AbcCDdEeFHhKmoPQrTtuUwXxYyz";
const CURL_EFFECT_LONG_OPTION_RE =
	/^--(?:output|output-dir|create-dirs|remote-name[a-z-]*|dump-header|cookie-jar|trace|trace-ascii|stderr|libcurl|etag-save|hsts|alt-svc|config|upload-file|data[a-z-]*|form[a-z-]*|json|request|post[a-z0-9-]*|netrc[a-z-]*)(?:=|$)/u;
const FIND_EFFECT_PREDICATE_RE = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/u;
const JOURNALCTL_EFFECT_OPTION_RE =
	/^--(?:vacuum-[a-z]+|rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog|cursor-file)(?:=|$)/u;

/** Why a curl invocation writes a file, reads a local or configured one, or sends more than a GET; undefined when it does not. */
function curlEffect(rest: readonly string[]): string | undefined {
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index]!;
		if (arg === "--") break;
		if (/^file:/iu.test(arg)) return `curl reads the local file ${arg} through a file: URL`;
		if (arg.startsWith("--")) {
			if (CURL_EFFECT_LONG_OPTION_RE.test(arg))
				return `curl ${arg} writes a file, reads a configuration or sends data`;
			const [option, attached] = arg.includes("=")
				? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
				: [arg, undefined];
			if (option === "--write-out" || option === "--header") {
				const value = attached ?? rest[++index] ?? "";
				if (value.startsWith("@") || value.includes("%output{"))
					return `curl ${option} ${value} reads or writes a file`;
			}
			continue;
		}
		if (!arg.startsWith("-") || arg.length < 2) continue;
		for (let letterIndex = 1; letterIndex < arg.length; letterIndex++) {
			const letter = arg[letterIndex]!;
			if (CURL_EFFECT_LETTERS.includes(letter))
				return `curl -${letter} writes a file, reads a configuration or sends data`;
			if (!CURL_VALUE_LETTERS.includes(letter)) continue;
			const value = arg.slice(letterIndex + 1) || rest[++index] || "";
			if ((letter === "w" || letter === "H") && (value.startsWith("@") || value.includes("%output{")))
				return `curl -${letter} ${value} reads or writes a file`;
			break;
		}
	}
	return undefined;
}

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
			effect = found(
				(arg) => /^-[^-]*[oT]/u.test(arg) || /^--(?:output|compress-program|temporary-directory)(?:=|$)/u.test(arg),
			);
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
		case "find":
			effect = found((arg) => FIND_EFFECT_PREDICATE_RE.test(arg));
			break;
		case "journalctl":
			effect = found((arg) => JOURNALCTL_EFFECT_OPTION_RE.test(arg));
			break;
		case "printf":
			effect = found((arg) => arg.startsWith("-v"));
			break;
		case "ps":
			// The BSD `e` modifier prints every listed process's environment, the owner's processes included.
			effect = found((arg) => !arg.startsWith("-") && /^[A-Za-z]+$/u.test(arg) && arg.includes("e"));
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
		case "jq": {
			const program = pathOperandsWithProgram("jq", commandArgs).program;
			if (program !== undefined && JQ_MODULE_DIRECTIVE_RE.test(program))
				return "jq imports a module file, which the gate does not judge";
			break;
		}
		case "curl":
			return curlEffect(rest);
	}
	return effect === undefined
		? undefined
		: `${name} ${JSON.stringify(effect)} can run another program or touch a file`;
}

/**
 * Variables the gate resolves paths with (`$TMPDIR`, `~`, `cd`). None is on the assignment allowlist, so a command
 * never reassigns them; `env -u` and `env -i` are refused for them too, and the lane's shell keeps its variables
 * between calls.
 */
const PATH_VARIABLE_NAMES = new Set(["CDPATH", "HOME", "OLDPWD", "PWD", "TEMP", "TMP", "TMPDIR", "USERPROFILE"]);
const POSIX_PATH_VARIABLE_RE =
	/\$(?:\{(TMPDIR|TMP|TEMP|HOME|USERPROFILE)\}|(TMPDIR|TMP|TEMP|HOME|USERPROFILE)(?![A-Za-z0-9_]))/gu;
const POWERSHELL_PATH_VARIABLE_RE =
	/\$(?:\{env:(TMPDIR|TMP|TEMP|HOME|USERPROFILE)\}|env:(TMPDIR|TMP|TEMP|HOME|USERPROFILE)(?![A-Za-z0-9_])|(HOME)(?![A-Za-z0-9_]))/giu;
const POWERSHELL_NULL_TARGET_RE = /^(?:\$null|nul)$/iu;
const STREAM_TARGET_RE = /^(?:\/dev\/(?:null|stdout|stderr|tty))$/u;
/** A word the shell expands into a list of existing paths: a glob or a brace list. */
const GLOB_WORD_RE = /[*?[]|\{[^}]*(?:,|\.\.)[^}]*\}/u;
/** A network share: `\\host\share`, `//host/share` or `\\?\UNC\host\share`; not a local device path (`\\?\C:`, `\\.\`). */
const NETWORK_SHARE_RE = /^(?:\\\\\?\\UNC\\|[\\/]{2}(?![?.][\\/]))/iu;
const MAX_GLOB_MATCHES = 2000;

/** Programs on the read-only list that open none of their operands. */
const NON_PATH_PROGRAMS = new Set([
	":",
	"[",
	"[[",
	"basename",
	"dirname",
	"echo",
	"false",
	"free",
	"hostname",
	"id",
	"lsof",
	"netstat",
	"nproc",
	"printf",
	"ps",
	"pwd",
	"seq",
	"sleep",
	"systemctl",
	"test",
	"tr",
	"true",
	"uname",
	"uptime",
	"which",
	"whoami",
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
	/** Options whose value is a directory the program reads everything below (jq `-L`). */
	readonly recursivePaths?: ReadonlySet<string>;
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
			textValues: new Set(["--indent", "--tab"]),
			programSources: new Set(["-f", "--from-file"]),
			positionalProgram: true,
			namedPaths: new Set(["--rawfile", "--slurpfile"]),
			pairValues: new Set(["--arg", "--argjson"]),
			recursivePaths: new Set(["-L", "--library-path"]),
		},
	],
	[
		"date",
		{
			textValues: new Set(["-d", "--date", "-I", "--iso-8601", "--rfc-3339"]),
			programSources: new Set(),
			positionalProgram: false,
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

interface ParsedOperands {
	/** Words the program opens as paths (option values after `=` and attached paths included). */
	readonly paths: string[];
	/** Directories the program reads everything below (jq `-L`). */
	readonly recursivePaths: string[];
	/** The positional program text, when the program takes one and no option supplied it. */
	readonly program?: string;
}

/**
 * How an option word splits for `syntax`: its key (case-insensitive for PowerShell parameters; a short option's
 * first letter), the whole option without a `=value`, and the value written in the same word.
 */
function optionParts(name: string, arg: string): { key: string; whole: string; attached?: string } {
	const fold = (option: string) => (name.includes("-") ? option.toLowerCase() : option);
	if (arg.startsWith("--") || name.includes("-")) {
		const separator = arg.indexOf("=");
		if (separator > 0)
			return {
				key: fold(arg.slice(0, separator)),
				whole: fold(arg.slice(0, separator)),
				attached: arg.slice(separator + 1),
			};
		return { key: fold(arg), whole: fold(arg) };
	}
	return { key: arg.slice(0, 2), whole: arg, ...(arg.length > 2 ? { attached: arg.slice(2) } : {}) };
}

/** The words of one invocation the program opens, and its positional program text. */
function pathOperandsWithProgram(name: string, args: readonly string[]): ParsedOperands {
	const syntax = OPERAND_SYNTAX.get(name) ?? PLAIN_OPERAND_SYNTAX;
	const paths: string[] = [];
	const recursivePaths: string[] = [];
	let program: string | undefined;
	// An option that supplies the program text may follow the operands (`rg ~/dir -e token`): find it first, so a
	// path before it is never mistaken for the program.
	let programGiven =
		!syntax.positionalProgram ||
		args.slice(1).some((arg) => {
			if (arg === "--") return false;
			if (!arg.startsWith("-") || arg.length < 2) return false;
			const { key, whole } = optionParts(name, arg);
			return syntax.programSources.has(whole) || syntax.programSources.has(key);
		});
	let endOfOptions = false;
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]!;
		if (syntax.pathsBeforePredicates && /^[-(!]/u.test(arg)) break;
		if (!endOfOptions && arg === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && arg.length > 1 && arg.startsWith("-")) {
			const { key, whole, attached } = optionParts(name, arg);
			if (syntax.pairValues?.has(whole)) {
				index += 2;
				continue;
			}
			if (syntax.namedPaths?.has(whole)) {
				index++;
				const path = args[++index];
				if (path !== undefined) paths.push(path);
				continue;
			}
			if (syntax.recursivePaths?.has(whole) || syntax.recursivePaths?.has(key)) {
				const value = attached ?? args[++index];
				if (value !== undefined) recursivePaths.push(value);
				continue;
			}
			if (syntax.textValues.has(whole) || syntax.textValues.has(key)) {
				if (attached === undefined) index++;
				continue;
			}
			if (attached === undefined) {
				// A program-source option without a text value (`grep -f FILE`, `jq -f FILE`) names a file: the next word.
				if (syntax.programSources.has(whole)) {
					const path = args[++index];
					if (path !== undefined) paths.push(path);
				}
				continue;
			}
			// A long option's `=value`, a program file (`-fFILE`), or a short option's attached value that reads like a path.
			if (
				arg.startsWith("--") ||
				name.includes("-") ||
				syntax.programSources.has(key) ||
				/^[~$]|[\\/]/u.test(attached)
			)
				paths.push(attached);
			continue;
		}
		if (!programGiven) {
			programGiven = true;
			program = arg;
			continue;
		}
		paths.push(arg);
	}
	return { paths, recursivePaths, ...(program !== undefined ? { program } : {}) };
}

/** Whether the program reads the contents of every file below a directory operand. */
function searchesRecursively(name: string, args: readonly string[]): boolean {
	const rest = args.slice(1);
	switch (name) {
		case "rg":
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
		case "select-string":
			return rest.some((arg) => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/iu.test(arg));
		default:
			return false;
	}
}

/** The directories a command line may be running in, grown by every `cd` it passes. */
interface WorkingDirectories {
	list: string[];
	/** A `cd` went somewhere the gate cannot resolve; a requirement check's later writes cannot be checked. */
	unknown: boolean;
}

function insideScratch(target: string, lane: ReadOnlyShellLaneScope): boolean {
	return lane.scratchRoots.some((root) => isPathWithinScope(target, root));
}

/** A word with `~`, `$HOME` and the scratch variables expanded the way the lane's shell expands them; undefined when anything else would expand. */
function expandLaneWord(word: string, dialect: ShellCommandDialect, lane: ReadOnlyShellLaneScope): string | undefined {
	let value = word;
	if (value === "~" || /^~[\\/]/u.test(value)) value = `${lane.homeDir}${value.slice(1)}`;
	else if (value.startsWith("~")) return undefined;
	let unresolved = false;
	value = value.replace(
		dialect === "powershell" ? POWERSHELL_PATH_VARIABLE_RE : POSIX_PATH_VARIABLE_RE,
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

/**
 * Every path an expanded word may reach from `cwd`: the lexical path, the path the kernel reaches through symbolic
 * links (a `..` after a link leaves the link's target), and for a glob every match from both forms of its literal
 * prefix. A string is a refusal.
 */
function reachedPaths(expanded: string, cwd: string, word: string): string[] | string {
	try {
		if (!GLOB_WORD_RE.test(expanded))
			return [...new Set([nodePath.resolve(cwd, expanded), physicalPathSync(cwd, expanded)])];
		const parts = expanded.split(nodePath.sep === "\\" ? /[\\/]/u : /\//u);
		const firstGlob = parts.findIndex((part) => GLOB_WORD_RE.test(part));
		if (firstGlob >= 0 && parts.slice(firstGlob + 1).includes(".."))
			return `it names ${word}, a glob through a parent directory the gate cannot resolve`;
		const prefix = firstGlob <= 0 ? "." : parts.slice(0, firstGlob).join("/") || nodePath.sep;
		const rest = firstGlob < 0 ? expanded : parts.slice(firstGlob).join("/");
		const bases =
			firstGlob < 0 ? [cwd] : [...new Set([nodePath.resolve(cwd, prefix), physicalPathSync(cwd, prefix)])];
		const targets: string[] = [];
		for (const base of bases) {
			const matches = globMatches(rest, base);
			if (!matches) return `it names more than ${MAX_GLOB_MATCHES} paths through ${word}`;
			for (const match of matches) targets.push(match, safeRealpathSync(match));
		}
		return [...new Set(targets)];
	} catch {
		return `it names ${word}, a path the gate cannot resolve`;
	}
}

function deniedPathViolation(target: string, recursive: boolean, lane: ReadOnlyShellLaneScope): string | undefined {
	if (insideScratch(target, lane)) return undefined;
	if (lane.isDeniedPath(target))
		return `it reads ${target}, a private harness or credential path or one outside its read scope`;
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
	context: JudgeContext,
	lane: ReadOnlyShellLaneScope,
): string | undefined {
	const expanded = expandLaneWord(word, context.dialect, lane);
	if (expanded === undefined) return `it names ${word}, a path the gate cannot resolve`;
	if (!lane.network && NETWORK_SHARE_RE.test(expanded))
		return `it names ${word}, a network share, and this worker holds no network grant`;
	for (const cwd of cwds) {
		const targets = reachedPaths(expanded, cwd, word);
		if (typeof targets === "string") return targets;
		for (const target of targets) {
			const violation = deniedPathViolation(target, recursive, lane);
			if (violation) return violation;
		}
	}
	return undefined;
}

/** Why writing `word` breaks the context's write rule; undefined when the write is allowed. */
function writeViolation(word: string, cwds: WorkingDirectories, context: JudgeContext): string | undefined {
	if (STREAM_TARGET_RE.test(word) || (context.dialect === "powershell" && POWERSHELL_NULL_TARGET_RE.test(word)))
		return undefined;
	if (context.writes === "none") return `it writes to ${word}`;
	const lane = context.lane;
	if (context.writes === "new" || !lane) {
		if (cwds.unknown || /[$~`]/u.test(word) || GLOB_WORD_RE.test(word))
			return `it writes to ${word}, a path the gate cannot resolve`;
		return cwds.list.some((cwd) => existsSync(nodePath.resolve(cwd, word)))
			? `it writes into the existing path ${word}`
			: undefined;
	}
	if (lane.scratchRoots.length === 0) return `it writes ${word} and this worker has no scratch directory`;
	const expanded = expandLaneWord(word, context.dialect, lane);
	if (expanded === undefined || GLOB_WORD_RE.test(expanded))
		return `it writes to ${word}, a path the gate cannot resolve`;
	for (const cwd of cwds.list) {
		let targets: string[];
		try {
			targets = [nodePath.resolve(cwd, expanded), physicalPathSync(cwd, expanded)];
		} catch {
			return `it writes to ${word}, a path the gate cannot resolve`;
		}
		const outside = targets.find((target) => !insideScratch(target, lane));
		if (outside !== undefined) return `it writes ${outside}, outside this worker's scratch directory`;
	}
	return undefined;
}

/** The directories `cd <target>` (or `Set-Location`) may leave the shell in; a string is a refusal. */
function changeDirectory(
	target: string | undefined,
	cwds: WorkingDirectories,
	context: JudgeContext,
): string | undefined {
	const lane = context.lane;
	// A command that may only read needs no directory: nothing it does depends on where it runs.
	if (!lane && context.writes === "none") return undefined;
	const unresolvable = (text: string): string | undefined => {
		if (lane) return text;
		cwds.unknown = true;
		return undefined;
	};
	const word = target ?? "~";
	if (word === "-") return unresolvable("it returns to the previous directory (cd -), which the gate cannot resolve");
	const expanded = lane ? expandLaneWord(word, context.dialect, lane) : /[$~`]/u.test(word) ? undefined : word;
	if (expanded === undefined || GLOB_WORD_RE.test(expanded))
		return unresolvable(`it changes to ${word}, a directory the gate cannot resolve`);
	if (lane) {
		const violation = lanePathViolation(word, cwds.list, false, context, lane);
		if (violation) return violation;
	}
	// The shell may stay where it was when `cd` fails, so both stay possible for what follows. A bare
	// relative name may also resolve below an inherited CDPATH entry.
	const viaCdPath =
		!lane || /^\.{1,2}(?:[\\/]|$)/u.test(expanded) || nodePath.isAbsolute(expanded)
			? []
			: cwds.list.flatMap((cwd) => lane.cdPath.map((entry) => nodePath.resolve(cwd, entry, expanded)));
	for (const directory of viaCdPath) {
		const violation = lane ? deniedPathViolation(directory, false, lane) : undefined;
		if (violation) return violation;
	}
	const next = new Set([...cwds.list, ...viaCdPath]);
	for (const cwd of cwds.list) {
		next.add(nodePath.resolve(cwd, expanded));
		try {
			next.add(physicalPathSync(cwd, expanded));
		} catch {
			return unresolvable(`it changes to ${word}, a directory the gate cannot resolve`);
		}
	}
	if (next.size > MAX_TRACKED_DIRECTORIES)
		return unresolvable(
			`it changes directory more often than the gate tracks (${MAX_TRACKED_DIRECTORIES} possible directories)`,
		);
	cwds.list = [...next];
	return undefined;
}

/**
 * The directories a program runs in after `env -C <dir>` or `git -C <dir>`: only the entered ones, since the program
 * does not run when the change fails. A string is a refusal.
 */
function programDirectories(
	directory: string,
	cwds: WorkingDirectories,
	context: JudgeContext,
): WorkingDirectories | string {
	const next: WorkingDirectories = { list: [...cwds.list], unknown: cwds.unknown };
	const refusal = changeDirectory(directory, next, context);
	if (refusal) return refusal;
	const entered = next.list.filter((cwd) => !cwds.list.includes(cwd));
	return { list: entered.length > 0 ? entered : next.list, unknown: next.unknown };
}

/** The nearest directory at or above `cwd` that holds a `.git` entry: what git reads from. */
function repositoryRoot(cwd: string): string | undefined {
	for (let directory = cwd; ; directory = nodePath.dirname(directory)) {
		if (existsSync(nodePath.join(directory, ".git"))) return directory;
		if (nodePath.dirname(directory) === directory) return undefined;
	}
}

function assignmentViolation(name: string, testRun: boolean): string | undefined {
	if (ALLOWED_ASSIGNMENT_RE.test(name) || (testRun && TEST_RUN_ASSIGNMENT_RE.test(name))) return undefined;
	return `it sets ${name}, which can change what a program runs or reads; only ${ALLOWED_ASSIGNMENT_TEXT} may be set`;
}

/** `${...}` forms that only read a variable: a name, its length, a default, an alternative, a pattern removal or replacement. */
const PARAMETER_EXPANSION_RE = /^#?(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(?=$|:?[-+?=]|##?|%%?|\/\/?|\^\^?|,,?)/u;

/** Why the shell would run or evaluate something while expanding `token`; undefined when it only substitutes text. */
function expansionViolation(token: ShellToken): string | undefined {
	for (const expansion of token.expansions ?? []) {
		if (expansion.kind === "command" || expansion.kind === "process")
			return "it runs a command substitution, whose command the gate does not judge";
		if (expansion.kind === "arithmetic")
			return "it uses arithmetic expansion, which can assign variables and run commands";
		const match = PARAMETER_EXPANSION_RE.exec(expansion.body);
		if (!match)
			return `it uses the parameter expansion \${${expansion.body}}, which evaluates an offset, subscript or indirection`;
		const operation = expansion.body.slice(match[0].length);
		if (/[$`]/u.test(operation))
			return `it nests an expansion inside \${${expansion.body}}, which the gate does not judge`;
		if (/^:?=/u.test(operation)) {
			const violation = assignmentViolation(match[0].replace(/^#/u, ""), false);
			if (violation) return violation;
		}
	}
	return undefined;
}

function isTestRun(args: readonly string[]): boolean {
	let index = 0;
	while (index < args.length && ASSIGNMENT_RE.test(args[index]!)) index++;
	const rest = args.slice(index);
	return TEST_RUN_RE.test(rest.join(" ")) && !rest.some((arg) => TEST_RUN_WRITE_OPTION_RE.test(arg));
}

/** Operands `[[`, `test` and `[` evaluate arithmetically or as array subscripts must be plain, or they run code. */
function testOperandViolation(name: string, args: readonly string[]): string | undefined {
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "-v") {
			const operand = args[index + 1] ?? "";
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(operand))
				return `${name} -v ${operand} evaluates an array subscript, which can run commands`;
		}
		if (name === "[[" && /^-(?:eq|ne|lt|le|gt|ge)$/u.test(arg)) {
			for (const operand of [args[index - 1] ?? "", args[index + 1] ?? ""]) {
				const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u.exec(operand)?.[1];
				if (/^-?\d+$/u.test(operand) || (variable !== undefined && !ALLOWED_ASSIGNMENT_RE.test(variable))) continue;
				return `[[ compares ${operand} arithmetically, which can assign variables and run commands; compare integers or use [ ]`;
			}
		}
	}
	return undefined;
}

/** Programs whose every option only reads: what xargs may run outside a lane, where its input may carry options. */
const XARGS_READ_ONLY_PROGRAMS = new Set([
	"basename",
	"cat",
	"cut",
	"dirname",
	"du",
	"echo",
	"grep",
	"head",
	"ls",
	"md5sum",
	"nl",
	"readlink",
	"realpath",
	"sha1sum",
	"sha256sum",
	"stat",
	"tail",
	"tr",
	"wc",
]);
const TIMEOUT_DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/u;
const GIT_GLOBAL_FLAGS = new Set([
	"--no-pager",
	"-P",
	"--paginate",
	"-p",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-optional-locks",
	"--no-replace-objects",
	"--bare",
]);

/**
 * Reads a wrapper's own options: `values` take the next word (or an attached value), `flags` take none; a string
 * is a refusal. Returns the index of the first word after the options.
 */
function skipWrapperOptions(
	args: readonly string[],
	start: number,
	flags: ReadonlySet<string>,
	values: ReadonlySet<string>,
	onValue?: (option: string, value: string) => string | undefined,
): number | string {
	let index = start;
	const wrapper = executableName(args[0] ?? "");
	while (index < args.length) {
		const arg = args[index]!;
		if (arg === "--") return index + 1;
		if (!arg.startsWith("-") || arg === "-") return index;
		if (flags.has(arg)) {
			index++;
			continue;
		}
		const long = /^(--[^=]+)=(.*)$/su.exec(arg);
		const option = long ? long[1]! : arg.startsWith("--") ? arg : arg.slice(0, 2);
		if (!values.has(option)) return `${wrapper} ${arg} is not an option the gate judges`;
		let value: string | undefined;
		if (long) value = long[2];
		else if (!arg.startsWith("--") && arg.length > 2) value = arg.slice(2);
		else value = args[++index];
		if (value === undefined) return `${wrapper} ${arg} names no value`;
		const violation = onValue?.(option, value);
		if (violation) return violation;
		index++;
	}
	return index;
}

/** The judgment of the program a wrapper runs, or of the wrapper alone when it runs none and `optional` allows that. */
function wrappedViolation(
	args: readonly string[],
	start: number | string,
	cwds: WorkingDirectories,
	context: JudgeContext,
	optional = false,
): string | undefined {
	if (typeof start === "string") return start;
	if (start >= args.length) return optional ? undefined : `${executableName(args[0] ?? "")} names no program to run`;
	return programViolation(args.slice(start), cwds, context);
}

function xargsViolation(args: readonly string[], cwds: WorkingDirectories, context: JudgeContext): string | undefined {
	const flags = new Set([
		"-0",
		"--null",
		"-r",
		"--no-run-if-empty",
		"-t",
		"--verbose",
		"-x",
		"--exit",
		"--show-limits",
		"-l",
		"-i",
		"--replace",
		"-e",
	]);
	const values = new Set([
		"-a",
		"--arg-file",
		"-d",
		"--delimiter",
		"-E",
		"-e",
		"--eof",
		"-I",
		"-i",
		"--replace",
		"-L",
		"--max-lines",
		"-l",
		"-n",
		"--max-args",
		"-P",
		"--max-procs",
		"-s",
		"--max-chars",
	]);
	// Options left out (`-p`, `-o`, `--process-slot-var`) ask the terminal or set a variable: refused as unjudged.
	const start = skipWrapperOptions(args, 1, flags, values, (option, value) => {
		if ((option === "-a" || option === "--arg-file") && context.lane)
			return lanePathViolation(value, cwds.list, false, context, context.lane);
		return undefined;
	});
	if (typeof start === "string") return start;
	const inner = start < args.length ? executableName(args[start]!) : "echo";
	if (!XARGS_READ_ONLY_PROGRAMS.has(inner))
		return `xargs runs ${inner} with arguments from its input, which can carry options the gate cannot see`;
	if (context.lane && !NON_PATH_PROGRAMS.has(inner))
		return `xargs runs ${inner} on paths from its input, which the gate cannot check`;
	return wrappedViolation(args, start, cwds, context, true);
}

function envViolation(args: readonly string[], cwds: WorkingDirectories, context: JudgeContext): string | undefined {
	let index = 1;
	let clears = false;
	let programCwds = cwds;
	while (index < args.length) {
		const arg = args[index]!;
		const assignment = ASSIGNMENT_RE.exec(arg);
		if (assignment) {
			const violation = assignmentViolation(assignment[1]!, false);
			if (violation) return violation;
			index++;
			continue;
		}
		if (arg === "--") {
			index++;
			continue;
		}
		if (arg === "-i" || arg === "-" || arg === "--ignore-environment") {
			clears = true;
			index++;
			continue;
		}
		if (arg === "-0" || arg === "--null" || arg === "-v" || arg === "--debug") {
			index++;
			continue;
		}
		const unset = arg === "-u" || arg === "--unset" ? args[++index] : /^(?:-u|--unset=)(.+)$/u.exec(arg)?.[1];
		if (unset !== undefined) {
			if (context.lane && PATH_VARIABLE_NAMES.has(unset))
				return `it unsets ${unset}, which the gate resolves paths with`;
			index++;
			continue;
		}
		const directory = arg === "-C" || arg === "--chdir" ? args[++index] : /^(?:-C|--chdir=)(.+)$/u.exec(arg)?.[1];
		if (directory !== undefined) {
			const entered = programDirectories(directory, programCwds, context);
			if (typeof entered === "string") return entered;
			programCwds = entered;
			index++;
			continue;
		}
		if (/^(?:-S|--split-string)/u.test(arg))
			return "env -S splits a string into a command, which the gate does not judge";
		if (arg.startsWith("-")) return `env ${arg} is not an option the gate judges`;
		break;
	}
	if (index >= args.length) return undefined;
	if (clears && context.lane) return "it clears the environment the gate resolves paths with (env -i)";
	return programViolation(args.slice(index), programCwds, context);
}

function nestedShellViolation(
	name: string,
	args: readonly string[],
	cwds: WorkingDirectories,
	context: JudgeContext,
): string | undefined {
	if (context.depth >= MAX_NESTED_SHELL_DEPTH) return `${name} nests shells deeper than the gate judges`;
	const nested = (command: string, dialect: ShellCommandDialect) =>
		command.trim()
			? walkCommand(
					command,
					{ list: [...cwds.list], unknown: cwds.unknown },
					{ ...context, dialect, depth: context.depth + 1 },
				)
			: `${name} names no command`;
	if (SHELL_WRAPPERS.has(name)) {
		let index = 1;
		if (name === "bash") while (args[index] === "--noprofile" || args[index] === "--norc") index++;
		// Login shells, scripts and positional arguments can execute or reinterpret other code.
		if (args[index] !== "-c" || args.length !== index + 2) return `${name} runs something other than one -c command`;
		return nested(args[index + 1]!, "posix");
	}
	let index = 1;
	while (index < args.length && /^-(?:nologo|noninteractive|noprofile)$/iu.test(args[index]!)) index++;
	if (!/^-(?:c|command)$/iu.test(args[index] ?? "")) return `${name} runs something other than one -Command`;
	return nested(args.slice(index + 1).join(" "), "powershell");
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

function isSafeSshOption(value: string): boolean {
	const separator = value.indexOf("=");
	if (separator <= 0 || separator === value.length - 1) return false;
	return SAFE_SSH_OPTIONS.has(value.slice(0, separator).toLowerCase());
}

/** `ssh host command`: the remote command is judged by the read/write line alone; the lane rules are local. */
function sshViolation(args: readonly string[], context: JudgeContext): string | undefined {
	if (context.depth >= MAX_NESTED_SHELL_DEPTH) return "ssh nests shells deeper than the gate judges";
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
			if (!value || value.startsWith("-")) return `ssh ${option} names no value`;
			index += 2;
			continue;
		}
		if (option === "-o" && isSafeSshOption(args[index + 1] ?? "")) {
			index += 2;
			continue;
		}
		if (option.startsWith("-o") && isSafeSshOption(option.slice(2))) {
			index++;
			continue;
		}
		return `ssh ${option} is not an option the gate judges`;
	}
	const destination = args[index++];
	if (!destination || !/^[A-Za-z0-9._%+@:-]+$/u.test(destination)) return "ssh names no plain destination";
	const remote = args.slice(index).join(" ").trim();
	if (!remote) return "ssh opens an interactive session";
	return walkCommand(
		remote,
		{ list: [nodePath.sep], unknown: true },
		{ ...context, dialect: "posix", depth: context.depth + 1, writes: "none", lane: undefined },
	);
}

function gitRefListingViolation(subcommand: string, rest: readonly string[]): string | undefined {
	let listing = false;
	let positionals = 0;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index]!;
		if (arg === "-l" || arg === "--list") listing = true;
		else if (subcommand === "branch" && (arg === "-a" || arg === "--all")) continue;
		else if (GIT_REF_MUTATING_FLAG_RE.test(arg)) return `git ${subcommand} ${arg} creates, moves or deletes a ref`;
		else if (GIT_REF_LISTING_VALUE_OPTIONS.has(arg)) {
			if (!/^--(?:sort|format)$/u.test(arg)) listing = true;
			const value = rest[index + 1];
			if (value !== undefined && !value.startsWith("-")) index++;
		} else if (arg.startsWith("-")) {
			if (/^--(?:contains|no-contains|merged|no-merged|points-at)=/u.test(arg)) listing = true;
		} else positionals++;
	}
	return positionals === 0 || listing ? undefined : `git ${subcommand} with a name creates a ref`;
}

/** Why a git subcommand and its arguments may change the repository; undefined for a read. */
function gitSubcommandViolation(subcommand: string, rest: readonly string[]): string | undefined {
	if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return undefined;
	if (GIT_REF_LISTING_SUBCOMMANDS.has(subcommand)) return gitRefListingViolation(subcommand, rest);
	const action = rest.find((arg) => !arg.startsWith("-"));
	switch (subcommand) {
		case "reflog":
			return action === "expire" || action === "delete" || action === "write"
				? `git reflog ${action} changes the reflog`
				: undefined;
		case "remote":
			return action === undefined || action === "get-url"
				? undefined
				: `git remote ${action} changes or contacts a remote`;
		case "worktree":
			return action === "list" ? undefined : `git worktree ${action ?? ""} changes worktrees`.trimEnd();
		case "stash":
			return action === "list" || action === "show"
				? undefined
				: `git stash ${action ?? ""} changes the stash`.trimEnd();
		case "config": {
			const write = rest.find((arg) => GIT_CONFIG_WRITE_OPTION_RE.test(arg));
			if (write) return `git config ${write} changes configuration`;
			if (
				rest.some((arg) => GIT_CONFIG_READ_OPTIONS.has(arg.replace(/=.*$/su, ""))) ||
				action === "get" ||
				action === "list"
			)
				return undefined;
			return "git config without --get, --list or a get/list subcommand may change configuration";
		}
		default:
			return `git ${subcommand} is not a read-only git subcommand`;
	}
}

/** Options of git subcommands whose value is a file git reads. */
const GIT_FILE_VALUE_OPTIONS = new Set(["--contents", "--exclude-from", "-X", "--file", "-f"]);

function gitViolation(args: readonly string[], cwds: WorkingDirectories, context: JudgeContext): string | undefined {
	let index = 1;
	const directories: string[] = [];
	const gitPaths: string[] = [];
	while (index < args.length) {
		const arg = args[index]!;
		if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
			const value = args[index + 1];
			if (value === undefined) return `git ${arg} names no path`;
			(arg === "-C" ? directories : gitPaths).push(value);
			index += 2;
			continue;
		}
		const assigned = /^--(?:git-dir|work-tree)=(.*)$/su.exec(arg);
		if (assigned) {
			gitPaths.push(assigned[1]!);
			index++;
			continue;
		}
		if (GIT_GLOBAL_FLAGS.has(arg)) {
			index++;
			continue;
		}
		if (/^(?:-c|--config-env|--exec-path)/u.test(arg))
			return `git ${arg} sets configuration or the program path, which can run other programs`;
		if (arg.startsWith("-")) return `git ${arg} is not a global option the gate judges`;
		break;
	}
	const subcommand = args[index]?.toLowerCase();
	if (subcommand === undefined) return undefined;
	const rest = args.slice(index + 1);
	const violation = gitSubcommandViolation(subcommand, rest) ?? invocationEffect(["git", ...rest]);
	if (violation) return violation;
	const lane = context.lane;
	if (!lane) return undefined;
	if (subcommand === "grep" && rest.includes("--no-exclude-standard"))
		return "git grep --no-exclude-standard searches ignored files, where private files such as .env live";
	// `git -C <dir>` runs (and resolves its paths) from <dir>.
	let gitCwds = cwds;
	for (const directory of directories) {
		const entered = programDirectories(directory, gitCwds, context);
		if (typeof entered === "string") return entered;
		gitCwds = entered;
	}
	for (const path of gitPaths) {
		const refusal = lanePathViolation(path, gitCwds.list, true, context, lane);
		if (refusal) return refusal;
	}
	if (rest.includes("--no-index")) {
		const operands =
			subcommand === "grep"
				? pathOperandsWithProgram("grep", ["grep", ...rest.filter((arg) => arg !== "--no-index")]).paths
				: rest.filter((arg) => !arg.startsWith("-"));
		for (const operand of operands) {
			const refusal = lanePathViolation(operand, gitCwds.list, true, context, lane);
			if (refusal) return refusal;
		}
		return undefined;
	}
	let endOfOptions = false;
	for (let restIndex = 0; restIndex < rest.length; restIndex++) {
		const arg = rest[restIndex]!;
		if (!endOfOptions && arg === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && arg.startsWith("-")) {
			const assigned = /^(--[^=]+)=(.*)$/su.exec(arg);
			const option = assigned?.[1] ?? arg;
			const fileValue =
				GIT_FILE_VALUE_OPTIONS.has(option) && (option !== "-f" || subcommand === "grep" || subcommand === "config")
					? (assigned?.[2] ?? rest[++restIndex])
					: undefined;
			if (fileValue !== undefined) {
				const refusal = lanePathViolation(fileValue, gitCwds.list, false, context, lane);
				if (refusal) return refusal;
			}
			continue;
		}
		// Revisions, patterns and pathspecs: a word that names a private path (also after `<rev>:`) is refused;
		// a word the gate cannot read as a path (`'TODO$'`) is data.
		const pathspec = arg.replace(/^:(?:\([^)]*\)|[!^/]*)/u, "").replace(/^[^:]+:/u, "");
		const expanded = expandLaneWord(pathspec, context.dialect, lane);
		if (!expanded) continue;
		for (const cwd of gitCwds.list) {
			const target = nodePath.resolve(cwd, expanded);
			if (!insideScratch(target, lane) && lane.isDeniedPath(target))
				return `it reads ${target}, a private harness or credential path or one outside its read scope`;
		}
	}
	// git reads its whole repository, wherever in it the command runs.
	for (const cwd of gitCwds.list) {
		const refusal = deniedPathViolation(repositoryRoot(cwd) ?? cwd, true, lane);
		if (refusal) return refusal;
	}
	return undefined;
}

/** The lane's path rules for the operands of a program that opens them. */
function laneOperandViolation(
	name: string,
	args: readonly string[],
	cwds: WorkingDirectories,
	context: JudgeContext,
	lane: ReadOnlyShellLaneScope,
): string | undefined {
	if (NON_PATH_PROGRAMS.has(name)) return undefined;
	const recursive = searchesRecursively(name, args);
	const operands = pathOperandsWithProgram(name, args);
	for (const operand of operands.paths) {
		const violation = lanePathViolation(operand, cwds.list, recursive, context, lane);
		if (violation) return violation;
	}
	for (const root of operands.recursivePaths) {
		const violation = lanePathViolation(root, cwds.list, true, context, lane);
		if (violation) return violation;
	}
	// A recursive search without a path operand searches where it runs.
	if (recursive && operands.paths.length === 0) {
		for (const cwd of cwds.list) {
			const violation = deniedPathViolation(cwd, true, lane);
			if (violation) return violation;
		}
	}
	return undefined;
}

/** The rules for one program on the read-only list (or a requirement check's type check). */
function leafViolation(args: readonly string[], cwds: WorkingDirectories, context: JudgeContext): string | undefined {
	const name = executableName(args[0]!);
	const lane = context.lane;
	if (!READ_ONLY_COMMANDS.has(name)) {
		if (name === "tsc" && context.admitTestRuns) {
			const option = args.find((arg) => TSC_CHECK_EFFECT_RE.test(arg));
			if (option) return `tsc ${option} writes files or never finishes`;
			return args.includes("--noEmit") ? undefined : "tsc without --noEmit writes compiled files";
		}
		return `${name} is not a command the read-only line admits`;
	}
	const rest = args.slice(1);
	const subcommand = rest.find((arg) => !arg.startsWith("-"))?.toLowerCase();
	switch (name) {
		case "git":
			return gitViolation(args, cwds, context);
		case "cd":
			return changeDirectory(rest.filter((arg) => arg === "-" || !/^-(?:[LPe@]+|-)$/u.test(arg))[0], cwds, context);
		case "npm":
		case "pnpm":
		case "yarn":
			if (!subcommand || !READ_ONLY_NPM_SUBCOMMANDS.has(subcommand))
				return `${name} ${subcommand ?? ""} is not a read-only ${name} subcommand`.replace("  ", " ");
			break;
		case "systemctl":
			if (!subcommand || !READ_ONLY_SYSTEMCTL_SUBCOMMANDS.has(subcommand))
				return `systemctl ${subcommand ?? ""} is not a read-only systemctl subcommand`.replace("  ", " ");
			break;
		case "node":
			if (!NODE_READ_ONLY_RE.test(rest[0] ?? "") || rest.length > (/^-(?:c|-check)$/u.test(rest[0]!) ? 2 : 1))
				return "node runs code; only node --version and node --check <file> are read-only";
			break;
		case "sed":
			if (rest.some((arg) => /^-[a-zA-Z]*i|^--in-place(?:=|$)/u.test(arg))) return "sed -i edits files in place";
			break;
		case "test":
		case "[":
		case "[[": {
			const violation = testOperandViolation(name, args);
			if (violation) return violation;
			break;
		}
	}
	const effect = invocationEffect(args);
	if (effect) return effect;
	if (name === "tee") {
		let endOfOptions = false;
		for (const word of rest) {
			if (!endOfOptions && word === "--") {
				endOfOptions = true;
				continue;
			}
			if (!endOfOptions && word.startsWith("-") && word !== "-") continue;
			const violation = writeViolation(word, cwds, context);
			if (violation) return violation;
		}
		return undefined;
	}
	return lane ? laneOperandViolation(name, args, cwds, context, lane) : undefined;
}

/** The rules for one program and its arguments, looking through `command`, `env` and the wrapper programs. */
function programViolation(
	args: readonly string[],
	cwds: WorkingDirectories,
	context: JudgeContext,
): string | undefined {
	const program = args[0]!;
	const name = executableName(program);
	context.programs.push(name);
	const lane = context.lane;
	if (lane && !lane.network) {
		const reach = networkReach(args);
		if (reach) return `${reach} reaches the network and this worker holds no network grant`;
	}
	if (/[\\/]/u.test(program)) {
		const expanded = lane ? expandLaneWord(program, context.dialect, lane) : program;
		if (expanded === undefined || !nodePath.isAbsolute(expanded))
			return `it runs ${program} from a relative or variable path, which may not be the program its name says`;
		if (lane && insideScratch(expanded, lane)) return "it runs a program from this worker's scratch directory";
	}
	switch (name) {
		case "command": {
			if (args[1] === "-v" || args[1] === "-V") return undefined;
			let start = 1;
			while (args[start] === "-p" || args[start] === "--") start++;
			if (args[start]?.startsWith("-")) return `command ${args[start]} is not an option the gate judges`;
			return wrappedViolation(args, start, cwds, context, true);
		}
		case "env":
			return envViolation(args, cwds, context);
		case "timeout": {
			const start = skipWrapperOptions(
				args,
				1,
				new Set(["--preserve-status", "--foreground", "-v", "--verbose"]),
				new Set(["-s", "--signal", "-k", "--kill-after"]),
			);
			if (typeof start === "string") return start;
			if (!TIMEOUT_DURATION_RE.test(args[start] ?? "")) return "timeout names no duration";
			return wrappedViolation(args, start + 1, cwds, context);
		}
		case "time":
			return wrappedViolation(
				args,
				skipWrapperOptions(
					args,
					1,
					new Set(["-p", "--portability", "-v", "--verbose", "-q", "--quiet", "-a", "--append"]),
					new Set(["-f", "--format", "-o", "--output"]),
					(option, value) =>
						option === "-o" || option === "--output" ? writeViolation(value, cwds, context) : undefined,
				),
				cwds,
				context,
				true,
			);
		case "nice": {
			// `nice -10 cmd` sets the adjustment with a bare number.
			const start = /^-\d+$/u.test(args[1] ?? "") ? 2 : 1;
			return wrappedViolation(
				args,
				skipWrapperOptions(args, start, new Set(), new Set(["-n", "--adjustment"])),
				cwds,
				context,
				true,
			);
		}
		case "stdbuf":
			return wrappedViolation(
				args,
				skipWrapperOptions(args, 1, new Set(), new Set(["-i", "-o", "-e", "--input", "--output", "--error"])),
				cwds,
				context,
			);
		case "xargs":
			return xargsViolation(args, cwds, context);
		case "ssh":
			return sshViolation(args, context);
		case "powershell":
		case "pwsh":
			return nestedShellViolation(name, args, cwds, context);
		default:
			if (SHELL_WRAPPERS.has(name)) return nestedShellViolation(name, args, cwds, context);
			return leafViolation(args, cwds, context);
	}
}

/** The rules for one simple command: its assignments, then its program. */
function invocationViolation(
	args: readonly string[],
	cwds: WorkingDirectories,
	context: JudgeContext,
): string | undefined {
	const testRun = context.admitTestRuns && isTestRun(args);
	let index = 0;
	for (; index < args.length; index++) {
		const assignment = ASSIGNMENT_RE.exec(args[index]!);
		if (!assignment) break;
		const violation = assignmentViolation(assignment[1]!, testRun);
		if (violation) return violation;
	}
	// Bare assignments change only the shell's own (allowed) variables; a test run is a requirement check's proof.
	if (index === args.length || testRun) return undefined;
	return programViolation(args.slice(index), cwds, context);
}

interface Redirection {
	readonly operator: string;
	readonly target?: ShellToken;
}

function redirectionViolation(
	redirection: Redirection,
	cwds: WorkingDirectories,
	context: JudgeContext,
): string | undefined {
	const { operator, target } = redirection;
	if (!target) return undefined;
	const expansion = expansionViolation(target);
	if (expansion) return expansion;
	if (operator === "<<<") return undefined;
	if (operator.includes(">")) return writeViolation(target.value, cwds, context);
	return context.lane ? lanePathViolation(target.value, cwds.list, false, context, context.lane) : undefined;
}

/**
 * Splits a tokenized command line into simple commands (words and redirections) and judges each with the separator
 * that preceded it; the first refusal ends the walk.
 */
function judgeSimpleCommands(
	tokens: readonly ShellToken[],
	judge: (words: ShellToken[], redirections: Redirection[], previous: string | undefined) => string | undefined,
): string | undefined {
	let words: ShellToken[] = [];
	let redirections: Redirection[] = [];
	let previous: string | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token.kind === "arg") {
			words.push(token);
			continue;
		}
		if (token.kind === "redirect") {
			if (/^<<-?$/u.test(token.value)) return "it uses a here-document, whose text the gate does not judge";
			if (!redirectTakesTarget(token.value)) {
				redirections.push({ operator: token.value });
				continue;
			}
			const target = tokens[index + 1];
			if (target?.kind !== "arg") return "it redirects without naming a file";
			index++;
			redirections.push({ operator: token.value, target });
			continue;
		}
		const violation = judge(words, redirections, previous);
		if (violation) return violation;
		words = [];
		redirections = [];
		previous = token.value;
	}
	return judge(words, redirections, previous);
}

/**
 * The rules over a whole command line: every simple command (split on `;`, `&&`, `||`, `|`, `|&`, `&` and line
 * breaks by the shared tokenizer), its redirections and expansions, with `cd` tracked. PowerShell command lines go
 * through the PowerShell walk.
 */
function walkCommand(command: string, cwds: WorkingDirectories, context: JudgeContext): string | undefined {
	if (context.dialect === "powershell") return walkPowerShell(command, cwds, context);
	const tokens = tokenizeShellCommand(command, "posix");
	if (!tokens) return "it has an unterminated quote, escape or substitution";
	return judgeSimpleCommands(tokens, (words, redirections) => {
		for (const word of words) {
			const violation = expansionViolation(word);
			if (violation) return violation;
		}
		const first = words[0]?.value;
		if (first !== undefined && /^[({]$|^\(/u.test(first))
			return "it opens a subshell or command group, which the gate does not judge";
		for (const redirection of redirections) {
			const violation = redirectionViolation(redirection, cwds, context);
			if (violation) return violation;
		}
		return words.length === 0
			? undefined
			: invocationViolation(
					words.map((word) => word.value),
					cwds,
					context,
				);
	});
}

/** PowerShell's built-in aliases for the cmdlets below (and for `cd`), as the language resolves them. */
const POWERSHELL_ALIASES: ReadonlyMap<string, string> = new Map([
	["dir", "get-childitem"],
	["gci", "get-childitem"],
	["ls", "get-childitem"],
	["type", "get-content"],
	["cat", "get-content"],
	["gc", "get-content"],
	["%", "foreach-object"],
	["foreach", "foreach-object"],
	["?", "where-object"],
	["where", "where-object"],
	["select", "select-object"],
	["sort", "sort-object"],
	["measure", "measure-object"],
	["group", "group-object"],
	["ft", "format-table"],
	["fl", "format-list"],
	["echo", "write-output"],
	["write", "write-output"],
	["sls", "select-string"],
	["gps", "get-process"],
	["ps", "get-process"],
	["gsv", "get-service"],
	["rvpa", "resolve-path"],
	["gcm", "get-command"],
	["gl", "get-location"],
	["pwd", "get-location"],
	["sl", "set-location"],
	["cd", "set-location"],
	["chdir", "set-location"],
	["gi", "get-item"],
	["compare", "compare-object"],
	["gm", "get-member"],
]);
const POWERSHELL_READ_ONLY_CMDLETS = new Set([
	"compare-object",
	"convertfrom-json",
	"convertto-json",
	"foreach-object",
	"format-list",
	"format-table",
	"get-childitem",
	"get-command",
	"get-content",
	"get-date",
	"get-filehash",
	"get-item",
	"get-location",
	"get-member",
	"get-process",
	"get-psdrive",
	"get-service",
	"group-object",
	"join-path",
	"measure-object",
	"out-null",
	"out-string",
	"resolve-path",
	"select-object",
	"select-string",
	"set-location",
	"sort-object",
	"split-path",
	"test-path",
	"where-object",
	"write-host",
	"write-output",
]);
/** Cmdlets on the list that open the paths they are given. */
const POWERSHELL_PATH_CMDLETS = new Set([
	"get-childitem",
	"get-content",
	"get-filehash",
	"get-item",
	"resolve-path",
	"select-string",
	"test-path",
]);
/** Variable scopes and drives `$scope:name` may read; any other drive (`${C:\file}`, `$function:`) reads a provider item. */
const POWERSHELL_VARIABLE_SCOPES = new Set(["env", "global", "local", "script", "private", "using", "variable"]);
/** Methods that compute a value from their object without side effects. */
const POWERSHELL_PURE_METHODS = new Set([
	"compareto",
	"contains",
	"endswith",
	"equals",
	"foreach",
	"gettype",
	"indexof",
	"lastindexof",
	"padleft",
	"padright",
	"replace",
	"split",
	"startswith",
	"substring",
	"tolower",
	"tolowerinvariant",
	"tostring",
	"toupper",
	"toupperinvariant",
	"trim",
	"trimend",
	"trimstart",
	"where",
]);
const POWERSHELL_PURE_STATIC_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["math", new Set(["abs", "ceiling", "floor", "max", "min", "pow", "round", "sqrt", "truncate"])],
	["string", new Set(["concat", "format", "isnullorempty", "isnullorwhitespace", "join"])],
]);
const POWERSHELL_VARIABLE_PARAMETER_RE =
	/^-(?:outvariable|ov|errorvariable|ev|warningvariable|wv|informationvariable|iv|pipelinevariable|pv)(?::|$)/iu;

/** Why evaluating one PowerShell word runs something the gate does not judge; its groups are judged as statements. */
function powerShellWordViolation(
	token: ShellToken,
	cwds: WorkingDirectories,
	context: JudgeContext,
): string | undefined {
	const value = token.value;
	for (const match of value.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*):(?!:)/gu)) {
		if (!POWERSHELL_VARIABLE_SCOPES.has(match[1]!.toLowerCase()))
			return `it reads ${match[0]}..., a provider item through variable syntax`;
	}
	if (
		/^(?:[-+*/%]|\?\?)?=$/u.test(value) ||
		/^\$[\w:{}.[\]]+(?:[-+*/%]|\?\?)?=(?!=)/u.test(value) ||
		/^(?:\+\+|--)\$|^\$[\w:]+(?:\+\+|--)$/u.test(value)
	)
		return "it assigns a variable";
	for (const match of value.matchAll(/(?:\[([\w.]+)\])?(::|\.)([A-Za-z_]\w*)\s*\(/gu)) {
		const method = match[3]!.toLowerCase();
		if (match[2] === "::") {
			const type = (match[1] ?? "").toLowerCase().replace(/^system\./u, "");
			if (!POWERSHELL_PURE_STATIC_METHODS.get(type)?.has(method))
				return `it calls the .NET method ${match[0].slice(0, -1)}, which the gate does not judge`;
		} else if (!POWERSHELL_PURE_METHODS.has(method)) {
			return `it calls the method ${match[3]}, which the gate does not judge`;
		}
	}
	for (const group of token.groups ?? []) {
		const violation =
			group.kind === "hashtable"
				? powerShellHashtableViolation(group.body, cwds, context)
				: walkPowerShell(group.body, cwds, context);
		if (violation) return violation;
	}
	return undefined;
}

/** A hashtable's entries are `key = statement`; every statement is judged. */
function powerShellHashtableViolation(
	body: string,
	cwds: WorkingDirectories,
	context: JudgeContext,
): string | undefined {
	let start = 0;
	let depth = 0;
	let quote: string | undefined;
	const entries: string[] = [];
	for (let index = 0; index <= body.length; index++) {
		const char = body[index];
		if (char === "`") {
			index++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (char === "(" || char === "{" || char === "[") depth++;
		else if (char === ")" || char === "}" || char === "]") depth--;
		else if (char === undefined || (depth === 0 && (char === ";" || char === "\n"))) {
			entries.push(body.slice(start, index));
			start = index + 1;
		}
	}
	for (const entry of entries) {
		if (!entry.trim()) continue;
		const separator = entry.indexOf("=");
		if (separator < 0) return "it writes a hashtable entry the gate cannot read";
		const violation = walkPowerShell(entry.slice(separator + 1), cwds, context);
		if (violation) return violation;
	}
	return undefined;
}

/** The rules for one cmdlet on the list. */
function powerShellCmdletViolation(
	name: string,
	words: readonly ShellToken[],
	cwds: WorkingDirectories,
	context: JudgeContext,
): string | undefined {
	const args = words.map((word) => word.value);
	const variableParameter = args.find((arg) => POWERSHELL_VARIABLE_PARAMETER_RE.test(arg));
	if (variableParameter) return `it sets a variable through ${variableParameter}`;
	if (name === "foreach-object") {
		const member = words
			.slice(1)
			.find((word) => !word.value.startsWith("-") && !word.groups?.some((group) => group.kind === "block"));
		if (member || args.some((arg) => /^-membername$/iu.test(arg)))
			return "ForEach-Object with a member name calls a method the gate does not judge";
	}
	if (name === "set-location") {
		const target = args
			.slice(1)
			.find((arg, index, rest) => !arg.startsWith("-") || /^-(?:path|literalpath)$/iu.test(rest[index - 1] ?? ""));
		return changeDirectory(target, cwds, context);
	}
	const lane = context.lane;
	return lane && POWERSHELL_PATH_CMDLETS.has(name)
		? laneOperandViolation(name, [name, ...args.slice(1)], cwds, context, lane)
		: undefined;
}

/**
 * The PowerShell walk: statements and pipeline elements split by the PowerShell tokenizer, script blocks,
 * subexpressions and hashtables judged as statements of their own, cmdlets resolved through their aliases.
 */
function walkPowerShell(command: string, cwds: WorkingDirectories, context: JudgeContext): string | undefined {
	const tokens = tokenizeShellCommand(command, "powershell");
	if (!tokens) return "it has an unterminated quote, escape or group";
	return judgeSimpleCommands(tokens, (element, redirects, previous) => {
		// `&` before a command invokes it (after one it runs the pipeline as a background job; judging what follows as
		// invoked is the stricter reading).
		const called = previous === "&";
		for (const word of element) {
			const violation = powerShellWordViolation(word, cwds, context);
			if (violation) return violation;
		}
		for (const redirection of redirects) {
			if (redirection.target && redirection.operator.includes(">")) {
				const violation = writeViolation(redirection.target.value, cwds, context);
				if (violation) return violation;
			}
		}
		const first = element[0];
		if (!first) return undefined;
		if (called) {
			// `& { ... }` runs a block judged above; `& 'C:\tool.exe'` runs the named program, judged below.
			if (first.value.startsWith("{")) return undefined;
			if (first.value.startsWith("$") || first.groups)
				return "it invokes a command through & whose name the gate cannot read";
		} else if (first.literal || /^[$([@{\d]/u.test(first.value)) {
			// An expression statement (a value, a variable, a script block or a parenthesized expression) runs no
			// command of its own; its groups were judged above.
			return undefined;
		}
		if (first.value === ".") return "it dot-sources a script into the session";
		const args = element.map((word) => word.value);
		const name = POWERSHELL_ALIASES.get(executableName(first.value)) ?? executableName(first.value);
		if (POWERSHELL_READ_ONLY_CMDLETS.has(name)) {
			context.programs.push(name);
			const lane = context.lane;
			if (lane && !lane.network) {
				const reach = networkReach(args);
				if (reach) return `${reach} reaches the network and this worker holds no network grant`;
			}
			return powerShellCmdletViolation(name, element, cwds, context);
		}
		return programViolation(args, cwds, context);
	});
}

/**
 * Why a read-only lane may not run `command`, or undefined when it may.
 *
 * The read/write line: nothing that already exists is edited, and every command it calls mutating is refused,
 * including programs on the read-only list whose options or program text run other programs or write files
 * (`invocationEffect`), wrappers (`timeout`, `time`, `nice`, `stdbuf`, `xargs`, `env`, `command`) judged by the
 * program they run, and nested `bash -c`/`powershell -Command`/`ssh` command lines judged by the same walk. Without
 * `lane`, as for requirement checks, output may still be redirected or `tee`d into a NEW file.
 *
 * With `lane` (a read-only worker), three rules are added: no network client or network share without a
 * `network.http` grant; redirections and `tee` write only inside the lane's own scratch directory (`$TMPDIR`); and no
 * operand, input redirection, `cd` target or glob match names a private harness or credential path (lexically or
 * through symbolic links), nor does a recursive search descend into harness storage. Only the variables on the
 * assignment allowlist may be set. This inspects the command text; it is a policy gate, not OS isolation.
 */
export function readOnlyShellViolation(
	command: string,
	cwd: string,
	options: {
		/** A requirement check may run the project's tests (see TEST_RUN_RE) and `tsc --noEmit`; a read-only lane may not. */
		admitTestRuns?: boolean;
		/** A read-only worker lane's network grant, scratch directory and private paths. */
		lane?: ReadOnlyShellLaneScope;
		/** How the tool that runs the command splits it; the bash tool is POSIX-like on every platform. */
		dialect?: ShellCommandDialect;
	} = {},
): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;
	return walkCommand(
		trimmed,
		{ list: [nodePath.resolve(cwd)], unknown: false },
		{
			dialect: options.dialect ?? "posix",
			depth: 0,
			writes: options.lane ? "scratch" : "new",
			admitTestRuns: options.admitTestRuns ?? false,
			lane: options.lane,
			programs: [],
		},
	);
}

/**
 * The programs a command runs when it only reads (writes nothing at all), or undefined when it may change
 * something: the line the router's escalation, the work boundary and System One's observational check draw.
 */
export function readOnlyShellPrograms(command: string, dialect: ShellCommandDialect = "posix"): string[] | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;
	const context: JudgeContext = {
		dialect,
		depth: 0,
		writes: "none",
		admitTestRuns: false,
		lane: undefined,
		programs: [],
	};
	return walkCommand(trimmed, { list: [process.cwd()], unknown: false }, context) === undefined
		? context.programs
		: undefined;
}

/** Programs whose effects stay with semantic judgment even when the read/write line admits their arguments. */
export function isEffectfulReadOnlyProgram(name: string): boolean {
	return EFFECTFUL_INTERPRETERS.has(name) || SHELL_WRAPPERS.has(name);
}
