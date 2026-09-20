#!/usr/bin/env node
/**
 * Static forbidden-fallback scan for production sources.
 *
 * Each pattern below is a fallback the release closure deleted: a synthesized artifact that returns
 * a constant, a fabricated worker or specialist result, an empty dispatcher delegate, a default
 * expert model in the real builder, a fallback profile id, an asserted task proof, a permissive
 * acquisition authority default, and a hard-coded operator execution state.
 *
 * Secret-free and deterministic: it reads the tree and exits non-zero on a match.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// The scan runs against the working directory so the same patterns can be exercised against a
// scratch tree that reproduces each rejected shape.
const REPO_ROOT = process.cwd();
const SCANNED_ROOTS = ["packages/coding-agent/src"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "__fixtures__"]);

/** A production source file; test fixtures are allowed to build fixtures. */
function isScannedFile(path) {
	return path.endsWith(".ts") && !path.endsWith(".d.ts") && !path.includes(`${sep}test${sep}`);
}

const FORBIDDEN = [
	{
		id: "fallback_capability_return_true_source",
		pattern: /Synthesized \$\{[^}]*\} capability[\s\S]{0,200}return true/,
		message: "a synthesized capability artifact generated from a constant source",
	},
	{
		id: "fabricated_capability_worker_result",
		pattern: /if \(!workerResult\) \{[\s\S]{0,400}createWorkerResultContract/,
		message: "a WorkerResultContract fabricated when the worker returned none",
	},
	{
		id: "fabricated_specialist_result",
		pattern: /if \(outcome\?\.result\) \{[\s\S]{0,200}\}\s*return createWorkerResultContract/,
		message: "a specialist result fabricated when dispatch returned none",
	},
	{
		id: "dispatcher_empty_delegate",
		pattern: /runWorkerDelegationOnce: async \(\) => \(\{\}\)/,
		message: "an empty dispatcher delegate that reports success without running a worker",
	},
	{
		id: "fallback_expert_model_profile",
		pattern: /\)\s*\?\?\s*\{\s*providerId: "[^"]+",\s*modelId: "[^"]+"/,
		message: "a default provider/model substituted for a missing expert binding",
	},
	{
		id: "fallback_profile_id",
		pattern: /profileResult\.profileId \?\? `/,
		message: "a fallback profile id synthesized when the writer returned none",
	},
	{
		id: "asserted_task_proof",
		pattern: /const proof = \{\s*verified: true/,
		message: "a task proof asserted as verified without executing anything",
	},
	{
		id: "permissive_acquisition_authority_default",
		pattern: /allow(?:ShellExecution|NetworkDownloads|PackageInstalls)\??\s*\?\?\s*true/,
		message: "a permissive acquisition authority default",
	},
	{
		id: "hard_coded_operator_execution_state",
		pattern: /phase:\s*"understand",[\s\S]{0,200}current_action:\s*"[^"]+"/,
		message: "a hard-coded operator execution projection",
	},
];

function* walk(directory) {
	for (const entry of readdirSync(directory)) {
		if (SKIPPED_DIRECTORIES.has(entry)) continue;
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (isScannedFile(path)) yield path;
	}
}

const violations = [];
for (const root of SCANNED_ROOTS) {
	for (const path of walk(join(REPO_ROOT, root))) {
		const source = readFileSync(path, "utf-8");
		for (const rule of FORBIDDEN) {
			if (rule.pattern.test(source)) {
				violations.push(`${relative(REPO_ROOT, path)}: ${rule.id} — ${rule.message}`);
			}
		}
	}
}

if (violations.length > 0) {
	console.error("Forbidden production fallbacks found:");
	for (const violation of violations) console.error(`  ${violation}`);
	process.exit(1);
}
console.log(`check-forbidden-production-fallbacks: clean (${FORBIDDEN.length} patterns).`);
