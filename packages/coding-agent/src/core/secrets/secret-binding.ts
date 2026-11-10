/**
 * Finds the secret-named bindings of one line of program source and, inside the value expression each one marks, the
 * string literals that stand in value position, so that the source mask can replace exactly those (rules 2 to 5 of the
 * name rule). It reads the code stretches the scanner reports; the text of a literal or a comment never decides
 * anything here.
 *
 * Value position (rule 3). A value expression is read as arms, split at its own bracket depth by a fallback or a branch
 * (`??`, `||`, `&&`, `?`, `:`), a concatenation (`+`) and, for a tuple, a comma. A literal is the value when it is a
 * whole arm (`"x"`, `<T>"x"`, `"x".into()`, `"x" as T`) or the only argument of a conversion or a constructor that is
 * a whole arm (`String::from("x")`, `new Secret("x")`). A literal that is compared, indexed with, passed to a call on a
 * receiver, one argument of several, an element of a list or a member of an object is not the value: it names or
 * selects something. The source mask gives the line of such a literal the data rule of a line, so nothing here has to
 * guess that a literal is harmless.
 */

import type { SourceDialect, SourceStretch } from "../security/source-scanner.ts";
import { isCredentialSecretKey } from "./credential-content-mock.ts";

/**
 * A separator that assigns, never a comparison, an arrow or the `::` of a path; the number rule of the source mask asks
 * it too (rule 1).
 */
export const SEPARATOR = "(?<![=!<>:])(?:\\?\\?=|\\|\\|=|&&=|\\+=|:=|[:=])(?![=!<>:])";
/** The same separator, matched where it stands, so a head is the text of the line before it (rule 1). */
const SEPARATOR_RE = new RegExp(SEPARATOR, "uy");
const SPACE_RE = /\s/u;
/** What may stand before a literal that is a whole arm: nothing, or a cast written before the value (rule 3). */
const ARM_PREFIX_RE = /^\s*(?:<[^<>=]*>\s*)?$/u;
/**
 * The callee of a call that is a whole arm and takes the value as its only argument: a conversion or a constructor, as
 * `String("x")`, `new Secret("x")`, `String::from("x")`, `[]byte("x")`. A call on a receiver (`store.get("x")`,
 * `list.join("x")`) looks a value up or shapes one: its argument names something and is not the value (rule 3).
 */
