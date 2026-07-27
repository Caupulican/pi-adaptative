const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SECRET_VARIABLE_NAME_MAX_CHARS = 128;
export const SECRET_VARIABLE_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
export const MAX_DOTENV_VARIABLES = 64;
export const MAX_DOTENV_VALUE_BYTES = 64 * 1024;
export const MAX_DOTENV_DOCUMENT_BYTES = 512 * 1024;

export class SecretDotenvError extends Error {
	readonly line?: number;

	constructor(message: string, line?: number) {
		super(line === undefined ? message : `Dotenv line ${line}: ${message}`);
		this.name = "SecretDotenvError";
		this.line = line;
	}
}

export interface ParsedDotenvVariable {
	name: string;
	value: string;
}

export interface ParsedDotenvDocument {
	document: string;
	variables: ParsedDotenvVariable[];
}

export function validateDotenvVariableName(name: string): string {
	if (!ENV_NAME_RE.test(name) || name.length > SECRET_VARIABLE_NAME_MAX_CHARS) {
		throw new SecretDotenvError("environment variable name must use portable dotenv syntax");
	}
	return name;
}

export function validateDotenvValue(value: string): string {
	if (value.includes("\0")) throw new SecretDotenvError("values cannot contain null bytes");
	if (Buffer.byteLength(value, "utf8") > MAX_DOTENV_VALUE_BYTES) {
		throw new SecretDotenvError("a value exceeds the 64 KiB limit");
	}
	return value;
}

function decodeDoubleQuoted(value: string, line: number): string {
	let decoded = "";
	for (let index = 0; index < value.length; index++) {
		const character = value[index] ?? "";
		if (character !== "\\") {
			decoded += character;
			continue;
		}
		const escaped = value[++index];
		if (escaped === undefined) throw new SecretDotenvError("double-quoted value ends with an escape", line);
		switch (escaped) {
			case "n":
				decoded += "\n";
				break;
			case "r":
				decoded += "\r";
				break;
			case "t":
				decoded += "\t";
				break;
			case "\\":
			case '"':
			case "$":
				decoded += escaped;
				break;
			default:
				decoded += `\\${escaped}`;
		}
	}
	return decoded;
}

function findClosingQuote(document: string, start: number, quote: string, line: number): number {
	for (let index = start; index < document.length; index++) {
		if (document[index] !== quote) continue;
		if (quote !== '"') return index;
		let slashCount = 0;
		for (let cursor = index - 1; cursor >= start && document[cursor] === "\\"; cursor--) slashCount++;
		if (slashCount % 2 === 0) return index;
	}
	throw new SecretDotenvError("quoted value is not terminated", line);
}

function endOfPhysicalLine(document: string, start: number): number {
	const newline = document.indexOf("\n", start);
	return newline === -1 ? document.length : newline;
}

function parseUnquotedValue(raw: string): string {
	let commentIndex = -1;
	for (let index = 0; index < raw.length; index++) {
		if (raw[index] === "#" && (index === 0 || /\s/.test(raw[index - 1] ?? ""))) {
			commentIndex = index;
			break;
		}
	}
	return (commentIndex === -1 ? raw : raw.slice(0, commentIndex)).trim();
}

/**
 * Parse the practical dotenv surface Pi materializes: comments, blank lines, optional `export`,
 * unquoted values, and single/double/backtick quoted values (including multiline quoted values).
 * Error messages contain only a line number and grammar reason, never the rejected value.
 */
export function parseDotenvDocument(input: string): ParsedDotenvDocument {
	const document = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (document.includes("\0")) throw new SecretDotenvError("document cannot contain null bytes");
	if (Buffer.byteLength(document, "utf8") > MAX_DOTENV_DOCUMENT_BYTES) {
		throw new SecretDotenvError("document exceeds the 512 KiB limit");
	}

	const variables: ParsedDotenvVariable[] = [];
	const names = new Set<string>();
	let offset = 0;
	let line = 1;
	while (offset < document.length) {
		const physicalEnd = endOfPhysicalLine(document, offset);
		const physical = document.slice(offset, physicalEnd);
		const leading = physical.match(/^\s*/)?.[0].length ?? 0;
		let cursor = offset + leading;
		if (cursor >= physicalEnd || document[cursor] === "#") {
			offset = physicalEnd < document.length ? physicalEnd + 1 : document.length;
			line++;
			continue;
		}
		if (document.slice(cursor, cursor + 6) === "export" && /\s/.test(document[cursor + 6] ?? "")) {
			cursor += 6;
			while (cursor < physicalEnd && /\s/.test(document[cursor] ?? "")) cursor++;
		}
		const equals = document.indexOf("=", cursor);
		if (equals === -1 || equals > physicalEnd) throw new SecretDotenvError("expected NAME=value", line);
		let name: string;
		try {
			name = validateDotenvVariableName(document.slice(cursor, equals).trim());
		} catch (error) {
			if (error instanceof SecretDotenvError) throw new SecretDotenvError(error.message, line);
			throw error;
		}
		if (names.has(name)) throw new SecretDotenvError(`variable ${name} is duplicated`, line);
		if (variables.length >= MAX_DOTENV_VARIABLES) {
			throw new SecretDotenvError(`profile exceeds the ${MAX_DOTENV_VARIABLES}-variable limit`, line);
		}

		cursor = equals + 1;
		while (cursor < physicalEnd && (document[cursor] === " " || document[cursor] === "\t")) cursor++;
		let value: string;
		let nextOffset: number;
		const quote = document[cursor];
		if (quote === '"' || quote === "'" || quote === "`") {
			const closing = findClosingQuote(document, cursor + 1, quote, line);
			const quoted = document.slice(cursor + 1, closing);
			const trailingEnd = endOfPhysicalLine(document, closing + 1);
			const trailing = document.slice(closing + 1, trailingEnd).trim();
			if (trailing && !trailing.startsWith("#")) {
				throw new SecretDotenvError("unexpected text follows the quoted value", line);
			}
			value = quote === '"' ? decodeDoubleQuoted(quoted, line) : quoted;
			const consumedLines = document.slice(offset, trailingEnd).split("\n").length;
			line += consumedLines;
			nextOffset = trailingEnd < document.length ? trailingEnd + 1 : document.length;
		} else {
			value = parseUnquotedValue(document.slice(cursor, physicalEnd));
			line++;
			nextOffset = physicalEnd < document.length ? physicalEnd + 1 : document.length;
		}
		try {
			validateDotenvValue(value);
		} catch (error) {
			if (error instanceof SecretDotenvError) throw new SecretDotenvError(error.message, line - 1);
			throw error;
		}
		names.add(name);
		variables.push({ name, value });
		offset = nextOffset;
	}

	if (variables.length === 0) throw new SecretDotenvError("document must contain at least one assignment");
	return { document, variables };
}

export function formatDotenvVariables(variables: readonly ParsedDotenvVariable[]): string {
	return `${[...variables]
		.sort((left, right) => left.name.localeCompare(right.name))
		.map(
			(variable) =>
				`${validateDotenvVariableName(variable.name)}=${JSON.stringify(validateDotenvValue(variable.value))}`,
		)
		.join("\n")}\n`;
}
