import hljs from "highlight.js/lib/core.js";
import { HIGHLIGHT_LANGUAGE_ALIASES, HIGHLIGHT_LANGUAGE_MODULES } from "./highlight-js-languages.ts";
import { decodeHtmlEntityAt } from "./html.ts";

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter ? formatter(textBuffer) : textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

let allLanguagesRegistered = false;

// Register a language with highlight.js/lib/core on first use instead of eagerly
// registering all ~190 bundled languages at import time. `HIGHLIGHT_LANGUAGE_MODULES`
// and `HIGHLIGHT_LANGUAGE_ALIASES` are generated from the same registration data as
// highlight.js/lib/index.js (see highlight-js-languages.ts), so resolution is
// identical: an exact canonical name always wins over an alias (mirrors hljs's own
// `languages[name] || languages[aliases[name]]` lookup), and when two languages
// declare the same alias, the language registered last wins (mirrors hljs's
// registration-order overwrite of its internal alias table).
function ensureLanguageRegistered(name: string): void {
	const lower = name.toLowerCase();
	if (hljs.getLanguage(lower)) {
		return;
	}
	const canonicalName = HIGHLIGHT_LANGUAGE_MODULES[lower] ? lower : HIGHLIGHT_LANGUAGE_ALIASES[lower];
	const languageModule = canonicalName ? HIGHLIGHT_LANGUAGE_MODULES[canonicalName] : undefined;
	if (canonicalName && languageModule) {
		hljs.registerLanguage(canonicalName, languageModule);
	}
}

function ensureAllLanguagesRegistered(): void {
	if (allLanguagesRegistered) {
		return;
	}
	for (const [canonicalName, languageModule] of Object.entries(HIGHLIGHT_LANGUAGE_MODULES)) {
		if (!hljs.getLanguage(canonicalName)) {
			hljs.registerLanguage(canonicalName, languageModule);
		}
	}
	allLanguagesRegistered = true;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
	let html: string;
	if (options.language) {
		ensureLanguageRegistered(options.language);
		html = hljs.highlight(code, {
			language: options.language,
			ignoreIllegals: options.ignoreIllegals,
		}).value;
	} else if (options.languageSubset) {
		for (const name of options.languageSubset) {
			ensureLanguageRegistered(name);
		}
		html = hljs.highlightAuto(code, options.languageSubset).value;
	} else {
		// Full auto-detection with no subset scans every registered language, so there is
		// no lazy subset to resolve first — register everything to preserve identical
		// detection results to the eager bundle.
		ensureAllLanguagesRegistered();
		html = hljs.highlightAuto(code).value;
	}
	return renderHighlightedHtml(html, options.theme);
}

export function supportsLanguage(name: string): boolean {
	ensureLanguageRegistered(name);
	return hljs.getLanguage(name) !== undefined;
}
