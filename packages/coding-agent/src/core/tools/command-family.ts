/**
 * Command-family classification shared by the output-reduction pipeline (which reducer applies to a
 * tool result) and the reduction census (which families carry the bytes). One parser, one table:
 * the census must classify exactly the way the runtime does or its "missed savings" would lie.
 * Beside it, the two readings of what a command does that the bash tool acts on: an ad-hoc interpreter
 * probe (not a workspace mutation) and a wait on state outside the session (run in the background).
 *
 * A command is reduced to its primary stage: leading `cd <path> &&` and environment assignments are
 * folded away, the executable name is normalized (`python3` → `python`, `.exe` stripped), and the
 * stages after the primary one are kept as names so a reducer can decide whether a trailing
 * `| head -N` still leaves it applicable.
 */
import {
	isChangeDirectoryInvocation,
	parseShellCommandSequence,
	parseShellCompound,
	type ShellCompoundNode,
	stripShellInvocationPrefixes,
	tokenizeShellCommand,
} from "./shell-command-parser.ts";
import { isProjectableTestCommand } from "./shell-test-command.ts";

export type CommandFamily =
	| "git"
	| "search"
	| "diagnostics"
	| "test"
	| "package-manager"
	| "listing"
	| "file-dump"
	| "python"
	| "node"
	| "shell"
	| "other";

export interface CommandFamilyClassification {
	family: CommandFamily;
	/** Normalized executable of the primary stage (`rg`, `git`, `cargo`, `python`). */
	tool: string;
	/** First non-flag argument of the primary stage when the family has subcommands (`git diff`, `cargo check`). */
	subcommand?: string;
	/** `cd <path>` that precedes the primary stage. */
	cwdPrefix?: string;
	/** Executables of the stages after the primary one, in order (`head`, `wc`). Empty for a single stage. */
	trailingStages: string[];
	/** Argument vector of the primary stage, environment assignments removed. */
	argv: string[];
	/** The model asked for detail explicitly (`--verbose`, `-vv`, `--nocapture`, ...): reducers must pass through. */
	verbose: boolean;
}

const SUBCOMMAND_TOOLS = new Set([
	"git",
	"yadm",
	"gh",
	"glab",
	"cargo",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"pip",
	"uv",
	"go",
	"dotnet",
	"docker",
	"kubectl",
	"apt",
	"apt-get",
	"brew",
	"svn",
]);
const SEARCH_TOOLS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack", "ugrep"]);
const LISTING_TOOLS = new Set(["ls", "dir", "tree", "find", "fd", "fdfind"]);
const FILE_DUMP_TOOLS = new Set(["cat", "nl", "head", "tail", "more", "less", "type", "bat"]);
const DIAGNOSTIC_TOOLS = new Set([
	"tsc",
	"biome",
	"eslint",
	"ruff",
	"mypy",
	"pyright",
	"rustc",
	"msbuild",
	"clippy-driver",
	"gcc",
	"g++",
	"cc",
	"c++",
	"clang",
	"clang++",
	"make",
	"cmake",
	"ninja",
	"fpc",
	"ppcx64",
	"dcc32",
	"dcc64",
	"javac",
	"php",
	"pylint",
	"flake8",
	"stylelint",
	"htmlhint",
]);
const PACKAGE_MANAGERS = new Set([
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"pip",
	"uv",
	"apt",
	"apt-get",
	"brew",
	"composer",
	"gem",
	"bundle",
]);
const SHELLS = new Set(["pwsh", "powershell", "cmd", "bash", "sh", "zsh"]);
const VERBOSE_FLAGS = new Set([
	"--verbose",
	"-v",
	"-vv",
	"-vvv",
	"--nocapture",
	"--no-filter",
	"--debug",
	"--trace",
	"--full",
]);

function normalizeExecutable(token: string): string {
	const base = token.replace(/\\/gu, "/").split("/").at(-1) ?? token;
	const lower = base.toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, "");
	if (/^python\d*(?:\.\d+)?$/u.test(lower) || lower === "py") return "python";
	if (lower === "nodejs") return "node";
	return lower;
}

