import fs from "node:fs";
import path from "node:path";
import type { PathScope, PathScopeDecision } from "./contracts.ts";

/**
 * Resolves the real path of a target. If the target does not exist, it recursively
 * resolves the deepest existing parent directory and then appends the non-existent
 * remainder, ensuring that any symlinks in the existing path prefix are expanded.
 */
export function safeRealpathSync(targetPath: string): string {
	const absolutePath = path.resolve(targetPath);

	if (fs.existsSync(absolutePath)) {
		return fs.realpathSync(absolutePath);
	}

	const parent = path.dirname(absolutePath);
	// Base case: if parent is the same as absolutePath, we've hit the root
	if (parent === absolutePath) {
		return absolutePath;
	}

	const resolvedParent = safeRealpathSync(parent);
	return path.join(resolvedParent, path.basename(absolutePath));
}

function isPathInside(target: string, root: string): boolean {
	const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	return target === root || target.startsWith(rootWithSep);
}

export function checkPathScope(scope: PathScope, targetPath: string): PathScopeDecision {
	if (!targetPath) {
		return {
			kind: "missing",
			path: targetPath,
			reasonCode: "empty_path",
		};
	}

	let resolvedTarget: string;
	try {
		resolvedTarget = safeRealpathSync(targetPath);
	} catch {
		// If we can't resolve the path at all (e.g. permission error), fail safely
		return {
			kind: "outside",
			path: targetPath,
			reasonCode: "unresolvable_target",
		};
	}

	let resolvedRoot: string;
	try {
		resolvedRoot = safeRealpathSync(scope.root);
	} catch {
		return {
			kind: "outside",
			path: targetPath,
			reasonCode: "unresolvable_root",
		};
	}

	// First, it must be inside the main root
	if (!isPathInside(resolvedTarget, resolvedRoot)) {
		return {
			kind: "outside",
			path: targetPath,
			resolvedPath: resolvedTarget,
			reasonCode: "outside_root",
		};
	}

	// Check deniedPaths (overrides allowedPaths)
	if (scope.deniedPaths && scope.deniedPaths.length > 0) {
		for (const denied of scope.deniedPaths) {
			try {
				const resolvedDenied = safeRealpathSync(denied);
				if (isPathInside(resolvedTarget, resolvedDenied)) {
					return {
						kind: "denied",
						path: targetPath,
						resolvedPath: resolvedTarget,
						matchedRule: denied,
						reasonCode: "matches_denied_path",
					};
				}
			} catch {}
		}
	}

	// Check allowedPaths
	if (scope.allowedPaths && scope.allowedPaths.length > 0) {
		let isAllowed = false;
		let matchedAllowed: string | undefined;

		for (const allowed of scope.allowedPaths) {
			try {
				const resolvedAllowed = safeRealpathSync(allowed);
				if (isPathInside(resolvedTarget, resolvedAllowed)) {
					isAllowed = true;
					matchedAllowed = allowed;
					break;
				}
			} catch {}
		}

		if (!isAllowed) {
			return {
				kind: "outside",
				path: targetPath,
				resolvedPath: resolvedTarget,
				reasonCode: "outside_allowed_paths",
			};
		}

		return {
			kind: "inside",
			path: targetPath,
			resolvedPath: resolvedTarget,
			matchedRule: matchedAllowed,
			reasonCode: "inside_allowed_paths",
		};
	}

	return {
		kind: "inside",
		path: targetPath,
		resolvedPath: resolvedTarget,
		matchedRule: scope.root,
		reasonCode: "inside_root",
	};
}
