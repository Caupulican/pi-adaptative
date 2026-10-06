import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEPENDENCY_FORKS } from "../dependency-forks/definitions.mjs";

export { DEPENDENCY_FORKS };

/** These are reproduced third-party Node module contracts, not independent crypto algorithms. */
export function buildDependencyForkFiles(root, definition) {
	const archive = resolve(root, definition.archive);
	const bytes = readFileSync(archive);
	const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	if (integrity !== definition.integrity) throw new Error(`Dependency source integrity mismatch: ${definition.original}`);
	const temporary = mkdtempSync(join(tmpdir(), "pi-fork-source-"));
	try {
		execFileSync("tar", ["-xzf", archive, "-C", temporary], { stdio: "pipe" });
		const upstream = join(temporary, "package");
		const metadata = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8"));
		if (metadata.name !== definition.original || metadata.version !== definition.upstreamVersion)
			throw new Error(`Dependency source identity mismatch: ${definition.original}`);
		const files = new Map();
		for (const entry of readdirSync(join(upstream, "lib"), { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".js")) throw new Error(`Unexpected upstream lib entry: ${entry.name}`);
			files.set(`lib/${entry.name}`, readFileSync(join(upstream, "lib", entry.name)));
		}
		if (definition.main === "index.js") files.set("index.js", readFileSync(join(upstream, "index.js")));
		files.set("LICENSE", readFileSync(join(upstream, "LICENSE")));
		const patched = [];
		for (const patch of definition.patches) {
			const previous = files.get(patch.file)?.toString("utf8");
			if (previous === undefined || previous.split(patch.before).length - 1 !== (patch.count ?? 1))
				throw new Error(`Dependency patch witness mismatch: ${definition.original}/${patch.file}`);
			files.set(patch.file, Buffer.from(previous.replaceAll(patch.before, patch.after)));
			patched.push(patch.file);
		}
		for (const [destination, owner] of Object.entries(definition.helpers)) files.set(destination, readFileSync(resolve(root, owner)));
		const packageJson = {
			name: definition.name, version: definition.version, private: true, type: "commonjs", main: definition.main,
			license: definition.license, dependencies: definition.dependencies, files: ["lib", "index.js", "LICENSE", "PROVENANCE.json"],
			engines: { node: ">=24.20.0" },
			...(metadata.browser ? { browser: metadata.browser } : {}),
		};
		files.set("package.json", Buffer.from(`${JSON.stringify(packageJson, null, "\t")}\n`));
		const hashes = Object.fromEntries([...files].map(([path, content]) => [path, createHash("sha256").update(content).digest("hex")]));
		files.set("PROVENANCE.json", Buffer.from(`${JSON.stringify({
			upstream: { name: definition.original, version: definition.upstreamVersion, integrity: definition.integrity },
			advisory: definition.advisory, patchedFiles: [...new Set(patched)], ownedHelpers: definition.helpers,
			contract: "Node main/lib contract consumed by Pi; upstream browser/Flash distribution artifacts are not used or republished.",
			sourceOwner: "scripts/dependency-forks/definitions.mjs", generator: "scripts/generate-dependency-forks.mjs", hashes,
		}, null, "\t")}\n`));
		return files;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

/** All writes are explicit generated assets; unexpected files are never removed or overwritten. */
export function verifyDependencyFork(root, definition, write = false) {
	const expected = buildDependencyForkFiles(root, definition);
	const target = resolve(root, definition.directory);
	const currentPaths = [];
	function visit(directory, prefix = "") {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) throw new Error(`Unexpected fork symlink: ${definition.directory}/${path}`);
			if (entry.isDirectory()) visit(join(directory, entry.name), path);
			else if (entry.isFile()) currentPaths.push(path);
			else throw new Error(`Unexpected fork filesystem entry: ${path}`);
		}
	}
	if (existsSync(target)) {
		if (lstatSync(target).isSymbolicLink()) throw new Error(`Unexpected fork root symlink: ${target}`);
		visit(target);
	}
	for (const path of currentPaths) if (!expected.has(path)) throw new Error(`Unexpected dependency-fork file: ${definition.directory}/${path}`);
	for (const [path, content] of expected) {
		const destination = join(target, path);
		if (existsSync(destination) && readFileSync(destination).equals(content)) continue;
		if (!write) throw new Error(`Dependency fork differs from its pinned source/patch: ${definition.directory}/${path}`);
		mkdirSync(join(destination, ".."), { recursive: true });
		writeFileSync(destination, content);
	}
	return expected.size;
}
