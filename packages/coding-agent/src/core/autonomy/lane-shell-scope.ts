/**
 * The facts a worker lane's shell and network authority is built from, fixed by its grant at admission, and the read-only
 * shell scope built from them. The lane surface builds its read-only shell's scope here, and a watch a worker armed is checked
 * at every observation with the scope rebuilt from the facts stored with it, so the two never drift apart.
 */
import { homedir } from "node:os";
import path from "node:path";
import type { ReadOnlyShellLaneScope } from "../model-router/read-only-shell-policy.ts";
import { type CredentialExposureBoundary, isProtectedCredentialPath } from "../secrets/credential-exposure-guard.ts";
import { projectLaneSettingsPath } from "./lane-private-paths.ts";
import { isPathWithinScope, safeRealpathSync } from "./path-scope.ts";

/**
 * What a worker lane's grant fixed about its commands and pages: where they run, whether its shell edits nothing
 * (`shellReadOnly`) and whether the lane edits nothing at all (`readOnly`), whether it holds `network.http`, its private
 * paths, and its read roots when its reads are confined (absent when they are not).
 */
export interface LaneShellFacts {
	readonly cwd: string;
	readonly shellReadOnly: boolean;
	readonly readOnly: boolean;
	readonly network: boolean;
	readonly deniedPaths: readonly string[];
	readonly readRoots?: readonly string[];
}

/** A confined lane's read roots as its checks compare them: each root as written and as it resolves. */
export function laneReadRoots(roots: readonly string[] | undefined): string[] | undefined {
	return roots?.flatMap((entry) => {
		const root = path.resolve(entry);
		return [...new Set([root, safeRealpathSync(root)])];
	});
}

/**
 * Whether a confined lane's shell may read `target`: the path as written and the file it resolves to both lie inside
 * a read root, so a link inside the project cannot carry a read outside it. A path whose links cannot be resolved is
 * outside.
 */
export function insideLaneReadRoots(target: string, roots: readonly string[]): boolean {
	let canonical: string;
	try {
		canonical = safeRealpathSync(target);
	} catch {
		return false;
	}
	return [target, canonical].every((candidate) => roots.some((root) => isPathWithinScope(candidate, root)));
}

/** Whether the lane's commands reach no network through git's implicit paths: it edits nothing and holds no `network.http`. */
export function laneRunsOffline(facts: Pick<LaneShellFacts, "readOnly" | "shellReadOnly" | "network">): boolean {
	return (facts.readOnly || facts.shellReadOnly) && !facts.network;
}

/**
 * The scope `readOnlyShellViolation` judges a read-only lane's commands by: its network grant, its scratch roots (the only
 * place it creates files; none for a command the lane does not run itself), its harness storage and its private paths,
 * where a confined lane's private paths are also everything outside its read roots (`readRoots` from {@link laneReadRoots}).
 */
export function laneReadOnlyShellScope(
	facts: LaneShellFacts,
	scratchRoots: readonly string[],
	boundary: CredentialExposureBoundary,
	readRoots: readonly string[] | undefined,
): ReadOnlyShellLaneScope {
	// The project's own `.pi/settings.json` stays private to direct reads, but a recursive project search may pass through it.
	const projectSettingsPath = path.resolve(projectLaneSettingsPath(facts.cwd));
	return {
		network: facts.network,
		scratchRoots,
		homeDir: homedir(),
		cdPath: (process.env.CDPATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0),
		harnessStoragePaths: facts.deniedPaths.filter((entry) => entry !== projectSettingsPath),
		confined: readRoots !== undefined,
		// Scratch is admitted before this is asked; a confined lane reads nothing outside its roots.
		isDeniedPath: (target) =>
			isProtectedCredentialPath(target, facts.cwd, boundary) ||
			(readRoots !== undefined && !insideLaneReadRoots(target, readRoots)),
	};
}
