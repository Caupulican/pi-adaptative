import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateRequiredSecurityOverrides } from "./lib/dependency-security-policy.mjs";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

test("the root manifest and lockfile enforce every required security override", () => {
	assert.deepEqual(validateRequiredSecurityOverrides(readJson("package.json"), readJson("package-lock.json")), []);
});

test("a vulnerable resolution fails even when the manifest claims the patched override", () => {
	assert.deepEqual(
		validateRequiredSecurityOverrides(
			{ overrides: { nanoid: "3.3.18" } },
			{ packages: { "node_modules/nanoid": { version: "3.3.16" } } },
		),
		["package-lock.json: node_modules/nanoid must resolve to 3.3.18, found 3.3.16"],
	);
});
