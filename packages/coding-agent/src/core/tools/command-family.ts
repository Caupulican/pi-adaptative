/**
 * Command-family classification shared by the output-reduction pipeline (which reducer applies to a
 * tool result) and the reduction census (which families carry the bytes). One parser, one table:
 * the census must classify exactly the way the runtime does or its "missed savings" would lie.
 *
 * A command is reduced to its primary stage: leading `cd <path> &&` and environment assignments are
 * folded away, the executable name is normalized (`python3` → `python`, `.exe` stripped), and the
 * stages after the primary one are kept as names so a reducer can decide whether a trailing
 * `| head -N` still leaves it applicable.
 */
import { isChangeDirectoryInvocation, parseShellCommandSequence } from "./shell-command-parser.ts";
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

/** Classify a bash command by its primary stage. Never throws; an unparseable command is `other`. */
export function classifyCommandFamily(command: string): CommandFamilyClassification {
	const fallback: CommandFamilyClassification = {
		family: "other",
		tool: "",
		trailingStages: [],
		argv: [],
		verbose: false,
	};
	const sequence = parseShellCommandSequence(command);
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
