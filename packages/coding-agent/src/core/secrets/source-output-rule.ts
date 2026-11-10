/**
 * Which one program source file does a shell line print whole, from its first line?
 *
 * The scanner's state is known only at a file's first line, so a call that starts elsewhere, reorders or drops lines,
 * or prints more than the file would have its string bodies and comments read as code. Every shape this module cannot
 * prove is that one file whole from its first line answers undefined, and the caller keeps the data rule.
 */

import { redirectTakesTarget, tokenizeShellCommand } from "../tools/shell-command-parser.ts";
import { isProgramSourcePath } from "./program-source-path.ts";

/** The one file a call prints whole, whether its text numbers every line, and the directory a leading `cd` names. */
export interface SourceFileOutput {
	readonly path: string;
	readonly numbered: boolean;
	/** The word of the `cd` that leads the line: the file is named from that directory. */
	readonly directory?: string;
}

const COUNT_RE = /^[+-]?\d+$/u;
/**
 * The only flag `nl` may carry: `-b a` or `-ba`, which numbers every line. A flag that changes the separator (`-s`) or
 * the number's form (`-n`, `-w`) writes a prefix the mask does not know, and the text behind it is then not read from
 * the line's own start.
 */
const NL_ALL_LINES_RE = /^-b(a)?$/u;
/** `sed` prints the file from its first line only when the script starts at line 1 and ends at a line or the end. */
const SED_FROM_FIRST_LINE_RE = /^1,(?:\d+|\$)p$/u;

/** Only a bare command name is a known printer: `./cat` and `bin/sed` are whatever file sits there. */
function programName(word: string): string {
	return word.includes("/") ? "" : word.toLowerCase();
}

