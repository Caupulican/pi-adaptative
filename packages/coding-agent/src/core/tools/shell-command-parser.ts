export type ShellTokenKind = "arg" | "operator" | "pipe" | "redirect";

/** Text the shell runs or evaluates while it expands a word: `$(...)`, backticks, `<(...)`, `$((...))`, `${...}`. */
export interface ShellExpansion {
	readonly kind: "command" | "process" | "arithmetic" | "parameter";
	/** What is inside the delimiters. */
	readonly body: string;
}

/** A PowerShell script block, subexpression, parenthesized pipeline, array or hashtable written inside a word. */
export interface ShellGroup {
	readonly kind: "block" | "subexpression" | "group" | "array" | "hashtable";
	/** What is inside the delimiters. */
	readonly body: string;
}

export interface ShellToken {
	kind: ShellTokenKind;
	value: string;
	/** POSIX expansions written outside single quotes, in order; their text stays in `value`. */
	expansions?: ShellExpansion[];
	/** PowerShell groups written in the word (also `$(...)` inside a double-quoted string), in order. */
	groups?: ShellGroup[];
	/** The word starts with a quoted string: a string literal, never a command name to PowerShell. */
	literal?: boolean;
}

interface TokenizeOptions {
	operators: boolean;
	dialect: ShellCommandDialect;
}

export type ShellCommandDialect = "posix" | "powershell";

/**
 * How many directories a command line may leave its shell in before a gate that follows `cd` stops tracking them.
 * One bound for the read-only line and the credential guard, so both judge the same command lines.
 */
export const MAX_TRACKED_DIRECTORIES = 64;

function defaultShellCommandDialect(): ShellCommandDialect {
	// Pi exposes Bash-like source on every platform. Native PowerShell callers opt in explicitly.
	return "posix";
}

function hasWindowsPathPrefix(value: string): boolean {
	return /^[A-Za-z]:/u.test(value) || value.startsWith("\\\\");
}

/** Characters that end an unquoted word. */
const WORD_END_RE = /[\s|&;<>()]/u;

/**
 * The index of the delimiter that closes a construct whose body starts at `start`, or -1 when it never closes.
 * Quotes and escapes inside are honoured, so a `)` inside a string does not close it.
 */
