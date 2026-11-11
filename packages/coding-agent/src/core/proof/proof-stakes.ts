/**
 * Proof stakes: how much a delivered result could cost if it is wrong, read from code facts only.
 *
 * The level decides how deep the proof sheet goes and whether the fresh-context review and the quiz are offered. It never
 * decides whether work may run, close or ship: stakes inform the owner, they never hold anything. Every fact is a count or
 * an exact token match the host can recompute; no model reads or scores anything here.
 */

import { shellExecutions } from "../model-router/read-only-shell-policy.ts";
import { lexShellCommand } from "../objective-execution/git-shell-lexer.ts";
import { parseShellCommandSequence, type ShellCommandSequence, shellWord } from "../tools/shell-command-parser.ts";
import { classifyShellVerificationCommand } from "../tools/shell-test-command.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { PROOF_STAKES_LEVEL_RANK, type ProofStakesLevel } from "./stakes-levels.ts";

export { highestStakesLevel, PROOF_STAKES_LEVELS, type ProofStakesLevel } from "./stakes-levels.ts";

export interface ProofStakes {
	readonly level: ProofStakesLevel;
	/** The facts that set the level, in plain words; empty for `low`. */
	readonly facts: readonly string[];
}

/** The code facts a stakes reading needs; every field is something the host recorded, never a model statement. */
export interface ProofStakesFacts {
	readonly changedFiles: readonly string[];
	/** Changed files that sit on a harness write-protected path (computed by the caller against its protected roots). */
	readonly protectedFiles: readonly string[];
	/** Shell command lines that ran for the result, as recorded by the host. */
	readonly commands: readonly string[];
	/** Python source the result ran, as recorded by the host: the script text, never a path it was run from. */
	readonly scripts?: readonly string[];
	/** Facts a caller already scanned from the full text (a worker receipt's `stakesFacts`): read as they are, never re-scanned. */
	readonly scannedFacts?: readonly string[];
	/** The `pi_tools` file writes those scans counted, added to the changed-file count as {@link PythonCodeFacts.fileWrites} is. */
	readonly scannedFileWrites?: number;
	/** Python files the host did not read for their stakes: outside the read scope, over the cap, or not scanned when they ran. */
	readonly unreadScripts?: number;
	/** Spend recorded against the result, in USD; absent when not metered. */
	readonly spendUsd?: number;
	/** Messages or actions sent to people outside the session for the result. */
	readonly outboundActions?: number;
	readonly failedChecks: number;
	readonly inconclusive: number;
}

/** Past this many changed files the write scope alone counts as an elevated fact. */
export const PROOF_STAKES_WIDE_CHANGE_FILES = 10;
/** Recorded spend at or past this many USD counts as an elevated fact. */
export const PROOF_STAKES_SPEND_USD = 1;

const PUBLISHING_GIT = new Set(["push"]);
const PUBLISHING_PACKAGE = new Set(["publish"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NO_VALUE_OPTIONS: ReadonlySet<string> = new Set();
/** Global git options whose value is the next word (`git -C <dir> push`): the value is never the subcommand. */
const GIT_VALUE_OPTIONS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--config-env",
]);
/** Global gh options whose value is the next word (`gh -R owner/repo release create`). */
const GH_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-R", "--repo"]);
/** The `gh release` actions that change a release, each with the fact it records. */
const GH_RELEASE_WRITES: ReadonlyMap<string, string> = new Map([
	["create", "a release was made"],
	["upload", "release assets were uploaded"],
	["edit", "a release was edited"],
	["delete", "a release was deleted"],
	["delete-asset", "a release asset was deleted"],
]);
/** `git tag` flags that list tags (or filter the listing) instead of creating or deleting one. */
const GIT_TAG_LISTING =
	/^(?:-[a-zA-Z]*[lnv][a-zA-Z]*\d*|--(?:list|verify|contains|no-contains|points-at|merged|no-merged|sort|format|column|color)(?:=.*)?)$/u;