/**
 * `npx vitest run`, `bunx tsc`, `pnpm exec eslint .`, `npm run test -- …`: the reducer cares about the
 * program that produced the output, not the launcher. Runner flags before the program are skipped.
 */
function unwrapRunner(argv: string[]): string[] {
	const launcher = normalizeExecutable(argv[0]);
	let index = 1;
	if (launcher === "npx" || launcher === "bunx") {
		while (index < argv.length && argv[index].startsWith("-")) index++;
	} else if (
		(launcher === "pnpm" || launcher === "npm" || launcher === "yarn" || launcher === "bun") &&
		(argv[1] === "exec" || argv[1] === "dlx" || argv[1] === "x")
	) {
		index = 2;
		while (index < argv.length && argv[index].startsWith("-")) index++;
	} else {
		return argv;
	}
	return index < argv.length ? argv.slice(index) : argv;
}

function firstSubcommand(argv: string[]): string | undefined {
	for (const arg of argv.slice(1)) {
		if (arg.startsWith("-")) {
			// `git -C <dir>` and `git -c key=value` carry a value; skip it.
			if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") return undefined;
			continue;
		}
		return arg;
	}
	return undefined;
}

/** `git -C dir status`: the subcommand follows the global option values, not the first bare token. */
function gitSubcommand(argv: string[]): string | undefined {
	let index = 1;
	while (index < argv.length) {
		const token = argv[index];
		if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") index += 2;
		else if (token.startsWith("-")) index += 1;
		else return token;
	}
	return undefined;
}

function familyFor(tool: string, argv: string[], command: string): CommandFamily {
	if (tool === "git" || tool === "yadm") return "git";
	if (SEARCH_TOOLS.has(tool)) return "search";
	if (isProjectableTestCommand(command)) return "test";
	if (tool === "cargo") {
		const sub = firstSubcommand(argv);
		if (sub === "test" || sub === "bench") return "test";
		if (sub === "check" || sub === "build" || sub === "clippy" || sub === "fmt" || sub === "doc")
			return "diagnostics";
		return "package-manager";
	}
	if (tool === "go") {
		const sub = firstSubcommand(argv);
		return sub === "test" ? "test" : sub === "build" || sub === "vet" ? "diagnostics" : "other";
	}
	if (tool === "dotnet") {
		const sub = firstSubcommand(argv);
		return sub === "test" ? "test" : sub === "build" || sub === "restore" ? "diagnostics" : "other";
	}
	if (DIAGNOSTIC_TOOLS.has(tool)) return "diagnostics";
	if (PACKAGE_MANAGERS.has(tool)) return "package-manager";
	if (LISTING_TOOLS.has(tool)) return "listing";
	if (FILE_DUMP_TOOLS.has(tool)) return "file-dump";
	if (tool === "python") return "python";
	if (tool === "node" || tool === "npx" || tool === "bunx") return "node";
	if (SHELLS.has(tool)) return "shell";
	return "other";
}

/**
 * `powershell -NoProfile -Command "Set-Location D:\\repo; cargo check"`, `bash -lc "cd /repo && rg …"`,
 * `cmd /c dir`: a shell wrapper hides the program that produced the output. Returns the wrapped
 * script when the invocation is one, so the classifier can look inside. Measured on a live Windows
 * session every cargo, git and rg call went through such a wrapper and was classified as "powershell".
 */
function unwrapShellWrapper(tool: string, argv: string[]): string | undefined {
	if (tool === "powershell" || tool === "pwsh") {
		const index = argv.findIndex((arg, position) => position > 0 && /^-c(?:ommand)?$/iu.test(arg));
		if (index === -1 || index + 1 >= argv.length) return undefined;
		return argv.slice(index + 1).join(" ");
	}
	if (tool === "bash" || tool === "sh" || tool === "zsh") {
		const index = argv.findIndex((arg, position) => position > 0 && /^-[a-z]*c$/u.test(arg));
		if (index === -1 || index + 1 >= argv.length) return undefined;
		return argv[index + 1];
	}
	if (tool === "cmd") {
		const index = argv.findIndex((arg, position) => position > 0 && /^\/[ck]$/iu.test(arg));
		if (index === -1 || index + 1 >= argv.length) return undefined;
		return argv.slice(index + 1).join(" ");
	}
	return undefined;
}

