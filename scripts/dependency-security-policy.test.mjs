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

test("every installed resolution follows its exact global override, including nested dependencies", () => {
	const manifest = { overrides: { nanoid: "3.3.18", protobufjs: "7.6.6" } };
	const packages = {
		"node_modules/nanoid": { version: "3.3.18" },
		"node_modules/protobufjs": { version: "7.6.5" },
		"node_modules/provider/node_modules/protobufjs": { version: "7.6.5" },
		"node_modules/protobufjs-cli": { version: "7.6.5" },
	};
	assert.deepEqual(validateRequiredSecurityOverrides(manifest, { packages }), [
		"package-lock.json: node_modules/protobufjs must resolve to 7.6.6, found 7.6.5",
		"package-lock.json: node_modules/provider/node_modules/protobufjs must resolve to 7.6.6, found 7.6.5",
	]);
	packages["node_modules/protobufjs"].version = "7.6.6";
	packages["node_modules/provider/node_modules/protobufjs"].version = "7.6.6";
	assert.deepEqual(validateRequiredSecurityOverrides(manifest, { packages }), []);
});