/** `git tag` flags that create or delete a tag: annotate, sign, delete and message. */
const GIT_TAG_WRITING = /^(?:-[a-zA-Z]*[asdm][a-zA-Z]*|--(?:annotate|sign|delete|message)(?:=.*)?)$/u;

/** The index of the first word after `words[0]` that is not an option or an option's value; -1 when there is none. */
function subcommandIndex(words: readonly string[], valueOptions: ReadonlySet<string>): number {
	for (let index = 1; index < words.length; index++) {
		const word = words[index] as string;
		if (valueOptions.has(word)) {
			index++;
			continue;
		}
		if (!word.startsWith("-")) return index;
	}
	return -1;
}

/**
 * Whether the words after `git tag` create or delete a tag. A listing flag makes it a read; otherwise a write flag, or a tag
 * name (a word that is not a flag), makes it a write. `git tag` alone lists.
 */
function gitTagWrites(args: readonly string[]): boolean {
	if (args.some((word) => GIT_TAG_LISTING.test(word))) return false;
	if (args.some((word) => GIT_TAG_WRITING.test(word))) return true;
	return args.some((word) => !word.startsWith("-"));
}

/** The forced forms of a git push, branch or checkout: the short flag and the long forms of `--force`. */
const FORCE_FLAGS: ReadonlySet<string> = new Set(["-f", "--force", "--force-with-lease", "--force-if-includes"]);

/** The fact a command the host cannot read sets: its effects are unknown, so it rates at the highest level. */
export const UNREADABLE_COMMAND_FACT = "a command ran that the host could not read";

/** The program name of an argument vector's first word: the base name, without a Windows executable suffix. */
function programName(token: string): string {
	return token
		.replace(/^.*[\\/]/u, "")
		.replace(/\.(?:exe|cmd|bat)$/iu, "")
		.toLowerCase();
}

/** The check-like verification commands (compile, lint, build, test runs and check scripts), for file coverage. */
const CHECK_CONTEXT = { cwd: "/", flavor: "posix" } as const;

/**
 * The launcher of a package binary at the head of one command segment (`npx -y tsc`, `pnpm exec biome`, `bun x tsc`),
 * which the classifier does not read as a verification stage. Returns the segment without it.
 */
function withoutLauncher(argv: readonly string[]): string[] {
	const name = programName(argv[0] ?? "");
	let index = 0;
	if (name === "npx" || name === "bunx" || name === "pnpx") {
		index = 1;
		while (argv[index] === "-y" || argv[index] === "--yes") index++;
	} else if ((name === "pnpm" || name === "yarn") && argv[1] === "exec") index = 2;
	else if (name === "bun" && argv[1] === "x") index = 2;
	return argv.slice(index);
}

/**
 * The same command line with the launcher stripped from every segment, its connectors kept. A segment that is only a
 * launcher leaves nothing to run, so the line has no verification form (undefined).
 */
function withoutSegmentLaunchers(sequence: ShellCommandSequence): string | undefined {
	const parts: string[] = [];
	for (const [index, argv] of sequence.invocations.entries()) {
		const words = withoutLauncher(argv);
		if (words.length === 0) return undefined;
		parts.push(words.map(shellWord).join(" "));
		const connector = sequence.connectors[index];
		if (connector !== undefined) parts.push(connector);
	}
	return parts.join(" ");
}

/** One leading launcher of a package binary (`npx -y tsc`, `pnpm exec biome`, `bun x tsc`) on the whole line. */
const LEADING_LAUNCHER = /^(?:(?:npx|bunx|pnpx)(?:\s+(?:-y|--yes))*|(?:pnpm|yarn)\s+exec|bun\s+x)\s+/u;

/**
 * Whether a command is a check: a compile, lint, build or test run, or a check script. Only a check counts as having
 * looked at the files it names. The classification reads the shape of the command, not the directory it runs in. A
 * launcher is stripped from the head of the line, and from every segment of it (`cd pkg && npx vitest`).
 */
