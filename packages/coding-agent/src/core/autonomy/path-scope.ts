import fs from "node:fs";
import path from "node:path";
import type { PathScope, PathScopeDecision } from "./contracts.ts";

// Bounds the symlink-following recursion in resolveSafely: a chain of dangling links is finite
// in practice, and a genuine symlink cycle (a -> b -> a) must fail closed with a throw rather
// than recurse forever.
const MAX_SYMLINK_HOPS = 32;

/**
 * Resolves the real path of a target. If the target does not exist, it recursively
 * resolves the deepest existing parent directory and then appends the non-existent
 * remainder, ensuring that any symlinks in the existing path prefix are expanded.
 */
export function safeRealpathSync(targetPath: string): string {
	return resolveSafely(path.resolve(targetPath), 0);
}

function resolveSafely(absolutePath: string, hops: number): string {
	if (hops > MAX_SYMLINK_HOPS) {
		throw new Error(`safeRealpathSync: exceeded ${MAX_SYMLINK_HOPS} symlink hops resolving "${absolutePath}"`);
	}

	if (fs.existsSync(absolutePath)) {
		return fs.realpathSync(absolutePath);
	}

	// existsSync FOLLOWS symlinks, so it reports false for a DANGLING link (the link exists but
	// its target does not) — the same as a path that plain doesn't exist at all. Without this
	// lstat check, a dangling leaf would fall straight into the lexical parent-join below, never
	// dereferencing the link itself. That would let a dangling symlink placed inside an allowed
	// root smuggle writes to wherever it points, since the write itself (e.g. writeFileSync) DOES
	// follow the link. lstatSync throws ENOENT for a path that truly doesn't exist anywhere in
	// the chain — that case falls through to the parent-recursion branch below, unchanged.
	let lstat: ReturnType<typeof fs.lstatSync> | undefined;
	try {
		lstat = fs.lstatSync(absolutePath);
	} catch {
		lstat = undefined;
	}

	if (lstat?.isSymbolicLink()) {
		const linkTarget = fs.readlinkSync(absolutePath);
		const resolvedParent = resolveSafely(path.dirname(absolutePath), hops + 1);
		const resolvedTarget = path.isAbsolute(linkTarget)
			? path.resolve(linkTarget)
			: path.resolve(resolvedParent, linkTarget);
		return resolveSafely(resolvedTarget, hops + 1);
	}

	const parent = path.dirname(absolutePath);
	// Base case: if parent is the same as absolutePath, we've hit the root
	if (parent === absolutePath) {
		return absolutePath;
	}

	const resolvedParent = resolveSafely(parent, hops + 1);
	return path.join(resolvedParent, path.basename(absolutePath));
}

function usesWindowsPath(value: string): boolean {
	return /^[a-zA-Z]:([\\/]|$)/.test(value) || value.startsWith("\\\\") || value.startsWith("//");
}

function lexicalPathApi(...paths: readonly string[]): typeof path.posix | typeof path.win32 {
	return paths.some(usesWindowsPath) ? path.win32 : path.posix;
}

function canonicalPathScopeIdentityWithApi(value: string, pathApi: typeof path.posix | typeof path.win32): string {
	const resolved = pathApi.resolve(value);
	return pathApi === path.win32 ? resolved.toLowerCase() : resolved;
}

/**
 * Stable lexical scope identity for durable planners. Windows drive and UNC paths are normalized
 * case-insensitively even when a WSL process is only comparing them and cannot realpath them.
 */
export function canonicalPathScopeIdentity(value: string): string {
	return canonicalPathScopeIdentityWithApi(value, lexicalPathApi(value));
}

/**
 * Boundary-safe lexical containment for already-resolved paths and portable scope planning.
 * Windows drive and UNC paths compare case-insensitively; native POSIX paths remain case-sensitive.
 * This deliberately does not resolve symlinks — callers that authorize filesystem access must first
 * use {@link safeRealpathSync}.
 */
export function isPathWithinScope(targetPath: string, scopeRoot: string): boolean {
	const pathApi = lexicalPathApi(targetPath, scopeRoot);
	const target = canonicalPathScopeIdentityWithApi(targetPath, pathApi);
	const root = canonicalPathScopeIdentityWithApi(scopeRoot, pathApi);
	const relativePath = pathApi.relative(root, target);
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${pathApi.sep}`) && relativePath !== ".." && !pathApi.isAbsolute(relativePath))
	);
}

/** True when either scope contains the other, including an exact match. */
export function pathScopesOverlap(firstScope: string, secondScope: string): boolean {
	return isPathWithinScope(firstScope, secondScope) || isPathWithinScope(secondScope, firstScope);
}

export function checkPathScope(scope: PathScope, targetPath: string): PathScopeDecision {
	if (!targetPath) {
		return {
			kind: "missing",
			path: targetPath,
			reasonCode: "empty_path",
		};
	}
	const lexicalTarget = path.resolve(targetPath);
	const lexicalRoot = path.resolve(scope.root);
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
	if (!isPathWithinScope(lexicalTarget, lexicalRoot) && !isPathWithinScope(lexicalTarget, resolvedRoot)) {
		return {
			kind: "outside",
			path: targetPath,
			reasonCode: "outside_root",
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

	// First, it must be inside the main root
	if (!isPathWithinScope(resolvedTarget, resolvedRoot)) {
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
				if (isPathWithinScope(resolvedTarget, resolvedDenied)) {
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
				if (isPathWithinScope(resolvedTarget, resolvedAllowed)) {
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
