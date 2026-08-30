import { createResourceIgnoreMatcher, type ResourceIgnoreMatcher } from "./resource-ignore.ts";
import { type ResourceTraversalOptions, readResourceDirectory } from "./resource-traversal.ts";

export type SkillDiscoveryMode = "pi" | "agents";

/** Discover skill files once for both package resolution and prompt loading. */
export function discoverSkillFiles(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: ResourceIgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	const root = rootDir ?? dir;
	const matcher = ignoreMatcher ?? createResourceIgnoreMatcher();
	const traversalOptions: ResourceTraversalOptions = {
		followSymbolicLinks: true,
		ignoreMatcher: matcher,
		rootDir: root,
		skipHidden: true,
		skipNodeModules: true,
	};

	const visit = (currentDir: string): void => {
		const entries = readResourceDirectory(currentDir, traversalOptions);
		const skillRoot = entries.find((entry) => entry.name === "SKILL.md" && entry.isFile);
		if (skillRoot) {
			files.push(skillRoot.path);
			return;
		}

		for (const entry of entries) {
			if (
				((mode === "pi" && currentDir === root) || (mode === "agents" && currentDir !== root)) &&
				entry.isFile &&
				entry.name.endsWith(".md")
			) {
				files.push(entry.path);
			} else if (entry.isDirectory) {
				visit(entry.path);
			}
		}
	};

	visit(dir);
	return files;
}
