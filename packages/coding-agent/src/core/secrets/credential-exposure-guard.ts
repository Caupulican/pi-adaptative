import { minimatch } from "minimatch";
import type { TSchema } from "typebox";
import {
	type AgentTool,
	AgentToolExecutionError,
	type AgentToolResult,
	type ExecutionContext,
	type ExecutionPathAuthority,
	readAgentToolExecutionError,
} from "../../kernel/index.ts";
import { extractToolPathArguments } from "../autonomy/envelope-enforcement.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { runWithPersistedOutputMask } from "../tools/persisted-output-mask.ts";
import {
	parseShellSearchInvocationScope,
	type ShellContentSearchTool,
	type ShellSearchInvocationScope,
} from "../tools/search-command-guard.ts";
import {
	MAX_TRACKED_DIRECTORIES,
	redirectTakesTarget,
	type ShellCommandDialect,
	type ShellToken,
	tokenizeShellCommand,
} from "../tools/shell-command-parser.ts";
import { wrapToolExecution } from "../tools/tool-execution-wrapper.ts";
import { isMissingPathError } from "../util/filesystem-errors.ts";
import { isRecordObject as isRecord } from "../util/value-guards.ts";
import {
	type CredentialBlockMaskKind,
	createCredentialBlockMask,
	isCredentialSecretKey,
	mockCredentialContent,
	mockCredentialFields,
	mockedValue,
	mockProtectedSearchLines,
} from "./credential-content-mock.ts";
import type { CredentialPathPolicy, CredentialPathProbe, CredentialPathProtection } from "./credential-path-policy.ts";
import { createCredentialPathPolicy } from "./native-credential-path-probe.ts";
import { pythonCredentialPathCandidates } from "./python-credential-literals.ts";

/** Tools whose path arguments name the files they read or write. */
const PATH_ARGUMENT_TOOLS = new Set(["read", "edit", "write", "patch", "ls", "image_generate"]);

/** Files a repo_read call addresses: its pathspecs and the object path of every `rev:path` revision. */
function repoReadFileSpecs(args: Record<string, unknown>): string[] {
	const specs: string[] = [];
	if (Array.isArray(args.paths)) {
		for (const spec of args.paths) if (typeof spec === "string" && spec.length > 0) specs.push(spec);
	}
	if (Array.isArray(args.revisions)) {
		for (const revision of args.revisions) {
			if (typeof revision !== "string") continue;
			const colon = revision.indexOf(":");
			if (colon > 0 && colon < revision.length - 1) specs.push(revision.slice(colon + 1));
		}
	}
	return specs;
}
/** Commands that print, copy or transform the content of the files they name. */
const SHELL_INSPECTION_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"bat",
	"nl",
	"tac",
	"od",
	"xxd",
	"hexdump",
	"strings",
	"base64",
	"cut",
	"sort",
	"uniq",
	"diff",
	"comm",
	"paste",
	"column",
	"fold",
	"rev",
	"iconv",
	"cp",
	"tar",
	"jq",
	"sed",
	"awk",
	"grep",
	"rg",
	"ripgrep",
	"type",
	"get-content",
	"select-string",
	"source",
]);
/**
 * Programs that never run their arguments or their input as a command. When every simple command of a POSIX line
 * starts one of these, the words after each program are data (`echo grep -r x`), not a program the guard judges.
 */
const DATA_ONLY_PROGRAMS = new Set([
	"echo",
	"printf",
	"true",
	"false",
	":",
	"cd",
	"pwd",
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"uniq",
	"cut",
	"tr",
	"grep",
	"egrep",
	"fgrep",
	"nl",
	"tac",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"stat",
	"test",
	"[",
	"date",
	"whoami",
	"id",
	"uname",
	"hostname",
]);
/** Unquoted words that open, continue or close a compound command where a program would otherwise start. */
const COMPOUND_COMMAND_WORDS = new Set([
	"!",
	"{",
	"}",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"while",
	"until",
	"do",
	"done",
	"esac",
]);
/**
 * A dotenv path following a reading command in the same simple command, in the raw text: the backstop for what the
 * structural walk cannot see (a nested `sh -c` script, a command substitution). The `.env` must start a path
 * component or a word, so a pattern such as `process.env` is not one, and it must not be an exclusion's value
 * (`--exclude='.env*'`, `-Exclude .env*`): the exclusion the dotenv search rule asks for reads no dotenv file.
 */
