#!/usr/bin/env node
/**
 * Runs vitest's `related` command against the exact file list ci-affected.mjs decided is safe to
 * narrow to (see codingAgentRelatedFiles), instead of a shell one-liner: passing a variable-length
 * file list through a plain `run:` step is fragile across bash (Linux/macOS) and pwsh (Windows),
 * which the coding-agent-test job's steps run under depending on OS.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function buildRelatedArgs(relatedFilesJson, extraArgs = []) {
	let files;
	try {
		files = JSON.parse(relatedFilesJson ?? "");
	} catch {
		throw new Error("PI_CI_RELATED_FILES must be a JSON array of file paths");
	}
	if (!Array.isArray(files) || files.length === 0 || !files.every((file) => typeof file === "string")) {
		throw new Error("PI_CI_RELATED_FILES must be a non-empty JSON array of file paths");
	}
	return ["related", ...files, "--run", ...extraArgs];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = buildRelatedArgs(process.env.PI_CI_RELATED_FILES, process.argv.slice(2));
	// Run from the step's own working directory (packages/coding-agent), matching every other
	// direct vitest invocation in ci.yml.
	const result = spawnSync(process.execPath, ["../../node_modules/vitest/dist/cli.js", ...args], {
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exit(result.status === null ? 1 : result.status);
}
