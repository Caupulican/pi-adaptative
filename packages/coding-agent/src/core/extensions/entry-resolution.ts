import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

function isWithin(candidate: string, root: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

/** Prefer packaged JavaScript only for Pi-owned bundled extensions; user extensions keep source-first semantics. */
export function resolveExtensionIndexEntry(directory: string, bundledExtensionsRoot: string): string | undefined {
	const candidates = isWithin(directory, bundledExtensionsRoot) ? ["index.js", "index.ts"] : ["index.ts", "index.js"];
	for (const candidate of candidates) {
		const path = join(directory, candidate);
		if (existsSync(path)) return path;
	}
	return undefined;
}