export function isCheckCommand(command: string): boolean {
	const line = command.trim();
	const head = line.replace(LEADING_LAUNCHER, "");
	if (classifyShellVerificationCommand(head, CHECK_CONTEXT) !== undefined) return true;
	const sequence = parseShellCommandSequence(line);
	if (!sequence) return false;
	const stripped = withoutSegmentLaunchers(sequence);
	return stripped !== undefined && classifyShellVerificationCommand(stripped, CHECK_CONTEXT) !== undefined;
}

/**
 * The one publish or destructive edge a command crosses, in plain words; undefined for every other command. A command the
 * host cannot read is an edge of its own (the highest stakes), never a silent pass. Wrappers (`sudo`, `env`, `bash -c`,
 * `xargs`, `nice`, `timeout`, `command`) are unwrapped by the shell reader, which lists the program each one runs.
 */
export function proofCommandEdge(command: string): string | undefined {
	if (!lexShellCommand(command).ok) return UNREADABLE_COMMAND_FACT;
	const executions = shellExecutions(command);
	if (executions.unjudged.length > 0) return UNREADABLE_COMMAND_FACT;
	for (const argv of executions.invocations) {
		// Only the program name is reduced to its base name (`/usr/bin/git`): an argument such as `--git-dir=/a/b` stays whole.
		const words = argv.map((token, index) => (index === 0 ? programName(token) : token));
		const head = words[0];
		const valueOptions = head === "git" ? GIT_VALUE_OPTIONS : head === "gh" ? GH_VALUE_OPTIONS : NO_VALUE_OPTIONS;
		const subIndex = subcommandIndex(words, valueOptions);
		const sub = subIndex < 0 ? undefined : words[subIndex];
		if (head === "git" && sub) {
			if (PUBLISHING_GIT.has(sub)) return `git ${sub} ran`;
			if (sub === "tag" && gitTagWrites(words.slice(subIndex + 1))) return "git tag ran";
			if (sub === "reset" && words.includes("--hard")) return "git reset --hard ran";
			if (sub === "clean" && words.some((word) => /^-[a-z]*f/.test(word) || word === "--force"))
				return "git clean ran";
			if (words.some((word) => FORCE_FLAGS.has(word))) {
				if (sub === "push" || sub === "branch" || sub === "checkout") return `git ${sub} with force ran`;
			}
		}
		if (head && PACKAGE_MANAGERS.has(head) && sub && PUBLISHING_PACKAGE.has(sub)) return `${head} publish ran`;
		if (head === "gh" && sub === "release") {
			const releaseWords = words.slice(subIndex);
			const actionIndex = subcommandIndex(releaseWords, GH_VALUE_OPTIONS);
			const fact = actionIndex < 0 ? undefined : GH_RELEASE_WRITES.get(releaseWords[actionIndex] as string);
			if (fact) return fact;
		}
		if (head === "rm" && words.some((word) => /^-[a-z]*r/i.test(word) || word === "--recursive"))
			return "a recursive delete ran";
	}
	return undefined;
}

