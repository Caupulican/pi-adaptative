import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateRequiredSecurityOverrides } from "./lib/dependency-security-policy.mjs";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

test("the root manifest and lockfile enforce every required security override", () => {
	assert.deepEqual(
		validateRequiredSecurityOverrides(
			readJson("package.json"),
			readJson("package-lock.json"),
			readJson("packages/coding-agent/package.json"),
		),
		[],
	);
});

test("a vulnerable resolution fails even when the manifest claims the patched override", () => {
	assert.deepEqual(
		validateRequiredSecurityOverrides(
			{
				overrides: {
					nanoid: "3.3.18",
					"undici@7": "7.29.1",
					"undici@8": "8.10.2",
					"brace-expansion": "5.0.12",
				},
			},
			{
				packages: {
					"node_modules/nanoid": { version: "3.3.16" },
					"node_modules/undici": { version: "8.10.2" },
					"node_modules/@effect/platform-node/node_modules/undici": { version: "7.29.1" },
					"node_modules/brace-expansion": { version: "5.0.12" },
				},
			},
			{ dependencies: { undici: "8.10.2" } },
		),
		["package-lock.json: node_modules/nanoid must resolve to 3.3.18, found 3.3.16"],
	);
});

test("every installed resolution follows its exact global override, including nested dependencies", () => {
	const manifest = {
		overrides: {
			nanoid: "3.3.18",
			protobufjs: "7.6.6",
			"undici@7": "7.29.1",
			"undici@8": "8.10.2",
			"brace-expansion": "5.0.12",
		},
	};
	const packages = {
		"node_modules/nanoid": { version: "3.3.18" },
		"node_modules/protobufjs": { version: "7.6.5" },
		"node_modules/provider/node_modules/protobufjs": { version: "7.6.5" },
		"node_modules/protobufjs-cli": { version: "7.6.5" },
		"node_modules/undici": { version: "8.10.2" },
		"node_modules/@effect/platform-node/node_modules/undici": { version: "7.29.1" },
		"node_modules/brace-expansion": { version: "5.0.12" },
	};
	assert.deepEqual(validateRequiredSecurityOverrides(manifest, { packages }, { dependencies: { undici: "8.10.2" } }), [
		"package-lock.json: node_modules/protobufjs must resolve to 7.6.6, found 7.6.5",
		"package-lock.json: node_modules/provider/node_modules/protobufjs must resolve to 7.6.6, found 7.6.5",
	]);
	packages["node_modules/protobufjs"].version = "7.6.6";
	packages["node_modules/provider/node_modules/protobufjs"].version = "7.6.6";
	assert.deepEqual(validateRequiredSecurityOverrides(manifest, { packages }, { dependencies: { undici: "8.10.2" } }), []);
});

test("selector-scoped provider and brace resolutions reject vulnerable direct and nested packages", () => {
	const manifest = {
		overrides: {
			nanoid: "3.3.18",
			"undici@7": "7.29.1",
			"undici@8": "8.10.2",
			"brace-expansion": "5.0.12",
		},
	};
	const codingAgent = { dependencies: { undici: "8.10.2" } };
	const lockfile = {
		packages: {
			"node_modules/nanoid": { version: "3.3.18" },
			"node_modules/undici": { version: "8.10.1" },
			"node_modules/@effect/platform-node/node_modules/undici": { version: "7.29.0" },
			"node_modules/brace-expansion": { version: "5.0.9" },
		},
	};
	assert.deepEqual(
		validateRequiredSecurityOverrides(manifest, lockfile, codingAgent),
		[
			"package-lock.json: node_modules/@effect/platform-node/node_modules/undici must resolve to 7.29.1, found 7.29.0",
			"package-lock.json: node_modules/undici must resolve to 8.10.2, found 8.10.1",
			"package-lock.json: node_modules/brace-expansion must resolve to 5.0.12, found 5.0.9",
		],
	);
});

test("the coding-agent manifest cannot retain a vulnerable direct provider dependency", () => {
	const manifest = {
		overrides: {
			nanoid: "3.3.18",
			"undici@7": "7.29.1",
			"undici@8": "8.10.2",
			"brace-expansion": "5.0.12",
		},
	};
	const packages = {
		"node_modules/nanoid": { version: "3.3.18" },
		"node_modules/undici": { version: "8.10.2" },
		"node_modules/@effect/platform-node/node_modules/undici": { version: "7.29.1" },
		"node_modules/brace-expansion": { version: "5.0.12" },
	};
	assert.deepEqual(
		validateRequiredSecurityOverrides(manifest, { packages }, { dependencies: { undici: "8.10.1" } }),
		["packages/coding-agent/package.json: dependencies.undici must be 8.10.2, found 8.10.1"],
	);
});

test("selector policy rejects missing installed major resolutions", () => {
	assert.deepEqual(
		validateRequiredSecurityOverrides(
			{
				overrides: {
					nanoid: "3.3.18",
					"undici@7": "7.29.1",
					"undici@8": "8.10.2",
					"brace-expansion": "5.0.12",
				},
			},
			{
				packages: {
					"node_modules/nanoid": { version: "3.3.18" },
					"node_modules/brace-expansion": { version: "5.0.12" },
				},
			},
			{ dependencies: { undici: "8.10.2" } },
		),
		[
			"package-lock.json: undici@7 must have an installed resolution",
			"package-lock.json: undici@8 must have an installed resolution",
		],
	);
});

test("selector policy rejects malformed direct lock and manifest versions", () => {
	const manifest = {
		overrides: {
			nanoid: "3.3.18",
			"undici@7": "7.29.1",
			"undici@8": "8.10.2",
			"brace-expansion": "5.0.12",
		},
	};
	const packages = {
		"node_modules/nanoid": { version: "3.3.18" },
		"node_modules/undici": { version: "8.not-a-version" },
		"node_modules/@effect/platform-node/node_modules/undici": { version: "7.29.1" },
		"node_modules/brace-expansion": { version: "5.0.12" },
	};
	assert.deepEqual(
		validateRequiredSecurityOverrides(manifest, { packages }, { dependencies: { undici: "8.latest" } }),
		[
			"package-lock.json: node_modules/undici must resolve to 8.10.2, found 8.not-a-version",
			"packages/coding-agent/package.json: dependencies.undici must be 8.10.2, found 8.latest",
		],
	);
});

test("selector-scoped provider and brace resolutions accept exact patched versions", () => {
	const manifest = {
		overrides: {
			nanoid: "3.3.18",
			"undici@7": "7.29.1",
			"undici@8": "8.10.2",
			"brace-expansion": "5.0.12",
		},
	};
	const codingAgent = { dependencies: { undici: "8.10.2" } };
	const lockfile = {
		packages: {
			"node_modules/nanoid": { version: "3.3.18" },
			"node_modules/undici": { version: "8.10.2" },
			"node_modules/@effect/platform-node/node_modules/undici": { version: "7.29.1" },
			"node_modules/brace-expansion": { version: "5.0.12" },
		},
	};
	assert.deepEqual(validateRequiredSecurityOverrides(manifest, lockfile, codingAgent), []);
});