/** A glob names no single file: the shell would expand it to as many as match. */
const GLOB_RE = /[*?[{]/u;

/** A word that names one source file: no flag, no glob, no expansion, and a dialect for its extension. */
function namedFile(word: string | undefined): string | undefined {
	if (word === undefined || word.startsWith("-") || GLOB_RE.test(word)) return undefined;
	return isProgramSourcePath(word) ? word : undefined;
}

/** How many words `head`'s count takes: none, one for `-N`, two for `-n N` or `-c N`. */
function headCount(args: readonly string[]): number | undefined {
	const [first, second] = args;
	if (first === undefined) return 0;
	if (/^-\d+$/u.test(first)) return 1;
	if ((first === "-n" || first === "-c") && COUNT_RE.test(second ?? "")) return 2;
	return undefined;
}

/** The words after `nl`'s flag, or undefined when a word is a flag that changes the prefix `nl` writes. */
function nlOperands(args: readonly string[]): string[] | undefined {
	const [first, second] = args;
	if (first === undefined || !first.startsWith("-")) return [...args];
	const flag = NL_ALL_LINES_RE.exec(first);
	if (flag === null) return undefined;
	// `-ba` is whole; `-b` takes its style as the next word, and only `a` keeps every line numbered the known way.
	if (flag[1] === "a") return args.slice(1);
	return second === "a" ? args.slice(2) : undefined;
}

/** `cat`, `cat -n` or `cat -b`: the file after the flag, and whether the stage numbers the lines. */
function catWords(args: readonly string[]): { rest: readonly string[]; numbered: boolean } | undefined {
	const numbered = args[0] === "-n" || args[0] === "-b";
	const rest = numbered ? args.slice(1) : args;
	return rest.some((arg) => arg.startsWith("-")) ? undefined : { rest, numbered };
}

/** The first stage: one of the printers that starts at the file's first line, over exactly one named file. */
function printerOutput(words: readonly string[]): SourceFileOutput | undefined {
	const [program, ...args] = words;
	const name = programName(program ?? "");
	if (name === "cat") {
		const cat = catWords(args);
		const file = cat !== undefined && cat.rest.length === 1 ? namedFile(cat.rest[0]) : undefined;
		return file === undefined ? undefined : { path: file, numbered: cat!.numbered };
	}
	if (name === "head") {
		const count = headCount(args);
		const rest = count === undefined ? [] : args.slice(count);
		const file = count !== undefined && rest.length === 1 ? namedFile(rest[0]) : undefined;
		return file === undefined ? undefined : { path: file, numbered: false };
	}
	if (name === "nl") {
		const rest = nlOperands(args);
		const file = rest !== undefined && rest.length === 1 ? namedFile(rest[0]) : undefined;
		return file === undefined ? undefined : { path: file, numbered: true };
	}
	if (name === "sed") {
		const quiet = args[0] === "-n" || args[0] === "--quiet" || args[0] === "--silent";
		const script = args[1];
		const file = args.length === 3 && quiet && script !== undefined ? namedFile(args[2]) : undefined;
		if (file === undefined || script === undefined || !SED_FROM_FIRST_LINE_RE.test(script)) return undefined;
		return { path: file, numbered: false };
	}
	return undefined;
}

/** A later stage: it reads the pipe only, keeps its beginning, and says whether it numbers the lines. */
function laterStageNumbered(words: readonly string[]): boolean | undefined {
	const [program, ...args] = words;
	const name = programName(program ?? "");
	if (name === "head") {
		const count = headCount(args);
		return count !== undefined && count === args.length ? false : undefined;
	}
	if (name === "nl") {
		const rest = nlOperands(args);
		return rest !== undefined && rest.length === 0 ? true : undefined;
	}
	if (name === "cat") {
		const cat = catWords(args);
		return cat !== undefined && cat.rest.length === 0 && cat.numbered ? true : undefined;
	}
	return undefined;
}

/** One command of a line: its words, and whether a pipe or a separator came before it. */
interface Segment {
	readonly words: readonly string[];
	readonly after: "pipe" | "separator";
}

/** The segments of a line, or undefined on a word with an expansion, a substitution, or any other operator. */
function segmentsOf(command: string): Segment[] | undefined {
	const tokens = tokenizeShellCommand(command, "posix", { compound: true });
	if (!tokens) return undefined;
	const segments: Segment[] = [];
	let words: string[] = [];
	let after: "pipe" | "separator" = "separator";
	let target: "dev-null" | undefined;
	for (const token of tokens) {
		if (token.kind === "arg") {
			if (token.expansions?.length || token.groups?.length) return undefined;
			if (target) {
				if (token.value !== "/dev/null") return undefined;
				target = undefined;
			} else words.push(token.value);
			continue;
		}
		if (token.kind === "redirect") {
			if (target) return undefined;
			if (token.value === "2>") target = "dev-null";
			else if (redirectTakesTarget(token.value) || token.value !== "2>&1") return undefined;
			continue;
		}
		if (target || words.length === 0) return undefined;
		if (token.kind === "pipe") {
			if (token.value !== "|") return undefined;
		} else if (token.value !== ";" && token.value !== "&&" && token.value !== "\n") return undefined;
		segments.push({ words, after });
		words = [];
		after = token.kind === "pipe" ? "pipe" : "separator";
	}
	if (target || words.length === 0) return undefined;
	segments.push({ words, after });
	return segments;
}

/** A shell line: an optional `cd` to one literal directory, then one pipeline that starts at a file's first line. */
export function sourceFileOfShellLine(command: string): SourceFileOutput | undefined {
	const segments = segmentsOf(command);
	if (segments === undefined) return undefined;
	const [first] = segments;
	// `cd <one word>` prints nothing; it may lead the line and nothing else may come before the pipeline.
	const changesDirectory =
		segments.length > 1 && first !== undefined && first.words[0] === "cd" && first.words.length === 2;
	const pipeline = segments.slice(changesDirectory ? 1 : 0);
	const [printer, ...stages] = pipeline;
	if (printer === undefined || printer.words.length === 0) return undefined;
	// Every boundary inside the pipeline is a pipe: a second command would print more than the file.
	if (pipeline.some((segment, index) => index > 0 && segment.after !== "pipe")) return undefined;
	const output = printerOutput(printer.words);
	if (output === undefined) return undefined;
	let numberings = output.numbered ? 1 : 0;
	for (const stage of stages) {
		const numbered = laterStageNumbered(stage.words);
		if (numbered === undefined) return undefined;
		if (numbered) numberings += 1;
	}
	// Two numbering stages would number the numbers.
	if (numberings > 1) return undefined;
	const directory = changesDirectory ? first?.words[1] : undefined;
	return { path: output.path, numbered: numberings === 1, ...(directory === undefined ? {} : { directory }) };
}
