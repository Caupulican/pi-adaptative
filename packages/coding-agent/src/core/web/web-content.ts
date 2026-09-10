import { Parser } from "htmlparser2";
import TurndownService from "turndown";

export type WebContentFormat = "markdown" | "text" | "html";

/** The Markdown conversion budget was exceeded. The body itself is fine, and so is its text extract. */
export class HtmlComplexityError extends Error {
	constructor() {
		super("HTML complexity limit exceeded");
		this.name = "HtmlComplexityError";
	}
}

export interface WebContentConversion {
	content: string;
	/** True when Markdown was requested but the budget forced the linear text extract of the same body. */
	degraded: boolean;
}

const OMIT = new Set(["script", "style", "noscript", "iframe", "object", "embed", "template", "head"]);
const BLOCK = /^(h[1-6]|p|div|section|article|li|ul|ol|pre|blockquote|br|hr|tr)$/;
// Budget for the recursive Markdown conversion only. Turndown recurses per element (a stack overflow
// past ~128 levels) and folds each child's output into its parent's accumulated string, so its time is
// dominated by sibling fan-out over the text beneath one parent: measured 1.7 s for 400 siblings over
// 4 MB, 17 s for 4,000, 175 s for 40,000, while depth alone barely matters (64 levels over 512 KB:
// 72 ms). Work = sum over parents of (children x characters in the subtree, with relative links counted
// at their expanded length); ~1e9 is about one second. Real pages score 0.002-0.2e9 (GitHub repository
// homepages with long READMEs, Wikipedia), so the budget refuses only pathological markup.
const MAX_HTML_DEPTH = 128;
const MAX_MARKDOWN_CONVERSION_WORK = 1_000_000_000;

function isHtml(mime: string): boolean {
	return mime === "text/html" || mime === "application/xhtml+xml";
}

function markdownLink(href: string | null | undefined, baseUrl: string): string | undefined {
	if (!href) return undefined;
	try {
		const target = new URL(href, baseUrl);
		if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) return undefined;
		return target.href.replaceAll("(", "%28").replaceAll(")", "%29");
	} catch {
		return undefined;
	}
}

/**
 * One streaming pass over the markup without executing scripts or loading resources. The pass is
 * linear in the input (already bounded by the client's response cap), so "text" mode has no budget:
 * it emits the visible text with block boundaries. "markdown-budget" mode emits nothing and only
 * meters the work Turndown would spend on the same input, throwing past the budget.
 */
function scanHtml(content: string, url: string, mode: "text" | "markdown-budget"): string {
	const fragments: string[] = [];
	const hidden: boolean[] = [];
	// One frame per open element: how many child nodes it has and how many characters sit beneath it.
	const frames: { children: number; characters: number }[] = [{ children: 0, characters: 0 }];
	let work = 0;
	const child = (characters: number) => {
		const frame = frames[frames.length - 1];
		frame.children++;
		frame.characters += characters;
	};
	const close = () => {
		const frame = frames.pop();
		if (!frame) return;
		work += frame.children * frame.characters;
		if (work > MAX_MARKDOWN_CONVERSION_WORK) throw new HtmlComplexityError();
		const parent = frames[frames.length - 1];
		if (parent) parent.characters += frame.characters;
	};
	const parser = new Parser({
		onopentag(name, attributes) {
			if (mode === "markdown-budget") {
				if (hidden.length >= MAX_HTML_DEPTH) throw new HtmlComplexityError();
				let characters = 0;
				for (const value of Object.values(attributes)) characters += value.length;
				const link = name === "a" ? markdownLink(attributes.href, url) : undefined;
				child(0);
				frames.push({
					children: 0,
					characters: characters + (link ? Math.max(0, link.length - attributes.href.length) : 0),
				});
			}
			hidden.push(hidden.at(-1) === true || OMIT.has(name));
			if (mode === "text" && !hidden.at(-1) && BLOCK.test(name)) fragments.push("\n");
		},
		ontext(text) {
			if (mode === "markdown-budget") child(text.length);
			if (mode === "text" && !hidden.at(-1)) fragments.push(text);
		},
		oncomment(comment) {
			if (mode === "markdown-budget") child(comment.length);
		},
		onclosetag(name) {
			if (mode === "text" && !hidden.at(-1) && BLOCK.test(name)) fragments.push("\n");
			hidden.pop();
			if (mode === "markdown-budget") close();
		},
	});
	parser.end(content);
	// Unclosed elements and the document root fold like any parent; top-level siblings are its children.
	if (mode === "markdown-budget") while (frames.length > 0) close();
	if (mode !== "text") return "";
	return fragments
		.join("")
		.replace(/\n[\t \r]*\n+/g, "\n")
		.trim();
}

function markdownFromHtml(content: string, url: string): string {
	const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
	converter.addRule("omit-active-content", {
		filter: (node) => OMIT.has(node.nodeName.toLowerCase()),
		replacement: () => "",
	});
	converter.addRule("source-relative-links", {
		filter: "a",
		replacement(text, node) {
			const link = markdownLink(node.getAttribute("href"), url);
			return link ? `[${text}](${link})` : text;
		},
	});
	return converter.turndown(content);
}

/** Convert without executing scripts or loading resources; Markdown is metered first and refused past its budget. */
export function convertWebContent(content: string, mime: string, format: WebContentFormat, url: string): string {
	if (!isHtml(mime) || format === "html") return content;
	if (format === "text") return scanHtml(content, url, "text");
	scanHtml(content, url, "markdown-budget");
	return markdownFromHtml(content, url);
}

/**
 * The tool-facing conversion: a body that was already downloaded is never refused for its shape.
 * Markdown past its budget degrades to the linear text extract of the same body and says so.
 */
export function convertWebContentDegrading(
	content: string,
	mime: string,
	format: WebContentFormat,
	url: string,
): WebContentConversion {
	try {
		return { content: convertWebContent(content, mime, format, url), degraded: false };
	} catch (error) {
		if (!(error instanceof HtmlComplexityError)) throw error;
		return { content: scanHtml(content, url, "text"), degraded: true };
	}
}
