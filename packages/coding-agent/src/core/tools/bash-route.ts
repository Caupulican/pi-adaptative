import { posix } from "node:path";
import { tokenizeShellCommand } from "./shell-command-parser.ts";

/**
 * Where a bash command is served. The default tool surface has no `ls`, `find` or `grep` tool, so a
 * model reads files and directories through the shell; the router recognises the few exact forms the
 * read tool serves with the same meaning, and every other command is the shell's.
 *
 * `routeId` names the form (or, for a shell pass, why it stayed with the shell) and `reason` is a
 * static sentence: neither ever carries the command text, a path or an argument, so both are safe to
 * log. A routed `path` is absolute and, for `read`, names a regular file once the caller has checked.
 */
export type BashRoute =
	| { kind: "shell"; routeId: string; reason: string }
	| {
			kind: "read";
			routeId: string;
			reason: string;
			path: string;
			offset?: number;
			limit?: number;
			tail?: number;
	  }
	| { kind: "list"; routeId: string; reason: string; path: string };

type ShellRoute = Extract<BashRoute, { kind: "shell" }>;

const shell = (routeId: string, reason: string): ShellRoute => ({ kind: "shell", routeId, reason });

/** Characters whose meaning the shell, not the router, decides: escapes, expansions, globs, operators, comments. */
const SHELL_SYNTAX_CHARACTERS = new Set([..."\\$`*?[]{}!#~<>|&;()"]);

function hasShellSyntax(command: string): boolean {
	for (const character of command) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f || SHELL_SYNTAX_CHARACTERS.has(character)) return true;
		// The shell splits words on blanks only; the tokenizer also splits on other Unicode whitespace.
		if (character !== " " && /\s/u.test(character)) return true;
	}
	return false;
}

/**
 * The absolute path a word names from `cwd`, or undefined when the word is anything but a plain path.
 * `..` is refused because the shell resolves it through symbolic links and a lexical resolution would
 * not; a `.` segment and a trailing slash are refused for files for the same reason (`file/.` and
 * `file/` fail in the shell and would succeed here).
 */
function resolveWordPath(word: string, cwd: string, directory: boolean): string | undefined {
	if (word === "" || word.startsWith("-") || !cwd.startsWith("/")) return undefined;
	if (word === ".") return directory ? cwd : undefined;
	const segments = word.split("/");
	for (const [index, segment] of segments.entries()) {
		if (segment === "..") return undefined;
		if (segment === "." && !(index === 0 && segments.length > 1)) return undefined;
	}
	if (!directory && word.endsWith("/")) return undefined;
	return posix.resolve(cwd, word);
}

const POSITIVE_INTEGER = /^[1-9]\d{0,8}$/u;
const SED_RANGE = /^([1-9]\d{0,8}),([1-9]\d{0,8})p$/u;
const LIST_FLAGS = new Set(["-l", "-a", "-la", "-al"]);

function readRoute(
	routeId: string,
	reason: string,
	word: string | undefined,
	cwd: string,
	window: { offset?: number; limit?: number; tail?: number },
): BashRoute {
	const path = word === undefined ? undefined : resolveWordPath(word, cwd, false);
	return path === undefined
		? shell("shell.path", "the path is not a plain file path")
		: { kind: "read", routeId, reason, path, ...window };
}

/**
 * Classify one bash command. Pure: no filesystem, no environment. Only exact simple forms route (no
 * pipe, redirect, substitution, glob, variable, chaining, heredoc, option beyond the listed ones);
 * anything else, or any doubt, is the shell, so routing never changes what a command means. Paths
 * are POSIX-native: a working directory that is not a POSIX absolute path (Windows) is never routed.
 */
export function routeBashCommand(command: string, cwd: string): BashRoute {
	if (hasShellSyntax(command)) return shell("shell.syntax", "the command uses shell syntax the router does not read");
	const tokens = tokenizeShellCommand(command);
	if (!tokens || tokens.length === 0)
		return shell("shell.syntax", "the command did not tokenize as one simple command");
	const words: string[] = [];
	for (const token of tokens) {
		if (token.kind !== "arg" || token.expansions || token.groups) {
			return shell("shell.syntax", "the command is not one plain simple command");
		}
		words.push(token.value);
	}
	const [program, ...args] = words;
	if (program === "cat" && args.length === 1) {
		return readRoute("cat.file", "cat of one file", args[0], cwd, {});
	}
	if (program === "head" && args.length === 3 && args[0] === "-n" && POSITIVE_INTEGER.test(args[1])) {
		return readRoute("head.lines", "head of one file", args[2], cwd, { offset: 1, limit: Number(args[1]) });
	}
	if (program === "head" && args.length === 2 && /^-[1-9]\d{0,8}$/u.test(args[0])) {
		return readRoute("head.lines", "head of one file", args[1], cwd, { offset: 1, limit: Number(args[0].slice(1)) });
	}
	if (program === "tail" && args.length === 3 && args[0] === "-n" && POSITIVE_INTEGER.test(args[1])) {
		return readRoute("tail.lines", "tail of one file", args[2], cwd, { tail: Number(args[1]) });
	}
	const range = program === "sed" && args.length === 3 && args[0] === "-n" ? SED_RANGE.exec(args[1]) : null;
	if (range && Number(range[2]) >= Number(range[1])) {
		const first = Number(range[1]);
		return readRoute("sed.range", "sed line range of one file", args[2], cwd, {
			offset: first,
			limit: Number(range[2]) - first + 1,
		});
	}
	if (program === "ls") {
		const operands = args.length > 0 && LIST_FLAGS.has(args[0]) ? args.slice(1) : args;
		if (operands.length > 1) return shell("shell.form", "ls with more than one operand");
		const path = operands.length === 0 ? cwd : resolveWordPath(operands[0], cwd, true);
		if (path === undefined || !path.startsWith("/"))
			return shell("shell.path", "the path is not a plain directory path");
		return { kind: "list", routeId: "ls.dir", reason: "ls of one directory", path };
	}
	return shell("shell.form", "the command is not one of the routed read forms");
}