function closingIndex(input: string, start: number, open: string, close: string, dialect: ShellCommandDialect): number {
	let depth = 1;
	let quote: "'" | '"' | undefined;
	const escapeChar = dialect === "powershell" ? "`" : "\\";
	for (let index = start; index < input.length; index++) {
		const char = input[index]!;
		if (char === escapeChar && quote !== "'") {
			index++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (char === open && open !== close) depth++;
		else if (char === close && --depth === 0) return index;
	}
	return -1;
}

/** Where a POSIX backtick substitution opened at `start` closes, or -1. */
function closingBacktick(input: string, start: number): number {
	for (let index = start; index < input.length; index++) {
		if (input[index] === "\\") index++;
		else if (input[index] === "`") return index;
	}
	return -1;
}

interface WordConstruct {
	/** Index of the construct's last character. */
	readonly end: number;
	readonly expansion?: ShellExpansion;
	readonly group?: ShellGroup;
}

/**
 * The expansion or group that starts at `index`: undefined when none does, null when it never closes. POSIX: `$(`,
 * `$((`, `${`, `$[` and backticks (also inside double quotes), `<(` and `>(` outside them. PowerShell: `$(` (also inside
 * double quotes), `${name}`, and outside quotes `@(`, `@{`, `(` and `{`.
 */
function wordConstructAt(
	input: string,
	index: number,
	dialect: ShellCommandDialect,
	quoted: boolean,
): WordConstruct | null | undefined {
	const char = input[index];
	const next = input[index + 1];
	const closed = (
		end: number,
		bodyStart: number,
		make: (body: string) => Pick<WordConstruct, "expansion" | "group">,
	): WordConstruct | null => (end < 0 ? null : { end, ...make(input.slice(bodyStart, end)) });
	if (dialect === "posix") {
		if (char === "`")
			return closed(closingBacktick(input, index + 1), index + 1, (body) => ({
				expansion: { kind: "command", body },
			}));
		if (char === "$" && next === "(") {
			const kind = input[index + 2] === "(" ? "arithmetic" : "command";
			return closed(closingIndex(input, index + 2, "(", ")", dialect), index + 2, (body) => ({
				expansion: { kind, body },
			}));
		}
		if (char === "$" && next === "{")
			return closed(closingIndex(input, index + 2, "{", "}", dialect), index + 2, (body) => ({
				expansion: { kind: "parameter", body },
			}));
		if (char === "$" && next === "[")
			return closed(closingIndex(input, index + 2, "[", "]", dialect), index + 2, (body) => ({
				expansion: { kind: "arithmetic", body },
			}));
		if (!quoted && (char === "<" || char === ">") && next === "(")
			return closed(closingIndex(input, index + 2, "(", ")", dialect), index + 2, (body) => ({
				expansion: { kind: "process", body },
			}));
		return undefined;
	}
	if (char === "$" && next === "(")
		return closed(closingIndex(input, index + 2, "(", ")", dialect), index + 2, (body) => ({
			group: { kind: "subexpression", body },
		}));
	if (char === "$" && next === "{") {
		const end = input.indexOf("}", index + 2);
		return end < 0 ? null : { end };
	}
	if (quoted) return undefined;
	if (char === "@" && (next === "(" || next === "{")) {
		const close = next === "(" ? ")" : "}";
		const kind = next === "(" ? "array" : "hashtable";
		return closed(closingIndex(input, index + 2, next, close, dialect), index + 2, (body) => ({
			group: { kind, body },
		}));
	}
	if (char === "(" || char === "{") {
		const close = char === "(" ? ")" : "}";
		const kind = char === "(" ? "group" : "block";
		return closed(closingIndex(input, index + 1, char, close, dialect), index + 1, (body) => ({
			group: { kind, body },
		}));
	}
	return undefined;
}

/** Whether a redirect token is followed by its target word; `2>&1` and `>&-` duplicate or close a descriptor instead. */
export function redirectTakesTarget(value: string): boolean {
	return !/&(?:\d+|-)$/u.test(value);
}

function tokenize(input: string, options: TokenizeOptions): ShellToken[] | null {
	const posix = options.dialect === "posix";
	const tokens: ShellToken[] = [];
	let current = "";
	let argumentStarted = false;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let expansions: ShellExpansion[] = [];
	let groups: ShellGroup[] = [];
	let literal = false;
	const pushArgument = () => {
		if (argumentStarted || current.length > 0) {
			const token: ShellToken = { kind: "arg", value: current };
			if (expansions.length > 0) token.expansions = expansions;
			if (groups.length > 0) token.groups = groups;
			if (literal) token.literal = true;
			tokens.push(token);
		}
		current = "";
		argumentStarted = false;
		expansions = [];
		groups = [];
		literal = false;
	};
	/** Copies the construct at `index` into the word: the new index, `index` itself when none starts there, -1 when it never closes. */
	const takeConstruct = (index: number): number => {
		const construct = wordConstructAt(input, index, options.dialect, quote !== undefined);
		if (construct === undefined) return index;
		if (construct === null) return -1;
		current += input.slice(index, construct.end + 1);
		if (construct.expansion) expansions.push(construct.expansion);
		if (construct.group) groups.push(construct.group);
		return construct.end;
	};

	for (let index = 0; index < input.length; index++) {
		const char = input[index]!;
		const next = input[index + 1];
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		// A line continuation: the shell removes the escape and the line break, joining the two lines into one word.
		if (char === (posix ? "\\" : "`") && quote !== "'") {
			if (next === "\n") {
				index++;
				continue;
			}
			if (next === "\r" && input[index + 2] === "\n") {
				index += 2;
				continue;
			}
		}
		if (!posix && char === "`" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (posix && char === "\\" && quote !== "'") {
			if (hasWindowsPathPrefix(current)) {
				current += char;
				continue;
			}
			if (current === "" && next === "\\") {
				current = "\\\\";
				index++;
				continue;
			}
			if (quote === '"' && next !== undefined && !'"$`\\'.includes(next)) {
				current += char;
				continue;
			}
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			if (quote === '"') {
				const end = takeConstruct(index);
				if (end < 0) return null;
				if (end !== index) {
					index = end;
					continue;
				}
			}
			current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			if (current === "" && !argumentStarted) literal = true;
			argumentStarted = true;
			quote = char;
			continue;
		}
		// An unquoted `#` that starts a word comments out the rest of the line; the line break still ends the command.
		if (char === "#" && current === "" && !argumentStarted) {
			while (index + 1 < input.length && input[index + 1] !== "\n" && input[index + 1] !== "\r") index++;
			continue;
		}
		if (!posix && char === "<" && next === "#" && current === "" && !argumentStarted) {
			const end = input.indexOf("#>", index + 2);
			if (end < 0) return null;
			index = end + 1;
			continue;
		}
		const constructEnd = takeConstruct(index);
		if (constructEnd < 0) return null;
		if (constructEnd !== index) {
			index = constructEnd;
			continue;
		}

		if (options.operators && posix && char === "&" && next === ">") {
			pushArgument();
			const append = input[index + 2] === ">";
			tokens.push({ kind: "redirect", value: append ? "&>>" : "&>" });
			index += append ? 2 : 1;
			continue;
		}
		if (options.operators && (char === "|" || char === "&" || char === ";" || char === "\n" || char === "\r")) {
			pushArgument();
			if (char === "|" && input[index + 1] === "&") {
				tokens.push({ kind: "pipe", value: "|&" });
				index++;
			} else if ((char === "|" || char === "&") && input[index + 1] === char) {
				tokens.push({ kind: "operator", value: `${char}${char}` });
				index++;
			} else if (char === "|") {
				tokens.push({ kind: "pipe", value: char });
			} else {
				tokens.push({ kind: "operator", value: char });
			}
			continue;
		}

		if (options.operators && (char === ">" || char === "<")) {
			let fileDescriptor = "";
			if (!argumentStarted && (posix ? /^\d+$/u : /^(?:\d+|\*)$/u).test(current)) {
				fileDescriptor = current;
				current = "";
				expansions = [];
				groups = [];
			} else {
				pushArgument();
			}
			let value = `${fileDescriptor}${char}`;
			if (input[index + 1] === char) {
				value += char;
				index++;
				// `<<<` here-string, `<<-` tab-stripping here-document.
				if (posix && char === "<" && (input[index + 1] === "<" || input[index + 1] === "-"))
					value += input[++index];
			} else if (char === "<" && input[index + 1] === ">") {
				value += input[++index];
			} else if (char === ">" && input[index + 1] === "|") {
				value += input[++index];
			}
			if (input[index + 1] === "&" && !value.startsWith("<<")) {
				value += "&";
				index++;
				// `>&2` duplicates a descriptor only when the digits (or `-`) are the whole word; `>&2file` writes the file `2file`.
				const descriptor = /^(?:\d+|-)/u.exec(input.slice(index + 1))?.[0];
				const after = descriptor === undefined ? undefined : input[index + 1 + descriptor.length];
				if (descriptor !== undefined && (after === undefined || WORD_END_RE.test(after))) {
					value += descriptor;
					index += descriptor.length;
				}
			}
			tokens.push({ kind: "redirect", value });
			continue;
		}

		if (/\s/u.test(char)) {
			pushArgument();
			continue;
		}
		current += char;
	}

	if (quote || escaped) return null;
	pushArgument();
	return tokens;
}

/** Tokenize one simple command while preserving the pre-existing quote/escape contract. */
export function tokenizeCommand(
	command: string,
	dialect: ShellCommandDialect = defaultShellCommandDialect(),
): string[] | null {
	return tokenize(command, { operators: false, dialect })?.map((token) => token.value) ?? null;
}

/** Tokenize a shell command and expose quote-aware command boundaries and redirects. */
export function tokenizeShellCommand(
	command: string,
	dialect: ShellCommandDialect = defaultShellCommandDialect(),
): ShellToken[] | null {
	return tokenize(command, { operators: true, dialect });
}

export interface ShellInvocationPrefixResult {
	args: string[];
	prefixes: string[];
	nonExecutingQuery: boolean;
	envExecutable?: string;
}

/** Parse shell environment assignments and supported command/env wrappers from one invocation. */
export function parseShellInvocationPrefixes(args: string[]): ShellInvocationPrefixResult {
	let index = 0;
	let nonExecutingQuery = false;
	let envExecutable: string | undefined;
	while (index < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(args[index] ?? "")) index++;
	if (args[index] === "command") {
		index++;
		while (index < args.length && args[index].startsWith("-")) {
			if (args[index] === "-v" || args[index] === "-V") nonExecutingQuery = true;
			index++;
		}
	}
	if (/(?:^|[\\/])env(?:\.(?:exe|cmd|bat))?$/iu.test(args[index] ?? "")) {
		envExecutable = args[index];
		index++;
		while (index < args.length) {
			const arg = args[index];
			if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg)) {
				index++;
				continue;
			}
			if (arg === "--") {
				index++;
				break;
			}
			if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
				index += 2;
				continue;
			}
			if (arg.startsWith("--unset=") || arg.startsWith("--chdir=") || arg.startsWith("-")) {
				index++;
				continue;
			}
			break;
		}
	}
	return { args: args.slice(index), prefixes: args.slice(0, index), nonExecutingQuery, envExecutable };
}

