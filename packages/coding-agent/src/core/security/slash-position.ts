/**
 * Decides, for javascript and typescript code, whether a `/` opens a regular expression or divides: the one place where
 * the source scanner must know what kind of token came before. It reads code characters only; the scanner tells it when
 * a literal ends and when a template's expression opens.
 *
 * Known limits, each named with the side it errs on: a `}` is taken for the end of a block, so a `/` directly after an
 * object literal or a function expression is read as the start of a regular expression; a property name written on the
 * line after its dot is read as a keyword when it is spelled like one; `of` used as a variable's name is read as the
 * keyword; a `[...]` class in a regular expression is read without the nesting the `v` flag adds.
 */

/** What a `/` meets: it divides after a value and opens a regular expression after anything else. */
export type SlashState = {
	readonly last?: "value" | "operator";
	/** How many `(` are open. */
	readonly parens: number;
	/** The paren depth of each open condition head (`if (`, `while (`, `for (`, `with (`), outermost first. */
	readonly heads: readonly number[];
};

export const SLASH_START: SlashState = { parens: 0, heads: [] };

export interface SlashReader {
	/** Reads the code character at `index` and returns how many characters it took (2 for a postfix `++` or `--`). */
	read(line: string, index: number): number;
	/** A string, a template or a regular expression ended here: a value. */
	endLiteral(): void;
	/** A template's `${` opened: an expression starts. */
	openExpression(): void;
	/** Does a `/` at this point open a regular expression? */
	opensRegex(): boolean;
	/** What the next line starts from: plain data, comparable with JSON.stringify. */
	state(): SlashState;
}

/** Words after which an expression is expected, so a `/` behind one opens a regular expression (rule 2). */
const EXPRESSION_WORDS = new Set(
	"return typeof case in of delete void throw yield await else do instanceof new default extends".split(" "),
);
/** Words that open a condition head, whose closing `)` is followed by a statement (rule 4). */
const HEAD_WORDS = new Set("if while for with".split(" "));
/** The most open heads a reader remembers: past this the state stops growing with the text. */
const HEAD_LIMIT = 32;
/** A name character: an ASCII letter, a digit, `_` or `$`; any character above U+007F is one too (rule 2). */
const NAME_CHAR_RE = /[\w$]/u;
const DIGIT_RE = /[0-9]/u;
const SPACE_RE = /\s/u;

/** One word that ended and whether it is a property name: the reader keeps the last two of them (rule 4). */
type PendingWord = { readonly text: string; readonly property: boolean };

function isNameChar(char: string | undefined): boolean {
	return char !== undefined && (NAME_CHAR_RE.test(char) || char > "\u007f");
}

/** Is the word starting at `index` a property name: after a `#`, or after a `.` that no spread `...` ends? (rule 2) */
function isPropertyStart(line: string, index: number): boolean {
	const before = line[index - 1];
	return before === "#" || (before === "." && line[index - 2] !== ".");
}

/** Does the code before a `(` name a condition head? `words` holds the newest last, each with its property flag. */
function opensHead(words: readonly PendingWord[]): boolean {
	const newest = words.at(-1);
	if (newest === undefined) return false;
	if (!newest.property && HEAD_WORDS.has(newest.text)) return true;
	// `for await (` is one head: the two words before the `(` are `for` and `await`.
	return newest.text === "await" && words.at(-2)?.text === "for";
}

/** A reader that starts from `start`, follows the code characters of one line, and says what a `/` meets. */
export function createSlashReader(start: SlashState | undefined): SlashReader {
	const from = start ?? SLASH_START;
	let last = from.last;
	/** Whether the value `last` speaks of ended on this line: a postfix binds only within the line of its value. */
	let endedHere = false;
	let parens = from.parens;
	const heads = [...from.heads];
	let word = "";
	let wordIsProperty = false;
	/** The last two words that ended, oldest first: kept while only spaces and comments follow them (rule 1). */
	let words: readonly PendingWord[] = [];

	/** Records what a `/` meets; only a value that ended on this line takes a postfix operator (rules 7 and 8). */
	const end = (kind: "value" | "operator"): void => {
		last = kind;
		endedHere = kind === "value";
	};
	/** Ends the word being read, which becomes the newest pending word (rules 1 and 2). */
	const endWord = (): void => {
		if (word === "") return;
		words = [...words, { text: word, property: wordIsProperty }].slice(-2);
		word = "";
		wordIsProperty = false;
	};
	/** Forgets what a token ends: the word being read and the pending words a rule has just been read with. */
	const forgetWords = (): void => {
		endWord();
		words = [];
	};
	/** A postfix operator binds only to a value that ended on the line it is written on (rules 7 and 8). */
	const bindsHere = (): boolean => last === "value" && endedHere;

	const read = (line: string, index: number): number => {
		const char = line[index] ?? "";
		// Rule 1: whitespace ends the word being read and keeps the pending words.
		if (SPACE_RE.test(char)) {
			endWord();
			return 1;
		}
		// Rule 2: a name character grows the word being read, which is a property name or not at its first character.
		if (isNameChar(char)) {
			if (word === "") wordIsProperty = isPropertyStart(line, index);
			word += char;
			if (wordIsProperty || !EXPRESSION_WORDS.has(word)) end("value");
			else end("operator");
			return 1;
		}
		// Rule 3: a `.` written directly after a number goes on with it.
		if (char === "." && DIGIT_RE.test(word[0] ?? "")) {
			word += char;
			end("value");
			return 1;
		}
		// Rules 4 to 9: the token ends the word being read, and rules 4 and 5 read the pending words before forgetting them.
		endWord();
		const before = words;
		words = [];
		if (char === "(") {
			parens += 1;
			if (opensHead(before) && heads.length < HEAD_LIMIT) heads.push(parens);
			end("operator");
			return 1;
		}
		if (char === ")") {
			// The `)` of a head is followed by a statement, so a `/` behind it opens a regular expression.
			if (heads.at(-1) === parens) {
				heads.pop();
				end("operator");
			} else end("value");
			parens = Math.max(parens - 1, 0);
			return 1;
		}
		if (char === "]") {
			end("value");
			return 1;
		}
		// Rule 7: a postfix `++` or `--` takes both characters; rule 8: a typescript postfix `!` takes one.
		if ((char === "+" || char === "-") && line[index + 1] === char && bindsHere()) return 2;
		if (char === "!" && line[index + 1] !== "=" && bindsHere()) return 1;
		// Rule 9: an operator, an opening bracket, or a dot that no number keeps.
		end("operator");
		return 1;
	};

	return {
		read,
		endLiteral: () => {
			end("value");
			forgetWords();
		},
		openExpression: () => {
			end("operator");
			forgetWords();
		},
		opensRegex: () => last !== "value",
		state: () => ({ ...(last === undefined ? {} : { last }), parens, heads: [...heads] }),
	};
}
