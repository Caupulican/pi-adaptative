#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packages = [
	{ directory: "packages/ai", sourceName: "@earendil-works/pi-ai", publishName: "@caupulican/pi-ai" },
	{ directory: "packages/agent", sourceName: "@earendil-works/pi-agent-core", publishName: "@caupulican/pi-agent-core" },
	{ directory: "packages/tui", sourceName: "@earendil-works/pi-tui", publishName: "@caupulican/pi-tui" },
	{ directory: "packages/coding-agent", sourceName: "@caupulican/pi-adaptative", publishName: "@caupulican/pi-adaptative" },
];

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function writePackageJson(directory, packageJson) {
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(packageJson, null, "\t")}\n`);
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function aliasInternalDependencies(dependencies, publishVersions) {
	if (!dependencies) return;
	for (const pkg of packages) {
		if (!dependencies[pkg.sourceName] || pkg.sourceName === pkg.publishName) continue;
		dependencies[pkg.sourceName] = `npm:${pkg.publishName}@${publishVersions.get(pkg.sourceName)}`;
	}
}

function rewriteShrinkwrapForPublish(directory, publishVersions) {
	const shrinkwrapPath = join(directory, "npm-shrinkwrap.json");
	if (!existsSync(shrinkwrapPath)) return;

	const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
	aliasInternalDependencies(shrinkwrap.packages?.[""]?.dependencies, publishVersions);

	for (const pkg of packages) {
		if (pkg.sourceName === pkg.publishName) continue;
		const entry = shrinkwrap.packages?.[`node_modules/${pkg.sourceName}`];
		if (!entry) continue;
		entry.resolved = `https://registry.npmjs.org/${pkg.publishName}/-/${pkg.publishName.split("/")[1]}-${publishVersions.get(pkg.sourceName)}.tgz`;
		aliasInternalDependencies(entry.dependencies, publishVersions);
	}

	writeFileSync(shrinkwrapPath, `${JSON.stringify(shrinkwrap, null, "\t")}\n`);
}

function preparePublishDirectory(pkg, publishVersions) {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-publish-"));
	const publishDirectory = join(tempRoot, pkg.publishName.split("/")[1]);
	cpSync(pkg.directory, publishDirectory, { recursive: true });

	const packageJson = readPackageJson(publishDirectory);
	packageJson.name = pkg.publishName;
	aliasInternalDependencies(packageJson.dependencies, publishVersions);
	aliasInternalDependencies(packageJson.devDependencies, publishVersions);
	writePackageJson(publishDirectory, packageJson);
	rewriteShrinkwrapForPublish(publishDirectory, publishVersions);

	return { publishDirectory, tempRoot };
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

const packageVersions = new Map();
for (const pkg of packages) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.sourceName) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.sourceName}`);
	}
	packageVersions.set(pkg.sourceName, packageJson.version);
}

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

console.log(`Publishing pi packages at ${versions[0]}${dryRun ? " (dry run)" : ""}\n`);

for (const pkg of packages) {
	const version = packageVersions.get(pkg.sourceName);
	assertBuildOutputExists(pkg.directory);
	const published = isPublished(pkg.publishName, version);
	const { publishDirectory, tempRoot } = preparePublishDirectory(pkg, packageVersions);

	try {
		if (dryRun) {
			if (published) {
				console.log(`${pkg.publishName}@${version} is already published; validating package contents only.`);
			} else {
				console.log(`${pkg.publishName}@${version} is not published; validating package contents before publish.`);
			}
			validatePack(publishDirectory);
			console.log();
			continue;
		}

		if (published) {
			console.log(`Skipping ${pkg.publishName}@${version}: already published\n`);
			continue;
		}

		const publishArgs = ["publish", "--access", "public", "--ignore-scripts"];
		if (process.env.GITHUB_ACTIONS) {
			publishArgs.splice(3, 0, "--provenance");
		}
		run("npm", publishArgs, { cwd: publishDirectory });
		console.log();
	} finally {
		rmSync(tempRoot, { force: true, recursive: true });
	}
}
