import { readFileSync, writeFileSync } from "node:fs";
import hljs from "highlight.js";

const outputPath = new URL("../packages/coding-agent/src/utils/highlight-js-languages.ts", import.meta.url);
const languageNames = hljs.listLanguages();
const moduleNames = new Map(
	languageNames.map((name) => [name, `${name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&")}Lang`]),
);
const aliases = new Map();
for (const name of languageNames) {
	for (const alias of hljs.getLanguage(name)?.aliases ?? []) aliases.set(alias, name);
}

function key(name) {
	return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

const source = [
	"// GENERATED. Do not hand-edit.",
	"// Static grammar factories and aliases from the installed highlight.js registration order.",
	"// Regenerate: node scripts/generate-highlight-languages.mjs",
	"",
	'import type { LanguageFn } from "highlight.js";',
	...[...languageNames].sort().map((name) => `import ${moduleNames.get(name)} from "highlight.js/lib/languages/${name}";`),
	"",
	"// Canonical names precede aliases; registration order determines alias collisions.",
	"export const HIGHLIGHT_LANGUAGE_MODULES: Record<string, LanguageFn> = {",
	...languageNames.map((name) => `\t${key(name)}: ${moduleNames.get(name)},`),
	"};",
	"",
	"export const HIGHLIGHT_LANGUAGE_ALIASES: Record<string, string> = {",
	...[...aliases].map(([alias, name]) => `\t${key(alias)}: ${JSON.stringify(name)},`),
	"};",
	"",
].join("\n");

const arguments_ = process.argv.slice(2);
if (arguments_.length === 0) {
	writeFileSync(outputPath, source);
} else if (arguments_.length === 1 && arguments_[0] === "--check") {
	if (readFileSync(outputPath, "utf8") !== source) throw new Error("highlight.js language catalog is stale; run node scripts/generate-highlight-languages.mjs");
} else {
	throw new Error("usage: node scripts/generate-highlight-languages.mjs [--check]");
}
