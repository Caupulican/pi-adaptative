#!/usr/bin/env node
/**
 * Semantic duplicate scan: every production code unit judged by Jev against its closest candidates.
 * The Jev counterpart of the jscpd clone gate: it finds logic that does the same job written differently,
 * which token-level clone detection cannot see. Needs a TypeSafe key (TYPESAFE_API_KEY or
 * ~/.config/typesafe/.env) and network, so it is a report, not part of `npm run check`.
 *
 * usage: node scripts/semantic-duplicate-scan.mjs [--out <report.md>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const repositoryRoot = resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url);
const src = (path) => jiti.import(join(repositoryRoot, "packages/coding-agent/src/core", path));
const { TypeSafeReviewer } = await src("review/typesafe-reviewer.ts");
const { SystemOneJevAdapter } = await src("system-one/adapter.ts");
const { createSystemOneConfig } = await src("system-one/config.ts");
const { SystemOneController } = await src("system-one/controller.ts");
const { ExecutionStore } = await src("system-one/execution-state.ts");
const { harnessFileLister, isTestPath, SemanticUnitIndex, scanSemanticDuplicates, JEV_SCAN_CONCURRENCY } = await src(
	"system-one/code-duplicates.ts",
);

function readKey() {
	if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
	const envFile = join(homedir(), ".config", "typesafe", ".env");
	if (!existsSync(envFile)) return undefined;
	return /^TYPESAFE_API_KEY=(.*)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "");
}

const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : undefined;
const key = readKey();
if (!key) {
	console.error("semantic-duplicate-scan: no TypeSafe key (TYPESAFE_API_KEY or ~/.config/typesafe/.env)");
	process.exit(2);
}
const model = "jev-1.13.0";
const config = createSystemOneConfig({ enabled: true, provider: "typesafe", productionModel: model });
const reviewer = new TypeSafeReviewer({ provider: "typesafe", model, getApiKey: async () => key });
const adapter = new SystemOneJevAdapter(reviewer, config, { getApiKey: async () => key, getUserKeys: async () => [key] });
const store = new ExecutionStore({
	run_id: "semantic-duplicate-scan",
	objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
	repo: { root: repositoryRoot, baseline_revision: "HEAD" },
});
const controller = new SystemOneController({ store, adapter, config });

const production = (path) =>
	/^(packages\/[^/]+\/src\/|scripts\/)/.test(path) && !isTestPath(path) && !/\.d\.ts$|\.generated\./.test(path);
const started = Date.now();
const index = new SemanticUnitIndex(repositoryRoot, "**/*.{ts,mts,js,mjs}", async (root, glob, signal) =>
	(await harnessFileLister(root, glob, signal)).filter(production),
);
await index.refresh();
const scan = await scanSemanticDuplicates({ index, controller });
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const where = (unit) => `${unit.path}:${unit.line} ${unit.name}`;
const section = (band, title) => [
	"",
	`## ${title}`,
	...scan.verdicts.filter((v) => v.band === band).map((v) => `- ${v.probability.toFixed(2)} ${where(v.unit)} <-> ${where(v.candidate)}`),
];
const counts = (band) => scan.verdicts.filter((v) => v.band === band).length;
const report = [
	"# Semantic duplicate scan",
	"",
	`${scan.units} units, ${scan.pairs} candidate pairs judged by ${model} in ${scan.requests} requests (${JEV_SCAN_CONCURRENCY} concurrent), ${seconds} s; failed requests: ${scan.failedRequests}.`,
	`Same job (hard_pass): ${counts("hard_pass")}. Provisional (soft_pass): ${counts("soft_pass")}. Unsettled: ${counts("ambiguous")}.`,
	...section("hard_pass", "Same job, written differently"),
	...section("soft_pass", "Provisional"),
].join("\n");
if (out) writeFileSync(out, `${report}\n`);
console.log(out ? report.split("\n").slice(0, 4).join("\n") : report);
process.exitCode = scan.failedRequests > 0 ? 1 : 0;
