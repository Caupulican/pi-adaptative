import { Parser } from "htmlparser2";
import TurndownService from "turndown";

export type WebContentFormat = "markdown" | "text" | "html";
const OMIT = new Set(["script", "style", "noscript", "iframe", "object", "embed", "template", "head"]);
const BLOCK = /^(h[1-6]|p|div|section|article|li|ul|ol|pre|blockquote|br|hr|tr)$/;
const MAX_HTML_NODES = 50_000;
const MAX_HTML_DEPTH = 128;
const MAX_HTML_CONVERSION_UNITS = 20 * 1024 * 1024;
const MAX_LINK_EXPANSION_CHARACTERS = 1024 * 1024;

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

/** Parse without executing scripts or loading resources; bound recursive Markdown conversion first. */
export function convertWebContent(content: string, mime: string, format: WebContentFormat, url: string): string {
	if ((mime !== "text/html" && mime !== "application/xhtml+xml") || format === "html") return content;
	const fragments: string[] = [];
	const hidden: boolean[] = [];
	let nodes = 0;
	let conversionUnits = 0;
	let linkExpansion = 0;
	const countNode = (characters: number, expandedLinkCharacters = 0) => {
		nodes++;
		// Recursive conversion inspects ancestor text and carries converted links through their
		// containers. Cap that work as well as input size; short links can expand against long URLs.
		if (format === "markdown") {
			conversionUnits += (characters + 16) * (hidden.length + 1);
			linkExpansion += expandedLinkCharacters;
		}
		if (
			nodes > MAX_HTML_NODES ||
			conversionUnits > MAX_HTML_CONVERSION_UNITS ||
			linkExpansion > MAX_LINK_EXPANSION_CHARACTERS
		)
			throw new Error("HTML complexity limit exceeded");
	};
	const parser = new Parser({
		onopentag(name, attributes) {
			if (hidden.length >= MAX_HTML_DEPTH) throw new Error("HTML complexity limit exceeded");
			let characters = 0;
			for (const value of Object.values(attributes)) characters += value.length;
			const link = format === "markdown" && name === "a" ? markdownLink(attributes.href, url) : undefined;
			const expanded = link ? Math.max(0, link.length - attributes.href.length) : 0;
			countNode(characters + expanded, expanded);
			hidden.push(hidden.at(-1) === true || OMIT.has(name));
			if (format === "text" && !hidden.at(-1) && BLOCK.test(name)) fragments.push("\n");
		},
		ontext(text) {
			countNode(text.length);
			if (format === "text" && !hidden.at(-1)) fragments.push(text);
		},
		oncomment(comment) {
			countNode(comment.length);
		},
		onclosetag(name) {
			if (format === "text" && !hidden.at(-1) && BLOCK.test(name)) fragments.push("\n");
			hidden.pop();
		},
	});
	parser.end(content);
	if (format === "text")
		return fragments
			.join("")
			.replace(/\n[\t \r]*\n+/g, "\n")
			.trim();
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