/** Strip shell environment assignments and the supported command/env wrappers from one invocation. */
export function stripShellInvocationPrefixes(args: string[]): string[] {
	return parseShellInvocationPrefixes(args).args;
}

export interface ParsedCommand {
	envVars: Record<string, string>;
	coreCommandTokens: string[];
}

export function parseCommandPrefixes(
	command: string,
	dialect: ShellCommandDialect = defaultShellCommandDialect(),
): ParsedCommand | null {
	const tokens = tokenizeCommand(command, dialect);
	if (!tokens || tokens.length === 0) return null;

	const envVars: Record<string, string> = {};
	let index = 0;
	const envPattern = /^([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$/u;

	while (index < tokens.length) {
		const match = tokens[index].match(envPattern);
		if (!match) break;
		envVars[match[1]] = match[2];
		index++;
	}

	return { envVars, coreCommandTokens: tokens.slice(index) };
}

export function isComplexShellCommand(command: string): boolean {
	return /[|><&;\n\r$`()*?[\]#]/u.test(command);
}

/**
 * Shell syntax a direct (shell-less) spawn of the same tokens cannot reproduce: expansions,
 * substitutions, globs and comments. Pipes and chains are not listed: a caller that parses the
 * command into a sequence (`parseShellCommandSequence`) decides about those stage by stage.
 */
export function hasShellOnlySyntax(command: string): boolean {
	return /[$`()*?[\]#]/u.test(command);
}

export interface ShellCommandSequence {
	/** One argument vector per simple command, in order. */
	invocations: string[][];
	/** The connector after each invocation (`&&`, `||`, `|`, `;`, newline); one fewer than invocations. */
	connectors: string[];
}

/**
 * Split a command into simple commands and the connectors between them. Redirects and empty stages
 * make the command opaque (undefined): the callers only reason about plain invocation chains.
 */
export interface ParseShellCommandSequenceOptions {
	/**
	 * `reject` (default): any redirection makes the command unparseable, the right answer for code that
	 * would run the stages itself. `drop`: redirections and their targets are removed, the right answer
	 * for code that only reads the output the shell produced (`cargo check 2>&1`, `cmd > log`).
	 */
	redirects?: "reject" | "drop";
}

export function parseShellCommandSequence(
	command: string,
	options?: ParseShellCommandSequenceOptions,
): ShellCommandSequence | undefined {
	const tokens = tokenizeShellCommand(command);
	if (!tokens) return undefined;
	const invocations: string[][] = [];
	const connectors: string[] = [];
	let invocation: string[] = [];
	let dropNextTarget = false;
	for (const token of tokens) {
		if (token.kind === "redirect") {
			if (options?.redirects !== "drop") return undefined;
			// `2>&1` names its target inline; `>`, `>>`, `2>`, `<`, `>&file` take the next word as the target.
			dropNextTarget = redirectTakesTarget(token.value);
			continue;
		}
		if (token.kind === "arg" && dropNextTarget) {
			dropNextTarget = false;
			continue;
		}
		dropNextTarget = false;
		if (token.kind === "arg") {
			invocation.push(token.value);
			continue;
		}
		if (invocation.length === 0) return undefined;
		invocations.push(invocation);
		connectors.push(token.value);
		invocation = [];
	}
	if (invocation.length === 0) return undefined;
	invocations.push(invocation);
	return { invocations, connectors };
}

/** `cd <one path>`: the only stage a filtered run replays into the session before the command. */
export function isChangeDirectoryInvocation(args: string[]): boolean {
	return args[0] === "cd" && args.length === 2 && args[1].length > 0;
}
