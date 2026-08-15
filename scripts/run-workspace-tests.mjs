#!/usr/bin/env node
/**
 * Sequential workspace test runner. Stops on the first failing package so a
 * single red file does not buy the rest of the matrix.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceTestPlan } from "./workspace-test-plan.mjs";

const workspaces = resolveWorkspaceTestPlan(process.argv.slice(2));

function hasTestScript(workspace) {
	const pkgPath = join(workspace, "package.json");
	if (!existsSync(pkgPath)) return false;
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	return typeof pkg.scripts?.test === "string";
}

for (const workspace of workspaces) {
	if (!hasTestScript(workspace)) continue;
	console.log(`\n=== ${workspace} ===\n`);
	const result = spawnSync("npm", ["run", "test", "--workspace", workspace], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.status !== 0) {
		process.exit(result.status === null ? 1 : result.status);
	}
}
