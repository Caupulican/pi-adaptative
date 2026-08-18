import { homedir } from "node:os";
import { join } from "node:path";

export type ShellTokenKind = "arg" | "operator" | "pipe" | "redirect";

export interface ShellToken {
	kind: ShellTokenKind;
	value: string;
}

interface TokenizeOptions {
	operators: boolean;
	dialect: ShellCommandDialect;
}

export type ShellCommandDialect = "posix" | "powershell";

function defaultShellCommandDialect(): ShellCommandDialect {
	// Pi exposes Bash-like source on every platform. Native PowerShell callers opt in explicitly.
	return "posix";
}

function hasWindowsPathPrefix(value: string): boolean {
	return /^[A-Za-z]:/u.test(value) || value.startsWith("\\\\");
}

function pushArgument(tokens: ShellToken[], current: string): string {
	if (current.length > 0) tokens.push({ kind: "arg", value: current });
	return "";
}

function tokenize(input: string, options: TokenizeOptions): ShellToken[] | null {
	const tokens: ShellToken[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		const next = input[index + 1];
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (options.dialect === "powershell" && char === "`" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (options.dialect === "posix" && char === "\\" && quote !== "'") {
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
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (options.operators && (char === "|" || char === "&" || char === ";" || char === "\n" || char === "\r")) {
			current = pushArgument(tokens, current);
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
			if (char === ">" && /^\d+$/u.test(current)) {
				fileDescriptor = current;
				current = "";
			} else {
				current = pushArgument(tokens, current);
			}
			let value = `${fileDescriptor}${char}`;
			if (input[index + 1] === char) {
				value += char;
				index++;
			}
			if (input[index + 1] === "&") {
				value += "&";
				index++;
				while (index + 1 < input.length && /[\d-]/u.test(input[index + 1])) {
					value += input[++index];
				}
			}
			tokens.push({ kind: "redirect", value });
			continue;
		}

		if (/\s/u.test(char)) {
			current = pushArgument(tokens, current);
			continue;
		}
		current += char;
	}

	if (quote || escaped) return null;
	pushArgument(tokens, current);
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

const FLAG_VALUE_RE = /^--?[^=\s]+=(.+)$/su;
const SHORT_FLAG_BODY_RE = /^-(?!-)([A-Za-z].*)$/su;
const EMBEDDED_TRAVERSAL_RE = /(^|[\\/])\.\.($|[\\/])/u;
const DESCRIPTOR_REDIRECT_RE = /&[\d-]*$/u;
const STRING_ESCAPE_RE = /\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gsu;
const SIMPLE_ESCAPE_VALUES = new Map<string, string>([
	["\\", "\\"],
	["'", "'"],
	['"', '"'],
	["n", "\n"],
	["t", "\t"],
]);
const MAX_CODE_POINT = 0x10ffff;

function isPathShapedToken(value: string): boolean {
	if (value.startsWith("-")) return false;
	if (value.includes("://")) return false;
	if (value === "." || value === "..") return true;
	if (value === "~" || value.startsWith("~/")) return true;
	if (hasWindowsPathPrefix(value)) return true;
	return /[\\/]/u.test(value);
}

function expandHomePrefix(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

/**
 * Value carried inline by a single-dash short flag (`-I/etc/include`, `-o/tmp/out`). Which
 * letters take an attached value is per-tool knowledge no static reader has, so every split of
 * the leading letter run is tested and the shortest flag prefix whose remainder is path-shaped
 * wins — `-Isrc/lib` projects `src/lib`, not `/lib`. A clustered flag (`-la`) leaves no
 * path-shaped remainder at any split and projects nothing, as does a flag whose value is a
 * separate following token (`-o /tmp/out`, projected from that token instead). A double dash
 * without `=` is a long flag, never a flag-value form.
 */
function projectAttachedShortFlagValue(value: string): string | undefined {
	const body = value.match(SHORT_FLAG_BODY_RE)?.[1];
	if (body === undefined) return undefined;
	for (let index = 1; index <= body.length && /^[A-Za-z]+$/u.test(body.slice(0, index)); index++) {
		const candidate = body.slice(index);
		if (isPathShapedToken(candidate)) return expandHomePrefix(candidate);
	}
	return undefined;
}

/**
 * Project one already-isolated argument (an argv element, or a token the shell tokenizer
 * produced) as a filesystem operand: the expanded path when the value — or its long-flag `=`
 * value, or a short flag's attached value — is path-shaped, undefined otherwise. Path-shaped
 * means dot or home anchored, Windows-prefixed, or bearing a path separator — except flags
 * (leading `-`) and URL-like values (`://`). Bare single-segment words stay unprojected; a false
 * projection can only fail closed, and only when the resolved path leaves the granted scope.
 */
export function projectPathShapedArgument(value: string): string | undefined {
	const flagValue = value.match(FLAG_VALUE_RE)?.[1];
	if (flagValue !== undefined) {
		return isPathShapedToken(flagValue) ? expandHomePrefix(flagValue) : undefined;
	}
	if (isPathShapedToken(value)) return expandHomePrefix(value);
	return projectAttachedShortFlagValue(value);
}

/**
 * Decode the escape sequences a source literal carries so the shape test reads the string the
 * interpreter will actually open: `'\x2fetc\x2fpasswd'` is /etc/passwd, and `'/etc/pas\'swd'`
 * carries no backslash. An unrecognized or truncated sequence stays literal text and is still
 * shape-tested, so an undecodable literal can never drop out of the projection.
 */
function decodeStringLiteralEscapes(literal: string): string {
	return literal.replace(STRING_ESCAPE_RE, (match, sequence: string) => {
		const simple = SIMPLE_ESCAPE_VALUES.get(sequence);
		if (simple !== undefined) return simple;
		if (sequence.startsWith("x") || sequence.startsWith("u")) {
			const digits = sequence.startsWith("u{") ? sequence.slice(2, -1) : sequence.slice(1);
			const codePoint = Number.parseInt(digits, 16);
			if (Number.isInteger(codePoint) && codePoint <= MAX_CODE_POINT) return String.fromCodePoint(codePoint);
		}
		return match;
	});
}

/**
 * Bounded static scan of an interpreter code payload (not shell): quoted string literals are
 * escape-decoded first — an encoded separator (`'\x2fetc\x2fpasswd'`) must not hide the shape —
 * and those that are absolute, home-anchored (~ expanded), Windows-prefixed, or embed
 * parent-directory traversal project as filesystem operands. Plain relative literals stay
 * unprojected — interpreter code is dominated by non-path strings — and computed paths (concatenation,
 * f-strings, os.path.join) cannot be resolved statically; the risk gate owns those.
 */
export function extractCodeStaticPaths(code: string): string[] {
	const paths: string[] = [];
	for (const match of code.matchAll(/(['"])((?:\\.|(?!\1).)*?)\1/gsu)) {
		const value = decodeStringLiteralEscapes(match[2]);
		if (!value || value.includes("://")) continue;
		if (
			value.startsWith("/") ||
			value === "~" ||
			value.startsWith("~/") ||
			hasWindowsPathPrefix(value) ||
			EMBEDDED_TRAVERSAL_RE.test(value)
		) {
			paths.push(expandHomePrefix(value));
		}
	}
	return [...new Set(paths)];
}

/**
 * Statically recognizable filesystem operands of one shell command: every path-shaped token per
 * {@link projectPathShapedArgument} (long-flag `=` values included) plus file redirect targets.
 * Separator-bearing relative words project even when they may not be paths (sed patterns, git
 * refs): resolution against a granted scope makes a false projection fail closed only when it
 * leaves that scope. Bare single-segment words stay unprojected, and dynamic constructs
 * (variables, substitutions, globs) cannot be resolved statically; the risk gate owns those. A
 * command the tokenizer cannot parse projects nothing.
 */
export function extractShellCommandPaths(
	command: string,
	dialect: ShellCommandDialect = defaultShellCommandDialect(),
): string[] {
	const tokens = tokenizeShellCommand(command, dialect);
	if (!tokens) return [];
	const paths: string[] = [];
	let expectRedirectTarget = false;
	for (const token of tokens) {
		if (token.kind === "redirect") {
			// Heredoc openers (<<) and descriptor duplications (>&1, 2>&-) take no file operand.
			expectRedirectTarget = !token.value.includes("<<") && !DESCRIPTOR_REDIRECT_RE.test(token.value);
			continue;
		}
		if (token.kind !== "arg") {
			expectRedirectTarget = false;
			continue;
		}
		if (expectRedirectTarget) {
			expectRedirectTarget = false;
			if (!token.value.startsWith("$")) paths.push(expandHomePrefix(token.value));
			continue;
		}
		const projected = projectPathShapedArgument(token.value);
		if (projected !== undefined) paths.push(projected);
	}
	return [...new Set(paths)];
}