/** `Set-Location "D:\\repo"; …` or `cd /d C:\\repo && …` at the start of a wrapped script. */
const SCRIPT_CWD_PREFIX_RE =
	/^\s*(?:Set-Location|Push-Location|cd|pushd|chdir)\s+(?:\/d\s+)?(?:"([^"]*)"|'([^']*)'|(\S+))\s*(?:;|&&)\s*/iu;

const MAX_WRAPPER_DEPTH = 3;

/** Classify a bash command by its primary stage. Never throws; an unparseable command is `other`. */
export function classifyCommandFamily(command: string): CommandFamilyClassification {
	return classifyCommandFamilyAtDepth(command, 0);
}

function classifyCommandFamilyAtDepth(command: string, depth: number): CommandFamilyClassification {
	const fallback: CommandFamilyClassification = {
		family: "other",
		tool: "",
		trailingStages: [],
		argv: [],
		verbose: false,
	};
	// Redirections only move bytes the tool already captured (`2>&1`) or away from it (`> log`);
	// they never change which program produced the output, so classification drops them.
	const sequence = parseShellCommandSequence(command, { redirects: "drop" });
	if (!sequence) return fallback;
	let stage = 0;
	let cwdPrefix: string | undefined;
	if (isChangeDirectoryInvocation(sequence.invocations[0] ?? []) && sequence.connectors[0] === "&&") {
		cwdPrefix = sequence.invocations[0][1];
		stage = 1;
	}
	const raw = sequence.invocations[stage];
	if (!raw || raw.length === 0) return fallback;
	let index = 0;
	while (index < raw.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(raw[index])) index++;
	let argv = raw.slice(index);
	if (argv.length === 0) return fallback;
	argv = unwrapRunner(argv);
	const tool = normalizeExecutable(argv[0]);
	if (SHELLS.has(tool) && depth < MAX_WRAPPER_DEPTH) {
		const script = unwrapShellWrapper(tool, argv);
		if (script !== undefined) {
			const prefix = SCRIPT_CWD_PREFIX_RE.exec(script);
			const inner = classifyCommandFamilyAtDepth(prefix ? script.slice(prefix[0].length) : script, depth + 1);
			if (inner.tool) {
				const innerCwd = prefix ? (prefix[1] ?? prefix[2] ?? prefix[3]) : inner.cwdPrefix;
				const outerCwd = cwdPrefix ?? innerCwd;
				return { ...inner, ...(outerCwd !== undefined ? { cwdPrefix: outerCwd } : {}) };
			}
		}
	}
	const trailingStages = sequence.invocations
		.slice(stage + 1)
		.map((invocation) => normalizeExecutable(invocation[0] ?? ""));
	const family = familyFor(tool, argv, command);
	const subcommand =
		family === "git" ? gitSubcommand(argv) : SUBCOMMAND_TOOLS.has(tool) ? firstSubcommand(argv) : undefined;
	return {
		family,
		tool,
		...(subcommand !== undefined ? { subcommand } : {}),
		...(cwdPrefix !== undefined ? { cwdPrefix } : {}),
		trailingStages,
		argv,
		verbose: argv.some((arg) => VERBOSE_FLAGS.has(arg)),
	};
}

/** `git diff`, `cargo check`, `rg`: the label the census and the reduction details use. */
export function commandFamilyLabel(classification: CommandFamilyClassification): string {
	if (!classification.tool) return "(unparsed)";
	return classification.subcommand ? `${classification.tool} ${classification.subcommand}` : classification.tool;
}

