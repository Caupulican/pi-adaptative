import assert from "node:assert/strict";
import test from "node:test";
import { isBrowserInertAnthropicCredentialImport } from "./lib/browser-smoke-node-import-policy.mjs";

test("allows the audited Anthropic credential imports on POSIX and Windows paths", () => {
	for (const importer of [
		"/repo/node_modules/@anthropic-ai/sdk/core/credentials.mjs",
		"C:\\repo\\node_modules\\@anthropic-ai\\sdk\\lib\\credentials\\types.mjs",
	]) {
		assert.equal(
			isBrowserInertAnthropicCredentialImport({
				kind: "dynamic-import",
				path: "node:fs",
				importer,
			}),
			true,
		);
	}
});

test("rejects static imports, new builtins, and imports outside the audited credential files", () => {
	const baseImport = {
		kind: "dynamic-import",
		path: "node:fs",
		importer: "/repo/node_modules/@anthropic-ai/sdk/core/credentials.mjs",
	};

	assert.equal(isBrowserInertAnthropicCredentialImport({ ...baseImport, kind: "import-statement" }), false);
	assert.equal(isBrowserInertAnthropicCredentialImport({ ...baseImport, path: "node:child_process" }), false);
	assert.equal(
		isBrowserInertAnthropicCredentialImport({
			...baseImport,
			importer: "/repo/packages/ai/src/providers/anthropic.ts",
		}),
		false,
	);
	assert.equal(
		isBrowserInertAnthropicCredentialImport({
			...baseImport,
			importer: "/repo/node_modules/@anthropic-ai/sdk/tools/agent-toolset/skills.mjs",
		}),
		false,
	);
});
