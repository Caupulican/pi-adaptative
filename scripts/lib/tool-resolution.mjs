import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromScript = createRequire(import.meta.url);
let requireFromMainCheckout;

/**
 * The directory of an installed package, found the way Node resolves any dependency: from the caller's own location,
 * walking up. A path built from a checkout's root only exists where `npm install` ran; a linked worktree has the
 * tracked scripts and no `node_modules`, so a tool is looked for next in the checkout that owns the worktree (the parent
 * of git's common directory). Undefined when neither has it: the caller reports that, it never skips its step.
 */
export function resolvePackageDirectory(specifier, from = requireFromScript) {
	const manifest = `${specifier}/package.json`;
	try {
		return dirname(from.resolve(manifest));
	} catch {
		// A linked worktree can have no install of its own.
	}
	try {
		if (!requireFromMainCheckout) {
			const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
				cwd: repoRoot,
				encoding: "utf8",
			}).trim();
			const mainCheckout = resolve(repoRoot, commonDir, "..");
			requireFromMainCheckout = createRequire(join(mainCheckout, "package.json"));
		}
		return dirname(requireFromMainCheckout.resolve(manifest));
	} catch {
		return undefined;
	}
}
