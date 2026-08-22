import { existsSync } from "node:fs";
import path from "node:path";

type PathExists = (candidate: string) => boolean;

/** Preserve native Windows absolute paths when the host process is running under another path dialect. */
export function resolveWorkerWorkspacePath(cwd: string, candidate: string): string {
	if (path.isAbsolute(candidate)) return path.resolve(candidate);
	if (path.win32.isAbsolute(candidate)) return path.win32.normalize(candidate);
	return path.resolve(cwd, candidate);
}

/**
 * Resolve every local filesystem root the host can address without hard-coding POSIX `/` or
 * collapsing Windows authority to the foreground drive. WSL exposes mounted drives below its
 * POSIX root, while native Windows requires one root per mounted drive. A UNC working directory
 * contributes its share root even though drive enumeration cannot discover remote shares.
 */
export function workerMachinePathRoots(
	cwd: string,
	platform: NodeJS.Platform = process.platform,
	pathExists: PathExists = existsSync,
): string[] {
	if (platform !== "win32") return [path.parse(path.resolve(cwd)).root];

	const roots = new Set<string>();
	const currentRoot = path.win32.parse(path.win32.resolve(cwd)).root;
	if (currentRoot) roots.add(currentRoot);
	for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
		const root = `${String.fromCharCode(code)}:\\`;
		if (pathExists(root)) roots.add(root);
	}
	return [...roots].sort((left, right) => left.localeCompare(right));
}