const SHELL_SECRET_READ_RE =
	/\b(?:cat|head|tail|less|more|sed|awk|grep|rg|type|get-content|select-string|source)\b[^\n;&|]*(?:[\s\\/'"=(])(?<!--?exclude(?:-dir)?(?:=|\s+)['"]?)\.env(?:\.[A-Za-z0-9._-]+)?\b/i;
const PYTHON_SECRET_READ_RE = /\b(?:open|read_text|read_bytes)\s*\([^\n)]*(?:^|[\\/])?\.env(?:\.[A-Za-z0-9._-]+)?\b/i;
const PYTHON_INSPECTION_RE = /\b(?:open|read_text|read_bytes)\b/;
const DOTENV_GLOB_RE = /(?:^|[\\/])?\.env(?:\.|\*|$)/i;
/** Hidden dotenv names a shell glob must not be able to expand to. */
const HIDDEN_DOTENV_NAMES = [".env", ".env.local", ".env.production"];
const GLOB_COMPONENT_RE = /[*?[]|\{[^{}]*,[^{}]*\}/u;
const MAX_REDACTED_DETAIL_DEPTH = 8;
const MAX_REDACTED_DETAIL_NODES = 10_000;
const NON_DATA_DETAIL_OMITTED = "[NON-DATA DETAIL OMITTED AT CREDENTIAL BOUNDARY]";
const ACCESSOR_DETAIL_OMITTED = "[ACCESSOR DETAIL OMITTED AT CREDENTIAL BOUNDARY]";
/** Built-ins whose state lives in internal slots, so their own keys do not carry their contents. */
const NON_DATA_OBJECT_TAGS = new Set([
	"[object Map]",
	"[object Set]",
	"[object WeakMap]",
	"[object WeakSet]",
	"[object Promise]",
	"[object RegExp]",
	"[object ArrayBuffer]",
	"[object SharedArrayBuffer]",
	"[object Error]",
]);
const JQ_OPTIONS_WITH_ONE_OPERAND = new Set(["-L", "--indent"]);
const JQ_OPTIONS_WITH_TWO_OPERANDS = new Set(["--arg", "--argjson", "--rawfile", "--slurpfile"]);

export interface CredentialExposureBoundary extends CredentialPathProtection {
	redactSensitiveText(text: string, additionalValues?: readonly string[]): string;
	createSensitiveTextRedactor?(additionalValues?: readonly string[]): (text: string) => string;
	getSensitiveValues?(): readonly string[] | Promise<readonly string[]>;
	/** Explicit backend facts; errors never substitute native filesystem results. */
	getPathProbe?(context?: ExecutionContext): CredentialPathProbe;
	/**
	 * The grep tool guarded with this boundary skips protected files in a directory search
	 * (`GrepToolOptions.excludeFile`), so such a search reads no dotenv file and needs no file filter.
	 */
	grepToolSkipsProtectedFiles?: boolean;
}

/**
 * `mock`: the operation runs and its output passes the credential mock stream (values replaced,
 * keys and structure kept). `deny`: the operation is refused before it runs — an authority
 * boundary (a worker lane kept out of owner-private files), not a visibility policy.
 */
export type CredentialExposureMode = "mock" | "deny";

export interface CredentialExposureAssessment {
	/** `search`: only lines attributed to protected files are mocked; `content`: the whole output is. */
	kind: "none" | "search" | "content";
	/** Why deny mode refuses the call; absent when the call runs in both modes. */
	reason?: string;
}

export function isProtectedCredentialPath(
	rawPath: string,
	cwd: string,
	boundary?: CredentialExposureBoundary,
	executionContext?: ExecutionContext,
	pathAuthority?: ExecutionPathAuthority,
): boolean {
	return createCredentialPathPolicy(
		cwd,
		boundary,
		executionContext,
		boundary?.getPathProbe?.(executionContext),
		pathAuthority,
	).isProtected(rawPath);
}

export async function isProtectedCredentialPathAsync(
	rawPath: string,
	cwd: string,
	boundary?: CredentialExposureBoundary,
	executionContext?: ExecutionContext,
	pathAuthority?: ExecutionPathAuthority,
	signal?: AbortSignal,
): Promise<boolean> {
	return createCredentialPathPolicy(
		cwd,
		boundary,
		executionContext,
		boundary?.getPathProbe?.(executionContext),
		pathAuthority,
	).isProtectedAsync(rawPath, signal);
}

/**
 * A filesystem fact the credential walk asks for. The walk is written once as a generator; the synchronous and the
 * asynchronous checks answer its questions with the policy's synchronous or asynchronous methods, so both judge alike.
 */
interface PathQuery {
	readonly kind: "protected" | "token" | "file" | "storage";
	readonly path: string;
	readonly policy: CredentialPathPolicy;
}
type PathAnswer = boolean | undefined;
type CredentialWalk<T> = Generator<PathQuery, T, PathAnswer>;

const SYNC_PATH_ANSWERS: Record<PathQuery["kind"], (policy: CredentialPathPolicy, path: string) => PathAnswer> = {
	protected: (policy, path) => policy.isProtected(path),
	token: (policy, path) => policy.isProtectedToken(path),
	file: (policy, path) => policy.isFile(path),
	storage: (policy, path) => policy.containsProtectedPath(path),
};
const ASYNC_PATH_ANSWERS: Record<
	PathQuery["kind"],
	(policy: CredentialPathPolicy, path: string, signal?: AbortSignal) => Promise<PathAnswer>
> = {
	protected: (policy, path, signal) => policy.isProtectedAsync(path, signal),
	token: (policy, path, signal) => policy.isProtectedTokenAsync(path, signal),
	file: (policy, path, signal) => policy.isFileAsync(path, signal),
	storage: (policy, path, signal) => policy.containsProtectedPathAsync(path, signal),
};

/** A missing path is an unknown file type; every other failure stays the caller's. */
function missingFileAnswer(query: PathQuery, error: unknown): PathAnswer {
	if (query.kind !== "file" || !isMissingPathError(error)) throw error;
	return undefined;
}

function runCredentialWalk<T>(walk: CredentialWalk<T>): T {
	let step = walk.next();
	while (!step.done) {
		let answer: PathAnswer;
		try {
			answer = SYNC_PATH_ANSWERS[step.value.kind](step.value.policy, step.value.path);
		} catch (error) {
			answer = missingFileAnswer(step.value, error);
		}
		step = walk.next(answer);
	}
	return step.value;
}

async function runCredentialWalkAsync<T>(walk: CredentialWalk<T>, signal?: AbortSignal): Promise<T> {
	let step = walk.next();
	while (!step.done) {
		signal?.throwIfAborted();
		let answer: PathAnswer;
		try {
			answer = await ASYNC_PATH_ANSWERS[step.value.kind](step.value.policy, step.value.path, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			answer = missingFileAnswer(step.value, error);
		}
		step = walk.next(answer);
	}
	return step.value;
}

/** True when the query holds from any of the directories a command may resolve `path` from. */
function* anyDirectory(
	kind: PathQuery["kind"],
	path: string,
	policies: readonly CredentialPathPolicy[],
): CredentialWalk<boolean> {
	for (const policy of policies) if ((yield { kind, path, policy }) === true) return true;
	return false;
}

/**
 * What a call risks exposing: `credential_path` names a protected file, `process_environment` projects the process
 * environment, `storage_search` searches a root that holds harness storage or a credential store, `dotenv_search`
 * descends where dotenv files are read, `broad_search` searches without a file filter (its output lines are masked
 * by file; deny mode admits it), `directory_overflow` changes directory past what the walk tracks.
 */
type CredentialRisk =
	| "credential_path"
	| "process_environment"
	| "storage_search"
	| "dotenv_search"
	| "broad_search"
	| "directory_overflow";

interface ShellInvocationSegment {
	invocation: string[];
	/** The index of the program word: after assignments and unquoted compound-command words; the length when none. */
	program: number;
	/** Files read through input redirections (`<`, `N<`, `<>`). */
	inputs: string[];
	/** Command lines nested in its words: command and process substitutions, PowerShell blocks and groups. */
	nested: string[];
	readsPipe: boolean;
}

function nestedCommandLines(token: ShellToken): string[] {
	return [
		...(token.expansions ?? [])
			.filter((expansion) => expansion.kind === "command" || expansion.kind === "process")
			.map((expansion) => expansion.body),
		...(token.groups ?? []).map((group) => group.body),
	];
}

function parseShellInvocations(tokens: readonly ShellToken[]): ShellInvocationSegment[] {
	const segments: ShellInvocationSegment[] = [];
	let invocation: string[] = [];
	let program: number | undefined;
	let inputs: string[] = [];
	let nested: string[] = [];
	let redirectTarget: "input" | "other" | undefined;
	let readsPipe = false;
	const push = () => {
		if (invocation.length > 0 || inputs.length > 0)
			segments.push({ invocation, program: program ?? invocation.length, inputs, nested, readsPipe });
	};
	for (const token of tokens) {
		if (token.kind === "arg") {
			nested.push(...nestedCommandLines(token));
			if (redirectTarget === "input") inputs.push(token.value);
			else if (redirectTarget === undefined) {
				const prefix =
					/^[A-Za-z_][A-Za-z0-9_]*\+?=/u.test(token.value) ||
					(!token.quoted && COMPOUND_COMMAND_WORDS.has(token.value));
				if (program === undefined && !prefix) program = invocation.length;
				invocation.push(token.value);
			}
			redirectTarget = undefined;
			continue;
		}
		if (token.kind === "redirect") {
			redirectTarget = !redirectTakesTarget(token.value)
				? undefined
				: /^\d*<>?$/u.test(token.value)
					? "input"
					: "other";
			continue;
		}
		push();
		invocation = [];
		program = undefined;
		inputs = [];
		nested = [];
		redirectTarget = undefined;
		readsPipe = token.kind === "pipe";
	}
	push();
	return segments;
}

function extractFallbackSearchLines(command: string): string[] {
	const lines: string[] = [];
	for (const line of command.split(/\r?\n/u)) {
		const trimmed = line.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/u, "");
		if (/^(?:rg|ripgrep|grep)\b/iu.test(trimmed)) lines.push(trimmed);
	}
	return lines;
}

/** A word whose last component is a shell glob that can expand to a hidden dotenv name (`.env*`, `.e?v`, `.*`). */
function globMayNameDotenv(word: string): boolean {
	const name = word.split(/[\\/]/u).at(-1) ?? "";
	return GLOB_COMPONENT_RE.test(name) && HIDDEN_DOTENV_NAMES.some((dotenv) => minimatch(dotenv, name));
}

/** The directory a glob word expands under: its components before the first glob component; undefined for no glob. */
function globRoot(word: string): string | undefined {
	const components = word.split(/(?<=[\\/])/u);
	const first = components.findIndex((component) => GLOB_COMPONENT_RE.test(component));
	if (first < 0) return undefined;
	return components.slice(0, first).join("") || ".";
}

function isCredentialSafeGlob(glob: string): boolean {
	if (DOTENV_GLOB_RE.test(glob)) return false;
	const filePattern = glob.replace(/\\/g, "/").split("/").at(-1) ?? "";
	if (/^[A-Za-z0-9_][A-Za-z0-9_.-]{2,}\*$/u.test(filePattern) && !/\.env/i.test(filePattern)) return true;
	const braceSuffixes = filePattern.match(/\.\{([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)+)\}$/)?.[1];
	const suffixes = braceSuffixes
		? braceSuffixes.split(",").map((suffix) => suffix.toLowerCase())
		: [filePattern.match(/\.([A-Za-z0-9_-]+)$/)?.[1]?.toLowerCase()].filter(
				(suffix): suffix is string => suffix !== undefined,
			);
	return suffixes.length > 0 && suffixes.every((suffix) => suffix !== "env");
}

function isCommandLineExplicitOperand(
	target: string,
	commandLineOperands: boolean,
	allowShellVariables: boolean,
): boolean {
	return (
		(commandLineOperands && target === "-") ||
		(allowShellVariables && /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/u.test(target))
	);
}

/**
 * The credential judgment of one content search (shell rg/grep, a process, the grep tool), from every directory the
 * command may run from. A named protected path, or a glob that can expand to a dotenv name, is a credential read. A
 * search root (a directory operand, a glob's directory, the cwd when none is named) that contains harness storage
 * or a credential store is refused, glob or not. A descent that may read dotenv files is refused without a narrow
 * non-dotenv glob. Otherwise a search without a file filter is broad: it runs, its output lines masked by file. A
 * file that exists in any of the directories is an explicit file, not a root (`cd sub && grep x Makefile`).
 */
function* searchCredentialRisk(
	scope: ShellSearchInvocationScope,
	policies: readonly CredentialPathPolicy[],
	commandLineOperands: boolean,
	allowShellVariables: boolean,
): CredentialWalk<CredentialRisk | undefined> {
	for (const target of scope.targets) {
		if (target === "-") continue;
		if (commandLineOperands && globMayNameDotenv(target)) return "credential_path";
		if (yield* anyDirectory("protected", target, policies)) return "credential_path";
	}
	if (scope.metaOnly || scope.readsStdin) return undefined;
	const storageRoots: string[] = [];
	const contentRoots: string[] = [];
	for (const target of scope.targets) {
		if (isCommandLineExplicitOperand(target, commandLineOperands, allowShellVariables)) continue;
		if (policies.some((policy) => policy.isHarnessOwnedSearchTarget(target))) continue;
		const root = commandLineOperands ? globRoot(target) : undefined;
		if (root !== undefined) {
			storageRoots.push(root);
			if (!isCredentialSafeGlob(target)) contentRoots.push(root);
			continue;
		}
		if (yield* anyDirectory("file", target, policies)) continue;
		storageRoots.push(target);
		contentRoots.push(target);
	}
	if (scope.targets.length === 0 && scope.recursive) {
		storageRoots.push(".");
		contentRoots.push(".");
	}
	for (const root of storageRoots) if (yield* anyDirectory("storage", root, policies)) return "storage_search";
	const hasSafeGlob = scope.positiveGlobs.length > 0 && scope.positiveGlobs.every(isCredentialSafeGlob);
	if (contentRoots.length === 0 || hasSafeGlob) return undefined;
	return scope.recursive && scope.mayReadDotenv ? "dotenv_search" : "broad_search";
}

function inspectToolCredentialRisk(
	toolName: string,
	args: readonly string[],
): { searchTool?: ShellContentSearchTool; risk?: "process_environment" } {
	if (toolName === "jq") {
		const filter = jqFilterFromArgs([...args]);
		if (filter && jqFilterReadsProcessEnvironment(filter)) return { risk: "process_environment" };
	}
	const searchTool: ShellContentSearchTool | undefined =
		toolName === "rg" || toolName === "ripgrep" ? "rg" : toolName === "grep" ? "grep" : undefined;
	return { searchTool };
}

interface ParsedInvocationCommand {
	toolName: string;
	args: string[];
	searchTool?: ShellContentSearchTool;
	envRisk?: "process_environment";
	isInspectionCommand: boolean;
}

function parseInvocationCommand(invocation: readonly string[], index: number): ParsedInvocationCommand {
	const toolName = (invocation[index].split(/[\\/]/u).at(-1) ?? "").toLowerCase().replace(/\.exe$/u, "");
	const args = invocation.slice(index + 1);
	const inspected = inspectToolCredentialRisk(toolName, args);
	return {
		toolName,
		args,
		searchTool: inspected.searchTool,
		envRisk: inspected.risk,
		isInspectionCommand: SHELL_INSPECTION_COMMANDS.has(toolName),
	};
}

/** jq's module directories (`-L dir`, `-Ldir`, `--library-path dir`, `--library-path=dir`): `import` reads below them. */
function jqLibraryRoots(args: readonly string[]): string[] {
	const roots: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") break;
		if (arg === "-L" || arg === "--library-path") {
			const value = args[++index];
			if (value !== undefined) roots.push(value);
		} else if (arg.startsWith("--library-path=")) roots.push(arg.slice("--library-path=".length));
		else if (/^-L./u.test(arg)) roots.push(arg.slice(2));
	}
	return roots;
}

const DIRECTORY_CHANGE_COMMANDS = new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);

/**
 * The directories later commands of one command line may resolve relative paths from, after `invocation` ran: a
 * `cd`/`pushd` (or PowerShell's `Set-Location`) adds its target, written with any home spelling. A change inside a
 * conditional or a subshell may or may not hold for what follows, so every earlier directory stays a candidate and a
 * path is judged from all of them. `invocation` starts at the program word (the tokenizer splits a subshell's `(` and
 * `)` off, and a group's `{` comes before the program). `cd -` returns to a directory already a candidate. Undefined
 * when the line changes to more distinct directories than the bound the read-only shell line shares.
 */
function workingDirectoriesAfter(
	words: readonly string[],
	policies: readonly CredentialPathPolicy[],
): readonly CredentialPathPolicy[] | undefined {
	if (words.length === 0) return policies;
	const command = (words[0].split(/[\\/]/u).at(-1) ?? "").toLowerCase().replace(/\.exe$/u, "");
	if (!DIRECTORY_CHANGE_COMMANDS.has(command)) return policies;
	const operands = words.slice(1);
	if (operands.includes("-")) return policies;
	const target = operands.find((operand) => !operand.startsWith("-")) ?? "~";
	const next = [...policies];
	for (const policy of policies) {
		const moved = policy.withCwd(target);
		if (!next.some((known) => known.workingDirectory === moved.workingDirectory)) next.push(moved);
	}
	return next.length > MAX_TRACKED_DIRECTORIES ? undefined : next;
}

const POSIX_SHELL_PROGRAMS = new Set(["bash", "dash", "sh", "zsh"]);

/** The command line a shell program runs from its arguments (`bash -c '...'`, `pwsh -Command ...`), judged like its caller's. */
function nestedShellScript(
	toolName: string,
	args: readonly string[],
): { line: string; dialect: ShellCommandDialect } | undefined {
	if (POSIX_SHELL_PROGRAMS.has(toolName)) {
		const option = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(arg));
		const line = option < 0 ? undefined : args[option + 1];
		return line === undefined ? undefined : { line, dialect: "posix" };
	}
	if (toolName !== "powershell" && toolName !== "pwsh") return undefined;
	const option = args.findIndex((arg) => /^-(?:c|command)$/iu.test(arg));
	return option < 0 || option + 1 >= args.length
		? undefined
		: { line: args.slice(option + 1).join(" "), dialect: "powershell" };
}