/** Ad-hoc Python/Node eval or heredoc probes are not workspace mutations. */
export function isAdHocInterpreterProbe(command: string): boolean {
	const tokens = tokenizeShellCommand(command);
	if (!tokens) return false;
	let args: string[] = [];
	let hasHeredoc = false;
	let skipHeredocDelimiter = false;
	const segmentIsProbe = (): boolean => {
		let runtimeIndex = 0;
		while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[runtimeIndex] ?? "")) runtimeIndex++;
		const commandName = args[runtimeIndex]?.split(/[\\/]/).at(-1)?.toLowerCase();
		if (commandName === "env") {
			runtimeIndex++;
			while (runtimeIndex < args.length) {
				const arg = args[runtimeIndex];
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) || /^(?:-i|--ignore-environment|--null)$/.test(arg)) {
					runtimeIndex++;
					continue;
				}
				if (/^(?:-u|--unset|-C|--chdir)$/.test(arg)) {
					runtimeIndex += 2;
					continue;
				}
				if (/^--(?:unset|chdir)=/.test(arg)) {
					runtimeIndex++;
					continue;
				}
				if (arg === "--") runtimeIndex++;
				break;
			}
		}
		const executable = args[runtimeIndex]
			?.split(/[\\/]/)
			.at(-1)
			?.toLowerCase()
			.replace(/\.exe$/, "");
		const runtime =
			executable === "node"
				? "node"
				: /^(?:python\d*(?:\.\d+)?|pypy\d*)$/.test(executable ?? "")
					? "python"
					: undefined;
		if (!runtime) return false;
		for (let index = runtimeIndex + 1; index < args.length; index++) {
			const arg = args[index];
			if (runtime === "node" && /^(?:-c|-e|-p|--eval|--print)(?:=.*)?$/.test(arg)) return true;
			if (runtime === "python" && arg === "-c") return true;
			if (arg === "-") return hasHeredoc;
			if (arg === "--") return hasHeredoc && (args[index + 1] === undefined || args[index + 1] === "-");
			if (!arg.startsWith("-")) return false;
		}
		return hasHeredoc;
	};
	for (const token of tokens) {
		if (token.kind === "arg") {
			if (skipHeredocDelimiter) skipHeredocDelimiter = false;
			else args.push(token.value);
			continue;
		}
		if (token.kind === "redirect") {
			if (token.value.includes("<<")) {
				hasHeredoc = true;
				skipHeredocDelimiter = true;
			}
			continue;
		}
		if (segmentIsProbe()) return true;
		args = [];
		hasHeredoc = false;
		skipHeredocDelimiter = false;
	}
	return segmentIsProbe();
}

/** Package managers whose `run` (or `run-script`) starts a script of the project's package file. */
const PACKAGE_SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/**
 * A package script that makes or publishes a release, which waits on builds, pushes and the tag's workflow: `release`, or
 * `release` and a separator before one of the verbs that cut, repair, adopt, promote or publish one (`release:patch`,
 * `release-promote`). A script that reads (`release:status`) or writes notes (`release:notes`) is quick, so not a wait.
 */
const RELEASE_SCRIPT_RE = /^release(?:[:._-](?:patch|minor|major|repair|adopt|promote|publish))?$/u;

/**
 * A command whose run ends in a wait on state outside the session, which the bash tool runs as a background task so the
 * wait never holds the turn: `gh run watch`, `gh pr checks --watch`, a release script (`npm`, `pnpm`, `yarn` or `bun`
 * `run release`, `run release:patch` and the like), or a `while` or `until` loop whose body runs `sleep` (a polling loop,
 * `until test -f done; do sleep 5; done`). It is read from the command's parsed structure and counts only as the line's
 * last work: the last pipeline (`cd x && gh run watch 12 | tail -5`), and inside it the last work of a group, a branch
 * of an `if` or `case`, a loop's body or `bash -c '…'`. A line that runs more after the wait (`gh run watch 12 && npm
 * run migrate`) is not one, nor is the same words as an argument (`echo "gh run watch"`, a commit message, `grep "npm
 * run release"`). A bare `sleep N`, a loop that never sleeps, a `for` loop (a bounded list), a `while read` loop (it
 * paces its own input, not a check), and a line the structure reader cannot read (a here-document, a function
 * definition, an unterminated quote) are not waits.
 */
