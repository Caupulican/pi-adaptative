import assert from "node:assert/strict";
import hljs from "highlight.js/lib/core";
import { highlight, supportsLanguage } from "../../src/utils/syntax-highlight.ts";

assert.deepEqual(hljs.listLanguages(), [], "importing the adapter must leave grammars unregistered");
assert.equal(supportsLanguage("unknown-language"), false);
assert.deepEqual(hljs.listLanguages(), []);
assert.equal(supportsLanguage("TS"), true);
assert.deepEqual(hljs.listLanguages(), ["typescript"]);
assert.equal(
	highlight("const answer = 42", {
		language: "ts",
		theme: { keyword: (text) => `[${text}]`, number: (text) => `{${text}}` },
	}),
	"[const] answer = {42}",
);
assert.equal(supportsLanguage("gql"), true);
assert.equal(supportsLanguage("systemd"), true);
assert.equal(supportsLanguage("nt"), true);
assert.equal(supportsLanguage("wasm"), true);
assert.equal(supportsLanguage("wren"), true);
assert.equal(highlight("plain <text> & content", { language: "plaintext" }), "plain <text> & content");
process.stdout.write("syntax highlighting native contract passed\n");