/**
 * The credential walk over one shell command line, shared by the synchronous and asynchronous checks: nested command
 * lines (substitutions, PowerShell blocks, `bash -c` and `pwsh -Command` scripts), input redirections, every command
 * that inspects files, every search, and `cd`/`pushd` tracking. Every word of a simple command is judged as a possible
 * program (so a wrapper's program is judged too), unless the line is POSIX and every simple command in it starts a
 * `DATA_ONLY_PROGRAMS` program: then nothing in the line runs data as a command, and only each program word is judged
 * (`echo grep -r x` prints, it does not search). A nested line is always judged at every word, since its output may
 * become a command. A refusal ends the walk; a broad search is remembered and the walk goes on.
 */
function* shellCredentialRisk(
	command: string,
	dialect: ShellCommandDialect,
	paths: CredentialPathPolicy,
	nested = false,
): CredentialWalk<CredentialRisk | undefined> {
	if (SHELL_SECRET_READ_RE.test(command)) return "credential_path";
	const shellTokens = tokenizeShellCommand(command, dialect, { compound: true });
	if (!shellTokens) {
		for (const line of extractFallbackSearchLines(command)) {
			if (!tokenizeShellCommand(line, dialect)) continue;
			const risk = yield* shellCredentialRisk(line, dialect, paths, true);
			if (risk) return risk;
		}
		return undefined;
	}
	let policies: readonly CredentialPathPolicy[] = [paths];
	let broad = false;
	const nestedRisk = function* (
		line: string,
		lineDialect: ShellCommandDialect,
	): CredentialWalk<CredentialRisk | undefined> {
		for (const policy of policies) {
			const risk = yield* shellCredentialRisk(line, lineDialect, policy, true);
			if (risk === "broad_search") broad = true;
			else if (risk) return risk;
		}
		return undefined;
	};
	const segments = parseShellInvocations(shellTokens);
	const programsOnly =
		!nested &&
		dialect === "posix" &&
		segments.every(
			(segment) =>
				segment.program >= segment.invocation.length ||
				DATA_ONLY_PROGRAMS.has(parseInvocationCommand(segment.invocation, segment.program).toolName),
		);
	for (const segment of segments) {
		for (const line of segment.nested) {
			const risk = yield* nestedRisk(line, dialect);
			if (risk) return risk;
		}
		for (const input of segment.inputs) {
			if (globMayNameDotenv(input) || (yield* anyDirectory("protected", input, policies))) return "credential_path";
		}
		const end = programsOnly ? Math.min(segment.program + 1, segment.invocation.length) : segment.invocation.length;
		for (let index = programsOnly ? segment.program : 0; index < end; index++) {
			const cmd = parseInvocationCommand(segment.invocation, index);
			if (cmd.envRisk) return cmd.envRisk;
			const script = nestedShellScript(cmd.toolName, cmd.args);
			if (script) {
				const risk = yield* nestedRisk(script.line, script.dialect);
				if (risk) return risk;
				continue;
			}
			if (cmd.searchTool) {
				const scope = parseShellSearchInvocationScope(cmd.searchTool, cmd.args, segment.readsPipe);
				const risk = yield* searchCredentialRisk(scope, policies, true, true);
				if (risk === "broad_search") broad = true;
				else if (risk) return risk;
				continue;
			}
			if (!cmd.isInspectionCommand) continue;
			for (const arg of cmd.args) {
				if (!arg || arg.startsWith("-") || arg === ".") continue;
				if (globMayNameDotenv(arg) || (yield* anyDirectory("token", arg, policies))) return "credential_path";
			}
			if (cmd.toolName !== "jq") continue;
			for (const root of jqLibraryRoots(cmd.args)) {
				if (yield* anyDirectory("storage", root, policies)) return "storage_search";
			}
		}
		const moved = workingDirectoriesAfter(segment.invocation.slice(segment.program), policies);
		if (!moved) return "directory_overflow";
		policies = moved;
	}
	return broad ? "broad_search" : undefined;
}

