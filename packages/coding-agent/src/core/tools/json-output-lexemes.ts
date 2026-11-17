/** Checks source facts that native JSON parsing cannot retain in a reduced output. */

// JSON.parse has already checked the grammar. Walking tokens preserves key spellings and numeric lexemes.
const JSON_TOKEN =
	/"[^"\\]*(?:\\[\s\S][^"\\]*)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[\t\n\r ]+/gy;
const NUMBER_PARTS = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u;
const MAX_NESTING = 128;

function decimalIdentity(text: string): string | undefined {
	const parts = NUMBER_PARTS.exec(text);
	if (!parts) return undefined;
	const [, sign, whole, fraction = "", exponent] = parts;
	const digits = whole! + fraction;
	const start = digits.search(/[1-9]/u);
	if (start < 0) return `${sign}0`;
	const power = Number(exponent ?? 0) + whole!.length - start - 1;
	if (!Number.isSafeInteger(power)) return undefined;
	return `${sign}${digits.slice(start).replace(/0+$/u, "")}e${power}`;
}

function numberSurvivesSerialization(source: string): boolean {
	const value = Number(source);
	if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return false;
	const exact = decimalIdentity(source);
	return exact !== undefined && exact === decimalIdentity(JSON.stringify(value));
}

/** Refuse reductions of duplicate-key, lossy-number, or exceptionally deep documents. */
export function jsonOutputCanReserialize(text: string): boolean {
	const tokens = new RegExp(JSON_TOKEN);
	const scopes: Array<Set<string> | undefined> = [];
	while (tokens.lastIndex < text.length) {
		const match = tokens.exec(text);
		if (!match) return false;
		const token = match[0];
		const first = token[0]!;
		if (first === "{" || first === "[") {
			if (scopes.length >= MAX_NESTING) return false;
			scopes.push(first === "{" ? new Set<string>() : undefined);
		} else if (first === "}" || first === "]") {
			scopes.pop();
		} else if (first === '"') {
			const keys = scopes.at(-1);
			if (!keys) continue;
			let next = tokens.lastIndex;
			while (next < text.length && /[\t\n\r ]/u.test(text[next]!)) next++;
			if (text[next] !== ":") continue;
			const key = token.includes("\\") ? (JSON.parse(token) as string) : token.slice(1, -1);
			if (keys.has(key)) return false;
			keys.add(key);
		} else if ((first === "-" || (first >= "0" && first <= "9")) && !numberSurvivesSerialization(token)) {
			return false;
		}
	}
	return true;
}
