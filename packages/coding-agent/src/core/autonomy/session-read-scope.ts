import { resolve } from "node:path";
import { toolPathSpellings } from "../../kernel/utils/paths.ts";
import { workerMachinePathRoots } from "../delegation/worker-machine-scope.ts";
import type { CredentialExposureBoundary } from "../secrets/credential-exposure-guard.ts";
import { isNeverExemptReadPath } from "../secrets/credential-path-policy.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import type { CapabilityEnvelope } from "./contracts.ts";
import { getPrivateLaneDeniedPaths, projectLaneSettingsPath } from "./lane-private-paths.ts";
import { isPathWithinScope, pathScopesOverlap, safeRealpathSync } from "./path-scope.ts";

export { isNeverExemptReadPath };

/** What a background feature acting for the session may read: roots granted and paths that stay private. */
export interface SessionReadScope {
	readonly cwd: string;
	readonly readRoots: readonly string[];
	readonly deniedPaths: readonly string[];
	readonly exemptReadPaths?: readonly string[];
}

/**
 * The session's read scope as its read tool resolves it: the envelope's allowed paths, else the whole machine, minus
 * the harness's private storage and the envelope's denied paths.
 */
export function sessionReadScope(input: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly envelope?: Pick<CapabilityEnvelope, "allowedPaths" | "deniedPaths" | "exemptReadPaths">;
}): SessionReadScope {
	const { cwd, agentDir, envelope } = input;
	return {
		cwd,
		readRoots: envelope?.allowedPaths?.map((entry) => resolve(cwd, entry)) ?? workerMachinePathRoots(cwd),
		deniedPaths: [
			...getPrivateLaneDeniedPaths(cwd, agentDir),
			...(envelope?.deniedPaths ?? []).map((entry) => resolve(cwd, entry)),
		],
		...(envelope?.exemptReadPaths
			? { exemptReadPaths: envelope.exemptReadPaths.map((entry) => resolve(cwd, entry)) }
			: {}),
	};
}

/**
 * Why a path is outside a read scope: `outside` every granted root, or `denied` as private (`subtree`: the path
 * names a tree that contains a denied path). The lexical path and its canonical form (symbolic links expanded, the
 * missing remainder kept) must both pass.
 */
export function readScopeRefusal(
	scope: SessionReadScope,
	path: string,
	subtree = false,
): "outside" | "denied" | undefined {
	// Every spelling a tool may open for this argument is judged (the same policy the tools resolve with); an argument
	// that resolves to nothing is outside.
	const spellings = toolPathSpellings(path, scope.cwd);
	if (spellings === undefined) return "outside";
	const allowed = scope.readRoots.flatMap((root) => [resolve(scope.cwd, root), safeRealpathSync(root)]);
	const exemptEntries = subtree
		? []
		: (scope.exemptReadPaths ?? []).map((entry) => {
				const lexical = resolve(scope.cwd, entry);
				return { lexical, canonical: safeRealpathSync(lexical) };
			});
	for (const spelled of spellings) {
		const canonicalTarget = safeRealpathSync(spelled);
		const matchingExempts =
			isNeverExemptReadPath(spelled) || isNeverExemptReadPath(canonicalTarget)
				? []
				: exemptEntries.filter(
						(entry) =>
							(isPathWithinScope(spelled, entry.lexical) || isPathWithinScope(spelled, entry.canonical)) &&
							(isPathWithinScope(canonicalTarget, entry.lexical) ||
								isPathWithinScope(canonicalTarget, entry.canonical)),
					);
		for (const target of [spelled, canonicalTarget]) {
			if (!allowed.some((root) => isPathWithinScope(target, root))) return "outside";
			for (const denied of scope.deniedPaths) {
				for (const root of [resolve(scope.cwd, denied), safeRealpathSync(denied)]) {
					if (subtree ? pathScopesOverlap(target, root) : isPathWithinScope(target, root)) {
						const ancestorOfExempt = matchingExempts.some(
							(entry) => isPathWithinScope(entry.canonical, root) || isPathWithinScope(entry.lexical, root),
						);
						if (!ancestorOfExempt) return "denied";
					}
				}
			}
		}
	}
	return undefined;
}

/**
 * The credential boundary of a lane that keeps private paths out of its reach. A directory search skips every protected
 * file it meets, so the boundary admits such a search without a file filter; the project's own settings file stays
 * denied to direct reads but is a project file a recursive search may pass through.
 */
export function privatePathBoundary(
	deniedPaths: readonly string[] | undefined,
	cwd: string,
): CredentialExposureBoundary {
	return {
		redactSensitiveText: redactKnownSecrets,
		protectedFiles: deniedPaths ?? [],
		protectedDirectories: deniedPaths ?? [],
		searchableFiles: [resolve(projectLaneSettingsPath(cwd))],
		grepToolSkipsProtectedFiles: true,
	};
}