/** A dangerous python operation the closed scan names, in plain words. Any other line of python is no fact. */
const PYTHON_OPERATION_FACTS: readonly { readonly pattern: RegExp; readonly fact: string }[] = [
	{
		pattern: /\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(/u,
		fact: "a python script deleted files or directories (os.remove, os.unlink or os.rmdir)",
	},
	{ pattern: /\bshutil\.rmtree\s*\(/u, fact: "a python script deleted a directory tree (shutil.rmtree)" },
	// Any call is high by design: a move can overwrite the file it names, and the closed scan reads no arguments to tell them apart.
	{ pattern: /\bshutil\.move\s*\(/u, fact: "a python script moved files or directories (shutil.move)" },
	{
		pattern: /\bsubprocess\b|\bos\.(?:system|popen)\s*\(/u,
		fact: "a python script started other programs (subprocess, os.system or os.popen)",
	},
	{
		pattern: /\.(?:write_text|write_bytes|unlink|rmdir)\s*\(/u,
		fact: "a python script wrote or deleted files through pathlib",
	},
	{
		pattern: /\brequests\.(?:post|put|delete|patch)\s*\(/u,
		fact: "a python script sent a network request that changes data",
	},
	{ pattern: /\bsmtplib\b/u, fact: "a python script sent email (smtplib)" },
	{ pattern: /\bpip3?\s+install\b|-m\s+pip\s+install\b/u, fact: "a python script installed packages (pip install)" },
];
/**
 * Where a builtin or `io` `open(` call starts; its arguments follow the parenthesis (see {@link callArguments}). `os.open`
 * takes integer flags rather than a mode string, and object methods (`Image.open`, `webbrowser.open`) are not file-mode opens.
 */
const OPEN_CALL_START = /(?<![.\w])(?:(?:io|builtins)\.)?open\s*\(/gu;
/** A whole quoted string literal (`'w'`, `"rb"`): the only form of a mode argument the host reads. */
const MODE_STRING_LITERAL = /^(?:"[^"]*"|'[^']*')$/u;
/** The `mode=` keyword and its equals sign, in front of a keyword mode argument. */
const MODE_KEYWORD_PREFIX = /^mode\s*=\s*/u;
/** A keyword argument (`encoding="utf-8"`), as opposed to a positional one. */
const KEYWORD_ARGUMENT = /^[A-Za-z_]\w*\s*=(?!=)/u;
/** The `mode=` keyword argument of an `open(` call. */
const MODE_KEYWORD_ARGUMENT = /^mode\s*=(?!=)/u;
const URLLIB_DATA = /\burlopen\s*\([^()]*\bdata\s*=/u;
const SOCKET_OPEN = /\bsocket\.socket\s*\(/u;
const SOCKET_CONNECT = /\.connect\s*\(/u;
const SOCKET_SEND = /\.(?:send|sendall|sendto)\s*\(/u;
const PI_TOOLS_WRITE = /\bpi_tools\.(?:edit|write)\s*\(/gu;

/** What the closed scan reads from one python source: the dangerous operations it names, and its `pi_tools` writes. */
export interface PythonCodeFacts {
	readonly operations: readonly string[];
	/** Calls to `pi_tools.edit` and `pi_tools.write`: each one is a changed-file fact, as the edit and write tools are. */
	readonly fileWrites: number;
}

/**
 * Blanks python comments (`#` to end of line) and quoted string literals (`'...'`, `"..."`, `'''...'''`, `"""..."""`) to
 * spaces while keeping every character offset and newline intact, so `open(` inside a string or comment matches nothing while
 * a real call's offset still indexes into `code`. An unterminated single-line quote ends at its line break.
 */
function blankPythonNonCode(code: string): string {
	let out = "";
	for (let index = 0; index < code.length; index++) {
		const char = code[index] as string;
		if (char === "#") {
			while (index < code.length && code[index] !== "\n") {
				out += " ";
				index++;
			}
			if (index < code.length) out += "\n";
			continue;
		}
		if (char === '"' || char === "'") {
			const triple = code[index + 1] === char && code[index + 2] === char;
			if (triple) {
				out += "   ";
				index += 3;
			} else {
				out += " ";
				index++;
			}
			while (index < code.length) {
				const inner = code[index] as string;
				if (inner === "\\" && index + 1 < code.length) {
					const escaped = code[index + 1] as string;
					out += escaped === "\n" ? " \n" : "  ";
					index += 2;
					continue;
				}
				if (triple) {
					if (inner === char && code[index + 1] === char && code[index + 2] === char) {
						out += "   ";
						index += 2;
						break;
					}
					out += inner === "\n" ? "\n" : " ";
					index++;
					continue;
				}
				if (inner === char) {
					out += " ";
					break;
				}
				if (inner === "\n") {
					out += "\n";
					break;
				}
				out += " ";
				index++;
			}
			continue;
		}
		out += char;
	}
	return out;
}

/**
 * The top-level arguments of a call whose argument list starts at `start` (just past its opening parenthesis), read to the
 * matching closing parenthesis. Brackets and braces nest, comments are skipped, and a quoted literal is read whole, so a
 * parenthesis or comma inside a string or comment nests or splits nothing. A call left open reads to the end of the code.
 */
function callArguments(code: string, start: number): string[] {
	const args: string[] = [];
	let current = "";
	let depth = 0;
	let quote: string | undefined;
	let triple = false;
	for (let index = start; index < code.length; index++) {
		const char = code[index] as string;
		if (quote !== undefined) {
			current += char;
			if (char === "\\" && index + 1 < code.length) current += code[++index];
			else if (triple && char === quote && code[index + 1] === quote && code[index + 2] === quote) {
				current += quote + quote;
				index += 2;
				quote = undefined;
				triple = false;
			} else if (!triple && (char === quote || char === "\n")) quote = undefined;
			continue;
		}
		if (char === "#") {
			while (index + 1 < code.length && code[index + 1] !== "\n") index++;
			continue;
		}
		if (char === ")" && depth === 0) break;
		if (char === '"' || char === "'") {
			quote = char;
			triple = code[index + 1] === char && code[index + 2] === char;
			if (triple) {
				current += char + char + char;
				index += 2;
				continue;
			}
		} else if (char === "(" || char === "[" || char === "{") depth++;
		else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
		if (char === "," && depth === 0) {
			args.push(current.trim());
			current = "";
		} else current += char;
	}
	if (current.trim() !== "") args.push(current.trim());
	return args;
}

/**
 * Whether an `open(` call may write: its mode argument (the second positional, or a `mode=` keyword anywhere in the call) is a
 * write, append or create literal, or it is not a string literal at all (a variable or an expression). The host cannot read
 * a mode it does not see as a literal, so such a call is a write-capable fact, rated high. A call with no mode argument or a
 * read literal is no fact. Other arguments (an `encoding=` value) are not the mode.
 */
function opensForWriting(code: string): boolean {
	const scrubbed = blankPythonNonCode(code);
	for (const call of scrubbed.matchAll(OPEN_CALL_START)) {
		const args = callArguments(code, (call.index ?? 0) + call[0].length);
		const second = args[1];
		const modes = [
			...(second !== undefined && !KEYWORD_ARGUMENT.test(second) ? [second] : []),
			...args.filter((arg) => MODE_KEYWORD_ARGUMENT.test(arg)).map((arg) => arg.replace(MODE_KEYWORD_PREFIX, "")),
		];
		for (const mode of modes) {
			if (!MODE_STRING_LITERAL.test(mode)) return true;
			if (/[wax+]/u.test(mode.slice(1, -1))) return true;
		}
	}
	return false;
}

/**
 * The closed scan of one python source. It reads the code text for the operations listed above and nothing else: it
 * never lexes the code as shell, so an unterminated quote or a backtick in python is no fact of its own. A python call
 * run from a file (`scriptPath`) reaches this scan through the file's source, which the host reads when the call runs
 * (see {@link scriptStakesOf}); the path itself is no fact.
 */
export function pythonCodeFacts(code: string): PythonCodeFacts {
	const operations = PYTHON_OPERATION_FACTS.filter(({ pattern }) => pattern.test(code)).map(({ fact }) => fact);
	if (opensForWriting(code)) operations.push("a python script wrote files (open in a write, append or create mode)");
	if (URLLIB_DATA.test(code)) operations.push("a python script sent data over the network (urllib with data)");
	if (SOCKET_OPEN.test(code) && SOCKET_CONNECT.test(code) && SOCKET_SEND.test(code))
		operations.push("a python script opened a socket and sent data");
	return { operations: [...new Set(operations)], fileWrites: [...code.matchAll(PI_TOOLS_WRITE)].length };
}

/**
 * The stakes the host read from one python file a call ran (`details.scriptStakes`): the closed scan of its source when the
 * host could read it, or the plain reason it could not (outside the read scope, over {@link MAX_SCRIPT_STAKES_FILE_BYTES}).
 */
export type ScriptStakes =
	| { readonly status: "read"; readonly operations: readonly string[]; readonly fileWrites: number }
	| { readonly status: "unread"; readonly reason: string };

/** The largest python file the host reads for its stakes; a larger file is unread, never scanned in part. */
export const MAX_SCRIPT_STAKES_FILE_BYTES = 256 * 1024;

/** The stakes of one python source the host read: the closed scan of its code, in the shape a call's details keep. */
export function scriptStakesOf(source: string): ScriptStakes {
	const facts = pythonCodeFacts(source);
	return { status: "read", operations: facts.operations, fileWrites: facts.fileWrites };
}

/** The script stakes a result's details keep, read back from the session record; undefined for any other value. */
export function scriptStakesFromDetail(value: unknown): ScriptStakes | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (value.status === "read" && Array.isArray(value.operations) && typeof value.fileWrites === "number") {
		const operations = value.operations.filter((operation): operation is string => typeof operation === "string");
		return operations.length === value.operations.length
			? { status: "read", operations, fileWrites: value.fileWrites }
			: undefined;
	}
	if (value.status === "unread" && typeof value.reason === "string") return { status: "unread", reason: value.reason };
	return undefined;
}

/**
 * The publish, destructive and unreadable facts of a result's shell command lines (see {@link proofCommandEdge}), of its
 * python sources (see {@link pythonCodeFacts}) and of the facts a caller already scanned, each named once.
 */
function commandEdges(facts: ProofStakesFacts): string[] {
	const shell = facts.commands.map(proofCommandEdge).filter((edge): edge is string => edge !== undefined);
	const scripts = (facts.scripts ?? []).flatMap((code) => pythonCodeFacts(code).operations);
	return [...new Set([...shell, ...scripts, ...(facts.scannedFacts ?? [])])];
}

/** The stakes of one result: low with no fact, elevated with one elevated fact, high with any high fact or two elevated. */
export function readProofStakes(facts: ProofStakesFacts): ProofStakes {
	const high: string[] = [];
	const elevated: string[] = [];
	if (facts.protectedFiles.length > 0)
		high.push(
			`${facts.protectedFiles.length} protected file(s) changed: ${facts.protectedFiles.slice(0, 3).join(", ")}`,
		);
	for (const edge of commandEdges(facts).slice(0, 3)) high.push(edge);
	if ((facts.outboundActions ?? 0) > 0)
		high.push(`${facts.outboundActions} message(s) or action(s) reached people outside the session`);
	const scriptWrites = (facts.scripts ?? []).reduce((total, code) => total + pythonCodeFacts(code).fileWrites, 0);
	const changed = facts.changedFiles.length + scriptWrites + (facts.scannedFileWrites ?? 0);
	if (changed > PROOF_STAKES_WIDE_CHANGE_FILES) elevated.push(`${changed} files changed`);
	if ((facts.spendUsd ?? 0) >= PROOF_STAKES_SPEND_USD) elevated.push(`$${(facts.spendUsd ?? 0).toFixed(2)} spent`);
	if (facts.failedChecks > 0) elevated.push(`${facts.failedChecks} check(s) failed`);
	if (facts.inconclusive > 0) elevated.push(`${facts.inconclusive} item(s) left inconclusive`);
	if ((facts.unreadScripts ?? 0) > 0) elevated.push(`${facts.unreadScripts} python script(s) the host did not read`);
	const level: ProofStakesLevel =
		high.length > 0 || elevated.length >= 2 ? "high" : elevated.length === 1 ? "elevated" : "low";
	return { level, facts: [...high, ...elevated] };
}

/** Several readings of one result's stakes as one: the highest level, and every fact behind any of them. */
export function highestProofStakes(readings: readonly ProofStakes[]): ProofStakes {
	const level = readings.reduce<ProofStakesLevel>(
		(best, reading) =>
			PROOF_STAKES_LEVEL_RANK[reading.level] > PROOF_STAKES_LEVEL_RANK[best] ? reading.level : best,
		"low",
	);
	return { level, facts: [...new Set(readings.flatMap((reading) => reading.facts))] };
}

/**
 * The reading a recorded level gives a result that kept no facts of its own, such as a plan join that reads the levels its
 * steps recorded at their settlement. A missing or low level reads as no fact.
 */
export function recordedStakesReading(level: ProofStakesLevel | undefined, subject: string): ProofStakes {
	if (level === undefined || level === "low") return { level: "low", facts: [] };
	return { level, facts: [`${subject} rated ${level} when it settled`] };
}
