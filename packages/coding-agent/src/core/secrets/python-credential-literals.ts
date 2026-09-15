interface PythonCodeFrame {
	kind: "code";
	/** An f-string replacement field ends at a closing brace outside nested brackets. */
	replacement: boolean;
	depth: number;
}

interface PythonStringFrame {
	kind: "string";
	delimiter: string;
	formatted: boolean;
	raw: boolean;
	start: number;
}

type PythonLiteralFrame = PythonCodeFrame | PythonStringFrame;

function pathCandidate(code: string, frame: PythonStringFrame, end: number, following: number): string | undefined {
	if (/^\s+(?:not\s+)?in\b/u.test(code.slice(following))) return undefined;
	let value = code.slice(frame.start, end);
	if (!frame.raw) value = value.replace(/\\([\\"'])/g, "$1");
	if (frame.formatted) value = value.replace(/\{\{|\}\}/g, (braces) => braces[0]);
	return value || undefined;
}

/**
 * Lexical path candidates, not Python evaluation. Matching quotes protect ordinary string contents;
 * f-string replacement fields re-enter code so their nested literals remain visible to the guard.
 * An explicit stack bounds traversal by input length without recursive parser stack exhaustion.
 */
export function* pythonCredentialPathCandidates(code: string): Generator<string> {
	const frames: PythonLiteralFrame[] = [{ kind: "code", replacement: false, depth: 0 }];
	let index = 0;
	while (index < code.length) {
		const frame = frames[frames.length - 1];
		const character = code[index];
		if (frame.kind === "string") {
			if (code.startsWith(frame.delimiter, index)) {
				const following = index + frame.delimiter.length;
				const candidate = pathCandidate(code, frame, index, following);
				if (candidate) yield candidate;
				frames.pop();
				index = following;
				const parent = frames[frames.length - 1];
				if (parent.kind === "string") parent.start = index;
				continue;
			}
			if (character === "\\") {
				// Backslashes escape quotes, but never suppress f-string replacement braces.
				index += frame.formatted && (code[index + 1] === "{" || code[index + 1] === "}") ? 1 : 2;
				continue;
			}
			if (frame.formatted && (character === "{" || character === "}")) {
				if (code[index + 1] === character) {
					index += 2;
					continue;
				}
				if (character === "{") {
					const candidate = pathCandidate(code, frame, index, index);
					if (candidate) yield candidate;
					frames.push({ kind: "code", replacement: true, depth: 0 });
					index++;
					continue;
				}
			}
			// A malformed short string cannot consume statements on subsequent lines.
			if (frame.delimiter.length === 1 && frame.delimiter !== "}" && /[\r\n]/u.test(character)) frames.pop();
			index++;
			continue;
		}
		if (character === "#") {
			const newline = code.indexOf("\n", index);
			index = newline === -1 ? code.length : newline + 1;
			continue;
		}
		if (character === '"' || character === "'") {
			let prefixStart = index;
			while (prefixStart > 0 && /[A-Za-z_0-9]/u.test(code[prefixStart - 1])) prefixStart--;
			const prefix = code.slice(prefixStart, index).toLowerCase();
			const validPrefix = /^(?:[rubf]|br|rb|fr|rf)$/u.test(prefix);
			const delimiter = code.startsWith(character.repeat(3), index) ? character.repeat(3) : character;
			index += delimiter.length;
			frames.push({
				kind: "string",
				delimiter,
				formatted: validPrefix && prefix.includes("f"),
				raw: validPrefix && prefix.includes("r"),
				start: index,
			});
			continue;
		}
		if (frame.replacement && frame.depth === 0) {
			if (character === "}") {
				frames.pop();
				const parent = frames[frames.length - 1];
				if (parent.kind === "string") parent.start = index + 1;
				index++;
				continue;
			}
			if (character === ":") {
				// Format text can itself contain replacement fields, but its quotes are ordinary text.
				frames[frames.length - 1] = {
					kind: "string",
					delimiter: "}",
					formatted: true,
					raw: false,
					start: index + 1,
				};
				index++;
				continue;
			}
		}
		if (character === "(" || character === "[" || character === "{") frame.depth++;
		else if (")]}".includes(character) && frame.depth > 0) frame.depth--;
		index++;
	}
}
