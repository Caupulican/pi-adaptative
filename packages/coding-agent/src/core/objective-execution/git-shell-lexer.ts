/**
 * Quote-aware split of a shell command into simple segments.
 * This is not a shell. Unterminated quotes and substitutions fail closed.
 */

export type ShellLex =
	| { readonly ok: true; readonly segments: readonly (readonly string[])[] }
	| { readonly ok: false; readonly reason: "unterminated_quote" | "command_substitution" };

export function isGitExecutableToken(token: string): boolean {
	const base = token.replace(/^.*[\\/]/u, "").toLowerCase();
	return base === "git" || base === "git.exe";
}

export function lexShellCommand(command: string): ShellLex {
	const segments: string[][] = [];
	let tokens: string[] = [];
	let current = "";
	let quoting: "'" | '"' | undefined;
	const pushToken = (): void => {
		if (current.length > 0) tokens.push(current);
		current = "";
	};
	const pushSegment = (): void => {
		pushToken();
		if (tokens.length > 0) segments.push(tokens);
		tokens = [];
	};
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index] ?? "";
		if (quoting === "'") {
			if (char === "'") quoting = undefined;
			else current += char;
			continue;
		}
		if (quoting === '"') {
			if (char === "\\") {
				const next = command[index + 1];
				if (next === undefined) return { ok: false, reason: "unterminated_quote" };
				current += next;
				index += 1;
				continue;
			}
			if (char === '"') quoting = undefined;
			else if (char === "`" || (char === "$" && command[index + 1] === "(")) {
				return { ok: false, reason: "command_substitution" };
			} else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quoting = char;
			continue;
		}
		if (char === "\\") {
			const next = command[index + 1];
			if (next === undefined) return { ok: false, reason: "unterminated_quote" };
			current += next;
			index += 1;
			continue;
		}
		if (char === "`" || (char === "$" && command[index + 1] === "(")) {
			return { ok: false, reason: "command_substitution" };
		}
		if (char === "&") {
			const next = command[index + 1] ?? "";
			const prev = command[index - 1] ?? "";
			if (next === "&") {
				pushSegment();
				index += 1;
				continue;
			}
			if (next === ">" || prev === ">") {
				current += char;
				continue;
			}
			pushSegment();
			continue;
		}
		if (char === "|" && command[index + 1] === "|") {
			pushSegment();
			index += 1;
			continue;
		}
		if (char === "|" || char === ";" || char === "\n" || char === "\r") {
			pushSegment();
			continue;
		}
		if (char === " " || char === "\t") {
			pushToken();
			continue;
		}
		current += char;
	}
	if (quoting) return { ok: false, reason: "unterminated_quote" };
	pushSegment();
	return { ok: true, segments };
}
