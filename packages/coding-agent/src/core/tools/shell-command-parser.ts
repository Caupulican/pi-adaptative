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