function jqFilterFromArgs(args: string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		if (token === "--") return args[index + 1];
		if (JQ_OPTIONS_WITH_TWO_OPERANDS.has(token)) {
			index += 2;
			continue;
		}
		if (JQ_OPTIONS_WITH_ONE_OPERAND.has(token)) {
			index++;
			continue;
		}
		if (token.startsWith("-")) continue;
		return token;
	}
	return undefined;
}

function jqFilterReadsProcessEnvironment(filter: string): boolean {
	return /(?:^|[\s|,(:;[])(?:env|\$ENV)(?=$|[\s|),.;[\]}])/u.test(filter);
}

function* processCredentialRisk(
	executable: string,
	args: readonly string[],
	paths: CredentialPathPolicy,
): CredentialWalk<CredentialRisk | undefined> {
	if (yield { kind: "protected", path: executable, policy: paths }) return "credential_path";
	for (const argument of args) if (yield { kind: "token", path: argument, policy: paths }) return "credential_path";
	const inspected = inspectToolCredentialRisk(paths.executableName(executable), args);
	if (inspected.risk) return inspected.risk;
	if (!inspected.searchTool) return undefined;
	return yield* searchCredentialRisk(
		parseShellSearchInvocationScope(inspected.searchTool, [...args], false),
		[paths],
		true,
		false,
	);
}

