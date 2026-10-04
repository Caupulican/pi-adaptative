// Kernel layer law: files under packages/coding-agent/src/kernel/ import only the kernel itself,
// @caupulican/pi-ai, @caupulican/pi-tui, Node built-ins and third-party packages. They never import the
// rest of coding-agent. This is the direction guarantee the former agent package boundary provided.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const kernelRoot = join(repoRoot, "packages/coding-agent/src/kernel");
const specifierPattern = /(?:from\s+|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function listSources(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) listSources(path, out);
		else if (/\.tsx?$/.test(entry)) out.push(path);
	}
	return out;
}

function violation(file, specifier) {
	if (specifier.startsWith(".")) {
		const target = resolve(dirname(file), specifier);
		return target === kernelRoot || target.startsWith(`${kernelRoot}${sep}`) ? undefined : "leaves the kernel";
	}
	if (specifier === "@caupulican/pi-adaptative" || specifier.startsWith("@caupulican/pi-adaptative/")) {
		return "imports the coding-agent package";
	}
	return undefined;
}

const failures = [];
for (const file of listSources(kernelRoot)) {
	const source = readFileSync(file, "utf8");
	for (const match of source.matchAll(specifierPattern)) {
		const reason = violation(file, match[1]);
		if (reason) failures.push(`${relative(repoRoot, file)}: "${match[1]}" ${reason}`);
	}
}
if (failures.length > 0) {
	console.error("Kernel layer law violated (kernel files import only the kernel, ai, tui, Node and packages):");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
