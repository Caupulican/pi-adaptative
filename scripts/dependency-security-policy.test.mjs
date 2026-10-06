import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateRequiredSecurityOverrides as validatePolicy } from "./lib/dependency-security-policy.mjs";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

// Older unit cases isolate unrelated version rules. Supply the new independent fork contract
// explicitly; the real-tree and fork-negative cases below call the production policy directly.
function validateRequiredSecurityOverrides(root, lock, agent) {
	return validatePolicy({ ...root, devDependencies: {
		braces: "file:./vendor/pi-pattern-guard", "node-forge": "file:./packages/coding-agent/examples/extensions/sandbox/vendor/pi-certificate-codec", ...root.devDependencies,
	}, overrides: {
		braces: "$braces",
		"node-forge": "$node-forge",
		...root.overrides,
	} }, { ...lock, packages: {
		"node_modules/braces": { link: true, resolved: "vendor/pi-pattern-guard" },
		"vendor/pi-pattern-guard": { version: "3.0.3-pi.1" },
		"node_modules/node-forge": { link: true, resolved: "packages/coding-agent/examples/extensions/sandbox/vendor/pi-certificate-codec" },
		"packages/coding-agent/examples/extensions/sandbox/vendor/pi-certificate-codec": { version: "1.4.0-pi.1" },
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
	for (const name of ["braces", "node-forge"]) {
		const omitted = structuredClone(root);
		delete omitted.overrides[name];
		assert.ok(validatePolicy(omitted, lock, agent).some((failure) => failure.includes(`overrides.${name}`)));
		const upstream = structuredClone(lock);
		upstream.packages[`node_modules/${name}`] = { name, version: name === "braces" ? "3.0.3" : "1.4.0" };
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