function* pythonInspectsCredentialPath(
	code: string,
	scriptPath: string | undefined,
	paths: CredentialPathPolicy,
): CredentialWalk<boolean> {
	if (PYTHON_SECRET_READ_RE.test(code)) return true;
	if (PYTHON_INSPECTION_RE.test(code)) {
		for (const candidate of pythonCredentialPathCandidates(code)) {
			if (yield { kind: "token", path: candidate, policy: paths }) return true;
		}
	}
	return scriptPath !== undefined && (yield { kind: "protected", path: scriptPath, policy: paths }) === true;
}

/** Deny mode is the leaf-worker contract: the worker cannot decide this, so its parent does. */
const DENY_MODE_ESCALATION =
	"If the task cannot proceed without it, finish with status blocked and name what you need in blockers; your parent decides.";

const CREDENTIAL_BLOCK_REASONS = {
	fileBlind:
		"Credential file access is model-blind. Use secret_store migrate with this path, or activate an existing profile, without inspecting credential data.",
	dotenvBlind:
		"Credential dotenv files are model-blind. Use secret_store discover instead of searching their contents.",
	grepDotenvSearch:
		"The grep tool also searches hidden files, so a directory search without a file filter reads dotenv credential files, which are model-blind. Give a narrow non-dotenv glob (for example *.ts) or one file, or search with rg in the shell, which skips hidden files.",
	shellDotenvSearch:
		"This search would read dotenv credential files, which are model-blind: grep -r needs --exclude='.env*' (or a non-dotenv --include), and rg searches hidden or ignored files only with -g '!.env*'. Use secret_store discover for credential names.",
	storageSearch:
		"A search root contains harness storage or a credential store (for example the agent directory or ~/.ssh), which this session may not read. Search a project directory instead.",
	directoryOverflow: `The command line changes directory more often than the credential check tracks (${MAX_TRACKED_DIRECTORIES} possible directories). Run its parts as separate commands.`,
	processEnvBlocked:
		"Direct process-environment projection is blocked because it can expose credentials. Use secret_store discover to list eligible source names without exposing values.",
	shellInspectionBlocked:
		"Direct shell inspection of credential files is blocked. Use secret_store migrate with the file path, then run the credential-consuming command normally.",
	pythonInspectionBlocked:
		"Direct Python inspection of credential files is blocked. Use secret_store migrate with the file path, then run the credential-consuming program normally.",
} as const;