const CALLEE_RE = /^\s*(?:(?:new|await)\s+)?(?:\[\])?[A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)*(?:<[^<>]*>)?\s*$/u;
/** The closing delimiter of the literal a text starts behind: quotes, and the `#` run of a raw string (rule 3). */
const CLOSING_DELIMITER_RE = /^["'`]+#*/u;
/** What may follow a value before its arm ends: conversions that take no argument, a cast, a non-null mark (rule 3). */
const SUFFIX = String.raw`(?:(?:\.|::)\s*[A-Za-z_$][\w$]*\s*\(\s*\)|\s+as\s+[A-Za-z_$][\w$.]*(?:<[^<>]*>)?(?:\[\])?|!(?!=))*`;
/** Where an arm ends: the line, an arm operator, the end of the value, a closing bracket or a comment (rule 3). */
const ARM_END = String.raw`\s*(?:$|\?\?|\|\||&&|[?:+,;)\]}]|\/\/|\/\*|#)`;
/** After a literal that is a whole arm (rule 3). */
const ARM_END_RE = new RegExp(`^${SUFFIX}${ARM_END}`, "u");
/** After a literal that is the only argument of a call that is a whole arm (rule 3). */
const CALL_END_RE = new RegExp(String.raw`^${SUFFIX}\s*\)${SUFFIX}${ARM_END}`, "u");
/** The mark an arm keeps of something already read in it, so that what follows is not a whole arm (rule 3). */
const READ = "\u0001";
/** A line that goes on with a value starts with an arm operator (rule 2). */
const LEADING_ARM_OPERATOR_RE = /^\s*(?:\?\?(?!=)|\|\|(?!=)|&&(?!=)|\?(?!\.)|:(?![:=])|\+(?![+=]))/u;
/** A dotted name of a tuple's left side: `user`, `db.password` (rule 4). */
const TUPLE_NAME_RE = /^[A-Za-z_$][\w$]*(?:\.[\w$]*)*$/u;
/** A statement that defines a type: its literals are type members, not values (rule 5). */
const TYPE_ALIAS_RE = /^\s*(?:export\s+|declare\s+)*type\s+[A-Za-z_$][\w$]*/u;
/** One whole quoted literal of a type union (rule 5). */
const TYPE_LITERAL = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')`;
/** Whole literals with a single `|` between them: a union of literal types, never a value with `||` (rule 5). */
const TYPE_UNION_RE = new RegExp(String.raw`^\s*${TYPE_LITERAL}(?:\s*\|\s*${TYPE_LITERAL})+`, "u");
/** Between a quoted property name and the separator that follows it (rule 1). */
const QUOTED_KEY_RE = /["']([^"'\n]+)["'][ \t]*$/u;

/** One name form: its part before the separator the caller found, after a word boundary (rule 1). */
function nameForm(before: string): RegExp {
	return new RegExp(`(?:^|[^\\w$])${before}\\s*$`, "u");
}

/** A type annotation before an assignment: `const password: string = ` (rule 1). */
const TYPE_ANNOTATION_RE = nameForm(String.raw`([A-Za-z_$][\w$]*)[?!]?\s*:\s*[^=;,(){}]*`);
/** An array declarator: `char password[] = `, `password[32] = ` (rule 1). */
const ARRAY_DECLARATOR_RE = nameForm(String.raw`([A-Za-z_$][\w$]*)\s*\[[^\]\n]*\]`);
/** A Go declaration: `var password string = `, `const token string = ` (rule 1). */
const GO_DECLARATION_RE = nameForm(String.raw`(?:var|const)\s+([A-Za-z_$][\w$]*)\s+[^=;,(){}]*`);
/** A name in brackets: `process.env["API_KEY"] = `, `{ ["password"]: ` (rule 1). The bracket needs no guard. */
const BRACKET_NAME_RE = /\[\s*["']([^"'\n]+)["']\s*\]\s*$/u;
/** A name directly before the separator, the last segment of a member path included (rule 1). */
const PLAIN_ASSIGNMENT_RE = nameForm(String.raw`([A-Za-z_$][\w$]*)`);
/** The name forms, tried in this order for one separator (rule 1). */
const NAME_FORMS = [TYPE_ANNOTATION_RE, ARRAY_DECLARATOR_RE, GO_DECLARATION_RE, BRACKET_NAME_RE, PLAIN_ASSIGNMENT_RE];

/** A value expression open at the end of a line. */
type OpenValue = {
	readonly name: string;
	/** The bracket depth the value started at: a `,`, a `;` or a closing bracket at it ends the value (rule 2). */
	readonly base: number;
	/** A tuple's right-hand side: its commas separate its values, so they do not end it (rule 4). */
	readonly tuple: boolean;
	/** A union of literal types: its literals are type members and get no replacement (rule 5). */
	readonly type: boolean;
};

/** What the next line starts from: plain immutable data, comparable with JSON.stringify. */
export type BindingState = {
	/** The value expression still open at the end of the last line, with the brackets it has open. */
	readonly open?: {
		readonly name: string;
		readonly inside: number;
		readonly tuple: boolean;
		readonly type: boolean;
		/** Nothing of the current arm was read yet, so a literal that starts the next line starts the arm (rule 3). */
		readonly armStart: boolean;
	};
	/** A binding whose separator ended its line: its value starts at the next line's first token (rule 2). */
	readonly waiting?: { readonly name: string; readonly tuple: boolean };
	/**
	 * A value whose line ended at its own depth without a `;` or a `,`: it goes on only when the next line starts with an
	 * arm operator, the way a long branch or fallback is written with the operator first (rule 2).
	 */
	readonly resume?: { readonly name: string; readonly tuple: boolean };
};

export const BINDING_START: BindingState = {};

/**
 * Answers, for each stretch of one line, the secret name whose value expression its string content lies in, and the
 * state the next line starts from (rules 2 to 5). A stretch with no name keeps the data rule.
 */
export function readSecretBindings(
	line: string,
	stretches: readonly SourceStretch[],
	start: BindingState,
	dialect: SourceDialect,
): { readonly names: readonly (string | undefined)[]; readonly state: BindingState } {
	const names: (string | undefined)[] = stretches.map(() => undefined);
	// A type declaration defines a type: its literals are type members and stay as written (rule 5).
	if (TYPE_ALIAS_RE.test(line)) return { names, state: BINDING_START };
	let waiting = start.waiting;
	let open: OpenValue | undefined = start.open === undefined ? undefined : { ...start.open, base: 0 };
	// A value that ended its line at its own depth goes on when this line starts with an arm operator (rule 2).
	if (start.resume !== undefined && LEADING_ARM_OPERATOR_RE.test(line))
		open = { name: start.resume.name, base: 0, tuple: start.resume.tuple, type: false };
	let depth = start.open?.inside ?? 0;
	/** Whether a token of the value has been read: a line that ends right after its separator waits for the next. */
	let started = open !== undefined;
	/** The code of the current arm, read at the value's own depth since the last arm boundary (rule 3). */
	let arm = start.open?.armStart === true ? "" : READ;
	/** The call that is the whole arm so far, with what was read between its `(` and here (rule 3). */
	let call: { inner: string } | undefined;
	/** The value's first token opens a binding that the last line's separator left waiting (rule 2). */
	const startWaiting = (): void => {
		if (waiting === undefined || open !== undefined) return;
		open = { name: waiting.name, base: depth, tuple: waiting.tuple, type: false };
		waiting = undefined;
		started = false;
		arm = "";
		call = undefined;
	};
	const startArm = (): void => {
		arm = "";
		call = undefined;
	};

	for (let position = 0; position < stretches.length; position += 1) {
		const stretch = stretches[position];
		if (stretch.kind === "comment") continue;
		if (stretch.kind === "string") {
			startWaiting();
			if (open === undefined) continue;
			const inside = depth - open.base;
			const after = line.slice(stretch.end).replace(CLOSING_DELIMITER_RE, "");
			// The literal's own opening delimiter (`"`, `b"`, `r#"`) is code to the scanner: it is no part of what stands before.
			const delimiter = line.slice(stretch.delimiterStart ?? stretch.start, stretch.start);
			const wholeArm = inside === 0 && ARM_PREFIX_RE.test(withoutEnd(arm, delimiter)) && ARM_END_RE.test(after);
			const onlyArgument =
				inside === 1 &&
				call !== undefined &&
				withoutEnd(call.inner, delimiter).trim() === "" &&
				CALL_END_RE.test(after);
			if (!open.type && (wholeArm || onlyArgument)) names[position] = open.name;
			if (inside === 0) arm += READ;
			else if (call !== undefined) call.inner += READ;
			started = true;
			continue;
		}
		const text = line.slice(stretch.start, stretch.end);
		for (let offset = 0; offset < text.length; offset += 1) {
			const char = text[offset] ?? "";
			if (SPACE_RE.test(char)) {
				if (open !== undefined && depth === open.base) arm += char;
				continue;
			}
			const at = stretch.start + offset;
			startWaiting();
			SEPARATOR_RE.lastIndex = at;
			const separator = SEPARATOR_RE.exec(line);
			if (separator !== null) {
				const binding = secretBindingAt(line.slice(0, at), dialect, line.slice(at + separator[0].length));
				if (binding !== undefined) {
					open = { ...binding, base: depth };
					started = false;
					startArm();
				} else if (open !== undefined) {
					started = true;
					// A separator that binds nothing here is a branch's `:` or an inner assignment: an arm starts behind it.
					if (depth === open.base) startArm();
					else if (call !== undefined) call.inner += READ;
				}
				offset += separator[0].length - 1;
				continue;
			}
			if (open === undefined) {
				if (char === "(" || char === "[" || char === "{") depth += 1;
				else if (char === ")" || char === "]" || char === "}") depth = Math.max(depth - 1, 0);
				continue;
			}
			started = true;
			const next = text[offset + 1] ?? "";
			if (depth === open.base) {
				// A comma or a semicolon at the value's own depth ends it; a tuple's commas separate its values (rule 2).
				if (char === ";" || (char === "," && !open.tuple)) {
					open = undefined;
					continue;
				}
				const doubled = (char === "?" || char === "|" || char === "&") && next === char;
				const branch = char === "?" && next !== ".";
				const joins = char === "+" && next !== "+";
				if (char === "," || doubled || branch || joins) {
					startArm();
					if (doubled) offset += 1;
					continue;
				}
			}
			if (char === "[" && next === "]" && depth === open.base) {
				// An empty pair is part of a type's name, as in go's `[]byte("x")`: it opens nothing.
				arm += "[]";
				offset += 1;
				continue;
			}
			if (char === "(" || char === "[" || char === "{") {
				if (depth === open.base) call = char === "(" && CALLEE_RE.test(arm) ? { inner: "" } : undefined;
				else if (call !== undefined) call.inner += READ;
				depth += 1;
				continue;
			}
			if (char === ")" || char === "]" || char === "}") {
				if (depth === open.base) {
					open = undefined;
					depth = Math.max(depth - 1, 0);
					continue;
				}
				depth -= 1;
				if (depth === open.base) {
					arm += READ;
					call = undefined;
				} else if (call !== undefined) call.inner += READ;
				continue;
			}
			if (depth === open.base) arm += char;
			else if (call !== undefined && depth === open.base + 1) call.inner += char;
		}
	}

	// The value ends at the line's end unless the line ended inside a bracket the value itself opened (rule 2).
	if (open === undefined) return { names, state: BINDING_START };
	if (!started) return { names, state: { waiting: { name: open.name, tuple: open.tuple } } };
	if (depth > open.base || ARM_PREFIX_RE.test(arm)) {
		const { name, tuple, type } = open;
		// A line that ends on an arm boundary leaves the value open: its next arm starts the next line.
		const armStart = depth === open.base && ARM_PREFIX_RE.test(arm);
		return { names, state: { open: { name, inside: depth - open.base, tuple, type, armStart } } };
	}
	// A union of literal types never resumes: its members are not values.
	return { names, state: open.type ? BINDING_START : { resume: { name: open.name, tuple: open.tuple } } };
}

/** `text` without `end` at its end, when it ends with it. */
function withoutEnd(text: string, end: string): string {
	return text.endsWith(end) ? text.slice(0, text.length - end.length) : text;
}

/**
 * The names the forms give for the text before a separator, in the order the forms are tried (rule 1). After a type
 * annotation a bracket belongs to the type (`Report["status"]` declares nothing), so the array form is left out there;
 * the name directly before the separator still counts, as in a default written behind a renamed property
 * (`{ pw: password = "x" }`). The number rule of the source mask asks the same question of a code stretch.
 */
export function namesBeforeSeparator(text: string): string[] {
	const forms = TYPE_ANNOTATION_RE.test(text) ? NAME_FORMS.filter((form) => form !== ARRAY_DECLARATOR_RE) : NAME_FORMS;
	return forms.map((form) => form.exec(text)?.[1]).filter((name): name is string => name !== undefined);
}

/** The binding a separator belongs to, when its name makes its value a secret (rules 1, 4 and 5). */
function secretBindingAt(
	head: string,
	dialect: SourceDialect,
	rest: string,
): { readonly name: string; readonly tuple: boolean; readonly type: boolean } | undefined {
	const tuple = tupleSecretName(head);
	if (tuple !== undefined) return { name: tuple, tuple: true, type: false };
	const name = [...namesBeforeSeparator(head), ...quotedPropertyName(head)].find(isCredentialSecretKey);
	if (name === undefined) return undefined;
	// A value of whole literals joined by one `|` each is a union of literal types, not a value (rule 5).
	const type = dialect === "javascript" && TYPE_UNION_RE.test(rest);
	return { name, tuple: false, type };
}

/** The secret name of a tuple assignment's left side, when that side is a list of names (rule 4). */
function tupleSecretName(head: string): string | undefined {
	const statement = head.slice(lastStatementMark(head) + 1).trim();
	const parts = statement.split(",").map((part) => part.trim().split(".").at(-1) ?? "");
	if (parts.length < 2 || !parts.every((part) => TUPLE_NAME_RE.test(part))) return undefined;
	return parts.find(isCredentialSecretKey);
}

/** Where the statement that holds this text starts: after the last `;`, `{` or `}`, or at the line's start. */
function lastStatementMark(head: string): number {
	return Math.max(head.lastIndexOf(";"), head.lastIndexOf("{"), head.lastIndexOf("}"));
}

/** A quoted property name in key position before the separator: `{ "password": ` (rule 1). */
function quotedPropertyName(head: string): string[] {
	const match = QUOTED_KEY_RE.exec(head);
	const name = match?.[1];
	if (match === null || name === undefined) return [];
	const before = head.slice(0, match.index).trimEnd();
	const keyPosition = !before.endsWith("?") && (before === "" || before.endsWith("{") || before.endsWith(","));
	return keyPosition ? [name] : [];
}
