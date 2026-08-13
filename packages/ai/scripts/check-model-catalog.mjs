#!/usr/bin/env node
/**
 * Drift guard for the generated model catalogs (models.generated.ts, image-models.generated.ts).
 *
 * Plain builds are hermetic (see model-catalog-generation-policy.ts): they never fetch live
 * pricing data, so the committed catalogs can silently fall behind upstream. This script
 * regenerates both catalogs WITH live fetching into scratch paths, diffs them against the
 * committed files, and fails loudly on any drift - especially the removal of a model id that is
 * still referenced elsewhere in the repo (the class of bug fixed by 803a7efec, where an upstream
 * catalog stopped listing a model that was still part of the public API contract).
 *
 * This is intentionally NOT wired into `npm run check` or ordinary CI - it needs network access
 * to upstream pricing sources and is meant to run on a weekly schedule, surfacing drift as its
 * own CI failure/issue rather than blocking every push.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const repoRoot = resolve(packageRoot, "..", "..");

const CATALOGS = [
	{
		label: "models.generated.ts",
		generatorPath: join(packageRoot, "scripts", "generate-models.ts"),
		committedPath: join(packageRoot, "src", "models.generated.ts"),
	},
	{
		label: "image-models.generated.ts",
		generatorPath: join(packageRoot, "scripts", "generate-image-models.ts"),
		committedPath: join(packageRoot, "src", "image-models.generated.ts"),
	},
];

// Two tabs of indent is the model-id key depth in both generated files' object literals
// (provider at one tab, model id at two). See generate-models.ts/generate-image-models.ts output.
const MODEL_ID_KEY_RE = /^\t\t"((?:[^"\\]|\\.)*)":\s*\{/gm;

function extractModelIds(source) {
	const ids = new Set();
	for (const match of source.matchAll(MODEL_ID_KEY_RE)) {
		ids.add(JSON.parse(`"${match[1]}"`));
	}
	return ids;
}

function isReferencedElsewhere(id) {
	const result = spawnSync(
		"rg",
		[
			"-F",
			"-l",
			"--no-heading",
			"-g",
			"!node_modules",
			"-g",
			"!**/dist/**",
			"-g",
			"!**/*.generated.ts",
			"-g",
			"!package-lock.json",
			"-g",
			"!**/npm-shrinkwrap.json",
			"--",
			id,
			repoRoot,
		],
		{ encoding: "utf8" },
	);
	if (result.error) {
		throw new Error(`Failed to run ripgrep while searching for ${JSON.stringify(id)}: ${result.error.message}`);
	}
	if (result.status !== 0 && result.status !== 1) {
		throw new Error(`ripgrep exited ${result.status} while searching for ${JSON.stringify(id)}: ${result.stderr}`);
	}
	return result.status === 0;
}

function regenerate(catalog, tempDir) {
	const tempOutputPath = join(tempDir, catalog.label);
	const result = spawnSync(process.execPath, [catalog.generatorPath], {
		cwd: packageRoot,
		encoding: "utf8",
		env: {
			...process.env,
			PI_FETCH_MODELS: "1",
			PI_MODEL_CATALOG_OUTPUT_PATH: tempOutputPath,
		},
	});
	if (result.status !== 0) {
		console.error(result.stdout);
		console.error(result.stderr);
		throw new Error(
			`Live regeneration of ${catalog.label} failed (exit ${result.status}). This usually means the ` +
				"upstream pricing source is unreachable from this environment; rerun where network access is available.",
		);
	}
	if (!existsSync(tempOutputPath)) {
		throw new Error(`Live regeneration of ${catalog.label} did not produce an output file at ${tempOutputPath}`);
	}
	return readFileSync(tempOutputPath, "utf8");
}

function checkCatalog(catalog) {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-model-catalog-check-"));
	try {
		const freshContent = regenerate(catalog, tempDir);
		const committedContent = readFileSync(catalog.committedPath, "utf8");

		if (freshContent === committedContent) {
			console.log(`${catalog.label}: up to date, no drift.`);
			return { drifted: false, criticalRemovals: [] };
		}

		const oldIds = extractModelIds(committedContent);
		const newIds = extractModelIds(freshContent);
		const removedIds = [...oldIds].filter((id) => !newIds.has(id));
		const addedIds = [...newIds].filter((id) => !oldIds.has(id));

		console.error(`${catalog.label}: DRIFT DETECTED against the committed catalog.`);
		if (addedIds.length > 0) {
			console.error(`  Added upstream (${addedIds.length}): ${addedIds.slice(0, 20).join(", ")}${addedIds.length > 20 ? ", ..." : ""}`);
		}
		if (removedIds.length > 0) {
			console.error(`  Removed upstream (${removedIds.length}): ${removedIds.slice(0, 20).join(", ")}${removedIds.length > 20 ? ", ..." : ""}`);
		}
		const otherFieldsChanged = removedIds.length === 0 && addedIds.length === 0;
		if (otherFieldsChanged) {
			console.error("  Model id set is unchanged; pricing/metadata fields differ (e.g. cost, context window).");
		}

		const criticalRemovals = removedIds.filter((id) => isReferencedElsewhere(id));
		if (criticalRemovals.length > 0) {
			console.error("");
			console.error(`  CRITICAL: the following removed model id(s) are still referenced elsewhere in the repo:`);
			for (const id of criticalRemovals) {
				console.error(`    - ${id}`);
			}
			console.error(
				"  This is the class of bug fixed in 803a7efec (upstream stopped listing a model that was still " +
					"part of the public API contract). Investigate before regenerating - the fix may be to pin the " +
					"model explicitly in the generator rather than to let it drop out of the catalog.",
			);
		}

		return { drifted: true, criticalRemovals };
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

let anyDrift = false;
let anyCritical = false;
for (const catalog of CATALOGS) {
	const { drifted, criticalRemovals } = checkCatalog(catalog);
	anyDrift = anyDrift || drifted;
	anyCritical = anyCritical || criticalRemovals.length > 0;
}

if (anyDrift) {
	console.error("");
	console.error(
		anyCritical
			? "Model catalog check FAILED: drift includes removal of a referenced model id. See CRITICAL notes above."
			: "Model catalog check FAILED: committed catalog(s) are stale. Run `PI_FETCH_MODELS=1 npm run generate-models` " +
					"(and/or generate-image-models) in packages/ai, review the diff, and commit it.",
	);
	process.exit(1);
}

console.log("Model catalog check passed: committed catalogs match live upstream data.");