const NO_EXPOSURE: CredentialExposureAssessment = { kind: "none" };

/** A shell or process risk as an assessment: what deny mode refuses, and how mock mode masks the output. */
function commandAssessment(risk: CredentialRisk | undefined): CredentialExposureAssessment {
	switch (risk) {
		case undefined:
			return NO_EXPOSURE;
		case "broad_search":
			return { kind: "search" };
		case "storage_search":
			return { kind: "search", reason: CREDENTIAL_BLOCK_REASONS.storageSearch };
		case "dotenv_search":
			return { kind: "search", reason: CREDENTIAL_BLOCK_REASONS.shellDotenvSearch };
		case "process_environment":
			return { kind: "content", reason: CREDENTIAL_BLOCK_REASONS.processEnvBlocked };
		case "directory_overflow":
			return { kind: "content", reason: CREDENTIAL_BLOCK_REASONS.directoryOverflow };
		case "credential_path":
			return { kind: "content", reason: CREDENTIAL_BLOCK_REASONS.shellInspectionBlocked };
	}
}

function grepToolAssessment(risk: CredentialRisk | undefined, glob: string | undefined): CredentialExposureAssessment {
	if (risk === "credential_path" || (glob !== undefined && DOTENV_GLOB_RE.test(glob))) {
		return { kind: "content", reason: CREDENTIAL_BLOCK_REASONS.dotenvBlind };
	}
	if (risk === "dotenv_search") return { kind: "search", reason: CREDENTIAL_BLOCK_REASONS.grepDotenvSearch };
	return commandAssessment(risk);
}

function stringArgument(args: Record<string, unknown>, name: string): string | undefined {
	const value = args[name];
	return typeof value === "string" ? value : undefined;
}

/** The credential assessment of one tool call, written once for the synchronous and asynchronous checks. */
function* toolCredentialAssessment(
	toolName: string,
	args: Record<string, unknown>,
	paths: CredentialPathPolicy,
	grepSkipsProtectedFiles: boolean,
): CredentialWalk<CredentialExposureAssessment> {
	const fileBlind: CredentialExposureAssessment = { kind: "content", reason: CREDENTIAL_BLOCK_REASONS.fileBlind };
	switch (toolName) {
		case "grep": {
			const target = stringArgument(args, "path");
			const glob = stringArgument(args, "glob");
			// The grep tool descends into every directory and passes `--hidden`; a lane's grep tool skips protected files.
			const scope: ShellSearchInvocationScope = {
				targets: target ? [target] : [],
				positiveGlobs: glob ? [glob] : [],
				hasScopeFilter: glob !== undefined,
				metaOnly: false,
				readsStdin: false,
				recursive: true,
				mayReadDotenv: !grepSkipsProtectedFiles,
			};
			return grepToolAssessment(yield* searchCredentialRisk(scope, [paths], false, false), glob);
		}
		case "find": {
			const target = stringArgument(args, "path");
			const pattern = stringArgument(args, "pattern");
			const named = target !== undefined && (yield { kind: "protected", path: target, policy: paths }) === true;
			return named || (pattern !== undefined && DOTENV_GLOB_RE.test(pattern))
				? { kind: "content", reason: CREDENTIAL_BLOCK_REASONS.dotenvBlind }
				: NO_EXPOSURE;
		}
		case "repo_read":
			for (const spec of repoReadFileSpecs(args))
				if (yield { kind: "protected", path: spec, policy: paths }) return fileBlind;
			return NO_EXPOSURE;
		case "run_process": {
			const executable = stringArgument(args, "executable");
			if (executable === undefined) return NO_EXPOSURE;
			const argv = Array.isArray(args.args)
				? args.args.filter((argument): argument is string => typeof argument === "string")
				: [];
			return commandAssessment(yield* processCredentialRisk(executable, argv, paths));
		}
		case "bash":
		case "powershell":
			return commandAssessment(
				yield* shellCredentialRisk(
					stringArgument(args, "command") ?? "",
					toolName === "powershell" ? "powershell" : "posix",
					paths,
				),
			);
		case "python":
			return (yield* pythonInspectsCredentialPath(
				stringArgument(args, "code") ?? "",
				stringArgument(args, "scriptPath"),
				paths,
			))
				? { kind: "content", reason: CREDENTIAL_BLOCK_REASONS.pythonInspectionBlocked }
				: NO_EXPOSURE;
		default:
			if (!PATH_ARGUMENT_TOOLS.has(toolName)) return NO_EXPOSURE;
			for (const path of extractToolPathArguments(toolName, args)) {
				if (yield { kind: "protected", path, policy: paths }) return fileBlind;
			}
			return NO_EXPOSURE;
	}
}

