/**
 * Code outlines for the read tool's `mode: "outline"`: the declarations of a file with their line
 * numbers, so the model picks the range it needs instead of paging through the whole file. Measured
 * on a live session 75 % of all tool-result bytes were reads and 85 % of those were later reads of
 * files already seen, scrolled in 70 to 260 line chunks; orientation is the lever, because verbatim
 * read content cannot change (edits match it exactly).
 *
 * Line-oriented regular expressions per language, no parser: the outline is a shorter version of the
 * file (the declaration lines themselves, trimmed), never a different one.
 */

export interface OutlineEntry {
	line: number;
	text: string;
}

export interface CodeOutline {
	language: string;
	entries: OutlineEntry[];
	totalLines: number;
	/** True when the language is unknown and the outline is the head of the file instead. */
	headFallback: boolean;
}

const MAX_OUTLINE_ENTRIES = 400;
const MAX_ENTRY_CHARS = 160;
const HEAD_FALLBACK_LINES = 40;

interface LanguageRule {
	language: string;
	extensions: string[];
	/** A line is a declaration when it matches; `indent` bounds the leading whitespace considered. */
	patterns: RegExp[];
	maxIndent: number;
}

const TS_JS: LanguageRule = {
	language: "typescript",
	extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
	maxIndent: 2,
	patterns: [
		/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace|module)\s+[A-Za-z_$][\w$]*/u,
		/^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/u,
		/^(?:export\s+)?(?:const|let|var)\s+[A-Z_][A-Z0-9_]*\s*[:=]/u,
		/^export\s+(?:\{|\*|default\b)/u,
		/^\s{1,2}(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\([^;]*\)?\s*(?::\s*[^{;]+)?\s*\{$/u,
		/^\s{1,2}(?:(?:public|private|protected|static|readonly|abstract|override)\s+)*(?:constructor)\s*\(/u,
		/^describe\(|^\s{1,2}(?:it|test|describe)\(/u,
	],
};

const PYTHON: LanguageRule = {
	language: "python",
	extensions: [".py", ".pyi"],
	maxIndent: 8,
	patterns: [
		/^\s*(?:async\s+)?def\s+\w+/u,
		/^\s*class\s+\w+/u,
		/^\s*@\w[\w.]*/u,
		/^[A-Z_][A-Z0-9_]*\s*(?::[^=]+)?=/u,
		/^if __name__ ==/u,
	],
};

const RUST: LanguageRule = {
	language: "rust",
	extensions: [".rs"],
	maxIndent: 4,
	patterns: [
		/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+\w+/u,
		/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|type|mod|const|static)\s+\w+/u,
		/^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+/u,
		/^\s*macro_rules!\s+\w+/u,
		/^\s*#\[(?:test|cfg\(test\)|tokio::test|bench)\]/u,
	],
};

const GO: LanguageRule = {
	language: "go",
	extensions: [".go"],
	maxIndent: 0,
	patterns: [/^func\s+(?:\([^)]*\)\s*)?\w+/u, /^type\s+\w+/u, /^(?:var|const)\s+(?:\w+|\()/u, /^package\s+\w+/u],
};

const CSHARP: LanguageRule = {
	language: "csharp",
	extensions: [".cs"],
	maxIndent: 8,
	patterns: [
		/^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|record|unsafe)\s+)*(?:class|interface|struct|enum|record(?:\s+struct)?|namespace|delegate)\s+\w+/u,
		/^\s*(?:(?:public|private|protected|internal|static|abstract|virtual|override|async|sealed|extern|unsafe|partial)\s+)+[\w<>[\],.?\s]+\s+\w+\s*\([^;]*$/u,
		/^\s*\[(?:Fact|Theory|Test|TestMethod)\b/u,
	],
};

const POWERSHELL: LanguageRule = {
	language: "powershell",
	extensions: [".ps1", ".psm1"],
	maxIndent: 4,
	patterns: [
		/^\s*function\s+[\w-]+/iu,
		/^\s*class\s+\w+/iu,
		/^\s*filter\s+[\w-]+/iu,
		/^\s*param\s*\(/iu,
		/^\s*Describe\s+/u,
		/^\s*It\s+/u,
	],
};

const SHELL: LanguageRule = {
	language: "shell",
	extensions: [".sh", ".bash", ".zsh"],
	maxIndent: 0,
	patterns: [/^(?:function\s+)?[\w-]+\s*\(\)\s*\{?/u, /^[A-Z_][A-Z0-9_]*=/u],
};

const MARKDOWN: LanguageRule = {
	language: "markdown",
	extensions: [".md", ".mdx", ".markdown"],
	maxIndent: 0,
	patterns: [/^#{1,6}\s+\S/u],
};

const RULES: LanguageRule[] = [TS_JS, PYTHON, RUST, GO, CSHARP, POWERSHELL, SHELL, MARKDOWN];

export function outlineLanguageFor(path: string): LanguageRule | undefined {
	const lower = path.toLowerCase();
	return RULES.find((rule) => rule.extensions.some((extension) => lower.endsWith(extension)));
}

function indentWidth(line: string): number {
	let width = 0;
	for (const char of line) {
		if (char === " ") width++;
		else if (char === "\t") width += 4;
		else break;
	}
	return width;
}

function clipEntry(text: string): string {
	const trimmed = text.trimEnd();
	return trimmed.length <= MAX_ENTRY_CHARS ? trimmed : `${trimmed.slice(0, MAX_ENTRY_CHARS - 1)}…`;
}

/** Build the outline of a file's text. Pure and deterministic. */
export function buildCodeOutline(path: string, text: string): CodeOutline {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const rule = outlineLanguageFor(path);
	if (!rule) {
		return {
			language: "unknown",
			totalLines: lines.length,
			headFallback: true,
			entries: lines
				.slice(0, HEAD_FALLBACK_LINES)
				.map((line, index) => ({ line: index + 1, text: clipEntry(line) })),
		};
	}
	const entries: OutlineEntry[] = [];
	let inBlockComment = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const trimmed = line.trim();
		if (rule.language !== "markdown") {
			if (inBlockComment) {
				if (trimmed.includes("*/")) inBlockComment = false;
				continue;
			}
			if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
				inBlockComment = true;
				continue;
			}
			if (
				trimmed.startsWith("//") ||
				trimmed.startsWith("*") ||
				(trimmed.startsWith("#") &&
					rule.language !== "python" &&
					rule.language !== "shell" &&
					rule.language !== "powershell" &&
					rule.language !== "rust" &&
					rule.language !== "csharp")
			)
				continue;
		}
		if (indentWidth(line) > rule.maxIndent) continue;
		if (rule.patterns.some((pattern) => pattern.test(line))) {
			entries.push({ line: index + 1, text: clipEntry(line) });
			if (entries.length >= MAX_OUTLINE_ENTRIES) break;
		}
	}
	return { language: rule.language, totalLines: lines.length, headFallback: false, entries };
}

/** Render an outline as the read tool returns it: `line: declaration` rows and a closing note. */
export function renderCodeOutline(path: string, outline: CodeOutline): string {
	const width = String(outline.entries.at(-1)?.line ?? outline.totalLines).length;
	const rows = outline.entries.map((entry) => `${String(entry.line).padStart(width)}: ${entry.text}`);
	const header = outline.headFallback
		? `[outline unavailable for this file type; first ${outline.entries.length} of ${outline.totalLines} lines]`
		: `[outline of ${path}: ${outline.entries.length} declarations in ${outline.totalLines} lines; read offset=<line> limit=<n> for a range]`;
	const capped =
		outline.entries.length >= MAX_OUTLINE_ENTRIES ? `\n[outline capped at ${MAX_OUTLINE_ENTRIES} declarations]` : "";
	return `${header}\n${rows.join("\n")}${capped}\n`;
}