export function isExternalWaitCommand(command: string): boolean {
	return isExternalWaitAtDepth(command, 0);
}

function isExternalWaitAtDepth(command: string, depth: number): boolean {
	const tokens = tokenizeShellCommand(command, "posix", { compound: true });
	if (!tokens) return false;
	const nodes = parseShellCompound(tokens);
	return typeof nodes !== "string" && listWaits(nodes, depth);
}

/** A list ends in a wait when a command of its last pipeline waits: nothing the list runs after the wait is held by it. */
function listWaits(nodes: readonly ShellCompoundNode[], depth: number): boolean {
	let start = nodes.length - 1;
	while (start > 0 && nodes[start]?.piped === true) start--;
	return nodes.slice(Math.max(0, start)).some((node) => nodeWaits(node, depth));
}

/** The commands a compound command runs directly: a group's body, every list of an `if` or `case`, a loop's condition and body. */
function childCommands(node: ShellCompoundNode): ShellCompoundNode[] {
	switch (node.kind) {
		case "simple":
			return [];
		case "group":
			return node.body;
		case "if":
		case "case":
			return node.lists.flat();
		case "loop":
			return [...node.condition, ...node.body];
	}
}

/** A command ends in a wait: a waiting invocation, a polling loop, or a compound command whose last work waits. */
function nodeWaits(node: ShellCompoundNode, depth: number): boolean {
	switch (node.kind) {
		case "simple":
			return invocationWaits(
				node.words.map((word) => word.value),
				depth,
			);
		case "group":
			return listWaits(node.body, depth);
		case "if":
			// Conditions and branches alternate, an `else` last: a branch is what runs after its condition.
			return node.lists.some(
				(list, index) => (index % 2 === 1 || index === node.lists.length - 1) && listWaits(list, depth),
			);
		case "case":
			return node.lists.some((list) => listWaits(list, depth));
		case "loop":
			return isPollingLoop(node) || listWaits(node.body, depth);
	}
}

/** A `while` or `until` loop (no loop variable) that sleeps in its body and whose condition is not a `read` of input. */
function isPollingLoop(node: ShellCompoundNode): boolean {
	if (node.kind !== "loop" || node.variable !== undefined || !node.body.some(runsSleep)) return false;
	return !node.condition.some((command) => command.kind === "simple" && commandName(command) === "read");
}

function commandName(node: Extract<ShellCompoundNode, { kind: "simple" }>): string | undefined {
	const argv = stripShellInvocationPrefixes(node.words.map((word) => word.value));
	return argv.length > 0 ? normalizeExecutable(argv[0]) : undefined;
}

/** Whether a command runs `sleep` anywhere inside it: the pause between the checks of a polling loop. */
function runsSleep(node: ShellCompoundNode): boolean {
	if (node.kind !== "simple") return childCommands(node).some(runsSleep);
	return commandName(node) === "sleep";
}

function invocationWaits(words: string[], depth: number): boolean {
	const argv = stripShellInvocationPrefixes(words);
	if (argv.length === 0) return false;
	const tool = normalizeExecutable(argv[0]);
	if (SHELLS.has(tool)) {
		const script = depth < MAX_WRAPPER_DEPTH ? unwrapShellWrapper(tool, argv) : undefined;
		return script !== undefined && isExternalWaitAtDepth(script, depth + 1);
	}
	const operands = argv.slice(1).filter((arg) => !arg.startsWith("-"));
	if (tool === "gh")
		return (
			(operands[0] === "run" && operands[1] === "watch") ||
			(operands[0] === "pr" && operands[1] === "checks" && argv.includes("--watch"))
		);
	if (!PACKAGE_SCRIPT_RUNNERS.has(tool) || (argv[1] !== "run" && argv[1] !== "run-script")) return false;
	const script = argv.slice(2).find((arg) => !arg.startsWith("-"));
	return script !== undefined && RELEASE_SCRIPT_RE.test(script);
}