function credentialPolicyFor(
	cwd: string,
	boundary: CredentialExposureBoundary | undefined,
	executionContext: ExecutionContext | undefined,
	pathAuthority: ExecutionPathAuthority | undefined,
): CredentialPathPolicy {
	return createCredentialPathPolicy(
		cwd,
		boundary,
		executionContext,
		boundary?.getPathProbe?.(executionContext),
		pathAuthority,
	);
}

export function credentialToolBlockReason(
	toolName: string,
	args: unknown,
	cwd: string,
	boundary?: CredentialExposureBoundary,
	executionContext?: ExecutionContext,
	pathAuthority?: ExecutionPathAuthority,
): string | undefined {
	if (toolName === "secret_store" || !isRecord(args)) return undefined;
	const paths = credentialPolicyFor(cwd, boundary, executionContext, pathAuthority);
	return runCredentialWalk(
		toolCredentialAssessment(toolName, args, paths, boundary?.grepToolSkipsProtectedFiles === true),
	).reason;
}

export async function assessCredentialExposureAsync(
	toolName: string,
	args: unknown,
	cwd: string,
	boundary?: CredentialExposureBoundary,
	executionContext?: ExecutionContext,
	pathAuthority?: ExecutionPathAuthority,
	signal?: AbortSignal,
): Promise<CredentialExposureAssessment> {
	if (toolName === "secret_store" || !isRecord(args)) return NO_EXPOSURE;
	signal?.throwIfAborted();
	const paths = credentialPolicyFor(cwd, boundary, executionContext, pathAuthority);
	return runCredentialWalkAsync(
		toolCredentialAssessment(toolName, args, paths, boundary?.grepToolSkipsProtectedFiles === true),
		signal,
	);
}

export async function credentialToolBlockReasonAsync(
	toolName: string,
	args: unknown,
	cwd: string,
	boundary?: CredentialExposureBoundary,
	executionContext?: ExecutionContext,
	pathAuthority?: ExecutionPathAuthority,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return (await assessCredentialExposureAsync(toolName, args, cwd, boundary, executionContext, pathAuthority, signal))
		.reason;
}

/** Known values first (exact), then the shape-preserving mock, which also covers secret-shaped text. */
function createOutputRedactor(
	boundary: CredentialExposureBoundary | undefined,
	mock: (text: string) => string,
	additionalValues: readonly string[],
): (text: string) => string {
	const redactSensitive = boundary?.createSensitiveTextRedactor?.(additionalValues);
	return (text) =>
		mock(
			redactSensitive
				? redactSensitive(text)
				: boundary
					? boundary.redactSensitiveText(text, additionalValues)
					: text,
		);
}

function redactResult<T>(
	result: AgentToolResult<T>,
	boundary?: CredentialExposureBoundary,
	mock: (text: string) => string = mockCredentialFields,
	additionalValues: readonly string[] = [],
): AgentToolResult<T> {
	const redact = createOutputRedactor(boundary, mock, additionalValues);
	// Keys are identifiers, not credential content: the whole-content mocks would replace every key, so keys
	// get only known-value and secret-shape masking.
	const redactKey = createOutputRedactor(boundary, redactKnownSecrets, additionalValues);
	const budget = { nodes: 0 };
	return {
		...result,
		content: result.content.map((block) => (block.type === "text" ? { ...block, text: redact(block.text) } : block)),
		details: redactStructuredDetails(result.details, redact, redactKey, budget) as T,
	};
}

