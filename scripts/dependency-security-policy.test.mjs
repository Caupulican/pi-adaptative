import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEPENDENCY_FORKS } from "./dependency-forks/definitions.mjs";
import { validateRequiredSecurityOverrides as validatePolicy } from "./lib/dependency-security-policy.mjs";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

// Isolated version-rule cases supply independent contracts explicitly. Real-tree and
// focused negative cases below call the complete production policy directly.
function validateRequiredSecurityOverrides(root, lock, agent) {
	return validatePolicy({ ...root, devDependencies: {
		...Object.fromEntries(DEPENDENCY_FORKS.map((fork) => [fork.original, `file:./${fork.directory}`])), ...root.devDependencies,
	}, overrides: {
		...Object.fromEntries(DEPENDENCY_FORKS.map((fork) => [fork.original, `$${fork.original}`])),
		...root.overrides,
	} }, { ...lock, packages: {
		...Object.fromEntries(DEPENDENCY_FORKS.flatMap((fork) => [
			[`node_modules/${fork.original}`, { link: true, resolved: fork.directory }],
			[fork.directory, { name: fork.name, version: fork.version }],
		])),
		...lock.packages,
	} }, agent);
}

test("the root manifest and lockfile enforce every required security override", () => {
	assert.deepEqual(
		validatePolicy(
			readJson("package.json"),
			readJson("package-lock.json"),
			readJson("packages/coding-agent/package.json"),
		),
		[],
	);
});

test("removing a required fork or restoring an upstream resolution fails the safety gate", () => {
	const root = readJson("package.json");
	const lock = readJson("package-lock.json");
	const agent = readJson("packages/coding-agent/package.json");
	for (const { original: name, upstreamVersion } of DEPENDENCY_FORKS) {
		const omitted = structuredClone(root);
		delete omitted.overrides[name];
		assert.ok(validatePolicy(omitted, lock, agent).some((failure) => failure.includes(`overrides.${name}`)));
		const upstream = structuredClone(lock);
		upstream.packages[`node_modules/${name}`] = { name, version: upstreamVersion };
		assert.ok(validatePolicy(root, upstream, agent).some((failure) => failure.includes(`${name} must resolve`)));
	}
});

test("local-fork evidence rejects wrong paths, missing targets, malformed links and nested upstream copies", () => {
	const root = readJson("package.json");
	const lock = readJson("package-lock.json");
	const agent = readJson("packages/coding-agent/package.json");
	const path = lock.packages["node_modules/braces"].resolved;
	for (const mutate of [
		(value) => { value.packages["node_modules/braces"].resolved = "wrong/path"; value.packages["wrong/path"] = value.packages[path]; },
		(value) => { delete value.packages[path]; },
		(value) => { value.packages[path].version = "3.0.3"; },
		(value) => { value.packages[path].name = "braces"; },
		(value) => { value.packages["node_modules/braces"].link = "true"; },
		(value) => { value.packages["node_modules/other/node_modules/braces"] = { version: "3.0.3" }; },
	]) {
		const changed = structuredClone(lock);
		mutate(changed);
		assert.ok(validatePolicy(root, changed, agent).some((failure) => failure.includes("braces must resolve")));
	}
});

test("source-map safety policy rejects removed pins and vulnerable direct or nested resolutions", () => {
	const root = readJson("package.json");
	const lock = readJson("package-lock.json");
	const agent = readJson("packages/coding-agent/package.json");
	const omitted = structuredClone(root);
	delete omitted.overrides["source-map-js"];
	assert.ok(validatePolicy(omitted, lock, agent).some((failure) => failure.includes("overrides.source-map-js")));
	for (const path of ["node_modules/source-map-js", "node_modules/consumer/node_modules/source-map-js"]) {
		const vulnerable = structuredClone(lock);
		vulnerable.packages[path] = { version: "1.2.1" };
		assert.ok(validatePolicy(root, vulnerable, agent).includes(`package-lock.json: ${path} must resolve to pi-source-map-codec@1.2.2-pi.1`));
	}
	const missing = structuredClone(lock);
	delete missing.packages["node_modules/source-map-js"];
	assert.ok(validatePolicy(root, missing, agent).some((failure) => failure.includes("source-map-js must have a hardened installed resolution")));
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