function redactStructuredDetails(
	value: unknown,
	redact: (text: string) => string,
	redactKey: (key: string) => string,
	budget: { nodes: number },
	depth = 0,
): unknown {
	if (typeof value === "string") return redact(value);
	if (typeof value === "bigint") return String(value);
	if (typeof value === "function" || typeof value === "symbol") return NON_DATA_DETAIL_OMITTED;
	if (value === null || typeof value !== "object") return value;
	try {
		// Leaves hold no keys to walk: a wrapper yields its primitive and a date its time.
		if (value instanceof String || value instanceof Number || value instanceof Boolean) {
			return redactStructuredDetails(value.valueOf(), redact, redactKey, budget, depth);
		}
		if (value instanceof Date) return new Date(value.getTime());
		budget.nodes++;
		if (depth >= MAX_REDACTED_DETAIL_DEPTH || budget.nodes > MAX_REDACTED_DETAIL_NODES) {
			return "[DETAIL OMITTED AT CREDENTIAL BOUNDARY]";
		}
		// Internal-slot objects keep their contents outside own properties: a key walk would drop them, or for
		// buffers and strings redact one byte or character at a time. They are omitted, never passed through.
		if (ArrayBuffer.isView(value) || NON_DATA_OBJECT_TAGS.has(Object.prototype.toString.call(value))) {
			return NON_DATA_DETAIL_OMITTED;
		}
		// Copy own data, never the prototype: class instances and custom toJSON methods must not bypass
		// redaction when a consumer serializes the result. Accessors are reported, never run.
		const keys = Object.keys(value);
		if (keys.length > MAX_REDACTED_DETAIL_NODES - budget.nodes) {
			return "[DETAIL OMITTED AT CREDENTIAL BOUNDARY]";
		}
		const isArray = Array.isArray(value);
		const result: Record<string, unknown> | unknown[] = isArray ? new Array(value.length) : {};
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable) continue;
			// Array indices are structure, not content: they keep their position and are never redacted.
			const redactedKey = isArray ? key : redactKey(key);
			let safeKey = redactedKey;
			let collision = 0;
			while (Object.hasOwn(result, safeKey)) safeKey = `${redactedKey} [${++collision}]`;
			const entry: unknown = "value" in descriptor ? descriptor.value : ACCESSOR_DETAIL_OMITTED;
			Object.defineProperty(result, safeKey, {
				value:
					isCredentialSecretKey(key) && ["string", "number", "bigint", "boolean"].includes(typeof entry)
						? mockedValue(redactedKey)
						: redactStructuredDetails(entry, redact, redactKey, budget, depth + 1),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return result;
	} catch {
		return "[UNREADABLE DETAIL OMITTED AT CREDENTIAL BOUNDARY]";
	}
}

/** The mock of one tool call's result text, and the same mock for the output file the call saves, block by block. */
function createExposureMock(
	assessment: CredentialExposureAssessment,
	cwd: string,
	boundary: CredentialExposureBoundary | undefined,
	executionContext: ExecutionContext | undefined,
	pathAuthority: ExecutionPathAuthority | undefined,
): { text: (text: string) => string; kind: CredentialBlockMaskKind } {
	if (assessment.kind === "content") return { text: mockCredentialContent, kind: { kind: "content" } };
	if (assessment.kind === "search") {
		const paths = createCredentialPathPolicy(
			cwd,
			boundary,
			executionContext,
			boundary?.getPathProbe?.(executionContext),
			pathAuthority,
		);
		const isProtectedPath = (path: string) => paths.isProtected(path);
		return {
			text: (text) => mockProtectedSearchLines(text, isProtectedPath),
			kind: { kind: "search", isProtectedPath },
		};
	}
	return { text: mockCredentialFields, kind: { kind: "fields" } };
}

/**
 * Apply the same credential assessment and output mock stream to foreground, extension, scout, and
 * lane tools. The default is the fail-closed authority contract; the owner runtime opts into the
 * mock stream explicitly, so a caller that forgets the mode never widens visibility by accident.
 */
/** Names a thrown non-Error precisely enough to act on: its primitive type, or its constructor. */
function describeThrownValue(error: unknown): string {
	if (error === null) return "null";
	const type = typeof error;
	if (type !== "object") return type;
	const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
	return typeof name === "string" && name.length > 0 ? name : "object";
}

export function wrapToolWithCredentialExposureGuard<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
	cwd: string,
	boundary?: CredentialExposureBoundary,
	mode: CredentialExposureMode = "deny",
): AgentTool<TParameters, TDetails> {
	return wrapToolExecution(tool, (executor, executionContext, pathAuthority) => ({
		...executor,
		failureRecovery: {
			...executor.failureRecovery,
			getFailureCorrection(params, failure) {
				if (failure.failureCode === "credential_access_blocked") return failure.message;
				return executor.failureRecovery?.getFailureCorrection?.(params, failure);
			},
		},
		async execute(toolCallId, params, signal, onUpdate) {
			let mock: (text: string) => string = mockCredentialFields;
			let sensitiveValues: readonly string[] = [];
			const safeUpdate = onUpdate
				? (partial: AgentToolResult<TDetails>) => {
						onUpdate(redactResult(partial, boundary, mock, sensitiveValues));
					}
				: undefined;
			try {
				signal?.throwIfAborted();
				sensitiveValues = (await boundary?.getSensitiveValues?.()) ?? [];
				const assessment = await assessCredentialExposureAsync(
					tool.name,
					params,
					cwd,
					boundary,
					executionContext,
					pathAuthority,
					signal,
				);
				if (assessment.reason && mode === "deny") {
					throw new AgentToolExecutionError(
						`${assessment.reason} ${DENY_MODE_ESCALATION}`,
						"credential_access_blocked",
						"credential-access-blocked",
						"tool_failure",
					);
				}
				const exposureMock = createExposureMock(assessment, cwd, boundary, executionContext, pathAuthority);
				mock = exposureMock.text;
				signal?.throwIfAborted();
				// The output file a call saves (a shell's full output) is written through the same mock, block by
				// block, so a later read of the file shows what the result would.
				const result = await runWithPersistedOutputMask(
					() => createOutputRedactor(boundary, createCredentialBlockMask(exposureMock.kind), sensitiveValues),
					() => executor.execute(toolCallId, params, signal, safeUpdate),
				);
				return redactResult(result, boundary, mock, sensitiveValues);
			} catch (error) {
				// A cancellation is not this guard's to describe: the run's abort reason (a plain string for a
				// named abort, thrown verbatim by throwIfAborted) passes through untouched so the loop finalizes
				// the call as `Operation aborted (<reason>)` without a second line about the guard.
				if (signal?.aborted || (signal?.reason !== undefined && error === signal.reason)) throw error;
				const redact = createOutputRedactor(boundary, mockCredentialFields, sensitiveValues);
				const classified = readAgentToolExecutionError(error);
				if (classified) {
					throw new AgentToolExecutionError(
						redact(classified.message),
						classified.failureCode,
						classified.outputSignature,
						classified.errorKind,
						classified.details,
					);
				}
				if (error instanceof Error) throw new Error(redact(error.message));
				// A thrown non-Error is the live shape of a cancellation: `signal.throwIfAborted()` throws
				// the abort REASON, and a named abort's reason is a plain string. Reporting only that the
				// value was lost left the model, the failure ledger and the operator with no cause at all.
				throw new Error(
					`Credential-safe tool execution failed: ${describeThrownValue(error)}: ${redact(String(error))}`,
				);
			}
		},
	}));
}
