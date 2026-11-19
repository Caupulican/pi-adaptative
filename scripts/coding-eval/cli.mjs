// Offline plan by default. Paid execution requires an explicit run and a fresh private output directory.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isPathWithinScope, realPathIdentity } from "../../packages/coding-agent/src/core/autonomy/path-scope.ts";
import { ORCHESTRATION_THINKING_LEVELS } from "../../packages/coding-agent/src/core/orchestration/contracts.ts";
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";
import { planTrials, summarize } from "./comparison.mjs";
import { cases, corpusVersion } from "./corpus.mjs";
import { saveJson, supervise } from "./driver.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const usage = `npm run eval:coding -- [--run --model provider/model --out NEW_DIRECTORY]
  --case ID          Limit the corpus (repeatable)
  --system-one       Enable automatic semantic provider selection in both arms
  --thinking LEVEL   Requested thinking level in both arms (default lowest supported)
  --hosted-only      Exclude local inference from the foreground and workers
  --account-routing  Allow Pi to select workers from authenticated accounts
  --probe-worker REF   Explicitly request a worker pinned to this model (diagnostic)
  --candidate REF    Prefer this worker route with --account-routing (repeatable)
  --repetitions N    Matched pairs per case (default 1)
  --max-corrections N  Standard feedback turns after first submission (default 1)
  --timeout-ms N     Wall-clock limit per session (default 300000)
Without --run this prints the ordered plan without opening a provider session.`;

function integer(value, min, max, name) {
	const n = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max)
		throw new Error(`Invalid --${name} (expected ${min}–${max})`);
	return n;
}

async function main() {
	const { values } = parseArgs({
		options: {
			"hosted-only": { type: "boolean", default: false },
			"account-routing": { type: "boolean", default: false },
			"system-one": { type: "boolean", default: false },
			help: { type: "boolean" },
			run: { type: "boolean" },
			model: { type: "string" },
			thinking: { type: "string", default: "off" },
			out: { type: "string" },
			case: { type: "string", multiple: true, default: [] },
			"probe-worker": { type: "string" },
			candidate: { type: "string", multiple: true, default: [] },
			repetitions: { type: "string", default: "1" },
			"max-corrections": { type: "string", default: "1" },
			"timeout-ms": { type: "string", default: "300000" },
		},
	});
	if (values.help) return console.log(usage);
	for (const id of values.case) if (!cases.some((task) => task.id === id)) throw new Error(`Unknown case ${id}`);
	for (const ref of [
		...values.candidate,
		...(values["probe-worker"] === undefined ? [] : [values["probe-worker"]]),
		...(values.model === undefined ? [] : [values.model]),
	]) {
		if (!/^[^/\s]+\/[^\s]+$/.test(ref)) throw new Error("Expected provider/model for each model reference");
	}
	const selected = cases.filter((task) => !values.case.length || values.case.includes(task.id));
	const repetitions = integer(values.repetitions, 1, 100, "repetitions");
	if (values.candidate.length && !values["account-routing"]) throw new Error("--candidate requires --account-routing");
	if (!ORCHESTRATION_THINKING_LEVELS.includes(values.thinking)) throw new Error("Unknown thinking level");
	if (values["probe-worker"] && values["account-routing"])
		throw new Error("A pinned worker probe requires account routing off");
	const config = {
		probeWorker: values["probe-worker"],
		thinking: values.thinking,
		accountRouting: values["account-routing"],
		hostedOnly: values["hosted-only"],
		systemOne: values["system-one"],
		model: values.model ?? null,
		candidates: values.candidate,
		maxCorrections: integer(values["max-corrections"], 0, 5, "max-corrections"),
		timeoutMs: integer(values["timeout-ms"], 1, 2147483647, "timeout-ms"),
	};
	const trials = planTrials(selected, repetitions);
	const digest = createHash("sha256");
	for (const name of ["corpus.mjs", "../lib/live-native-driver.mjs", "../lib/fixture-module.mjs"])
		digest.update(readFileSync(new URL(name, import.meta.url)));
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	const manifest = {
		schemaVersion: 1,
		corpusVersion,
		corpusSha256: digest.digest("hex"),
		commit: git("rev-parse", "HEAD"),
		dirty: !!git("status", "--porcelain"),
		node: process.version,
		createdAt: new Date().toISOString(),
		config,
		cases: selected.map(({ id, kind, prompt }) => ({ id, kind, prompt })),
		trials,
	};
	if (!values.run) return console.log(JSON.stringify(manifest, null, 2));
	if (!config.model || !values.out) throw new Error("--run requires --model and --out");
	const out = resolve(values.out);
	const ownerDir = resolve(getAgentDir());
	if (isPathWithinScope(realPathIdentity(out), realPathIdentity(ownerDir))) {
		throw new Error(
			"Choose an output directory outside Pi’s private agent directory so the sessions can read their fixtures",
		);
	}
	mkdirSync(out, { mode: 0o700 });
	saveJson(join(out, "plan.json"), manifest);
	const rows = [];
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	const report = (active = null) => saveJson(join(out, "report.json"), { ...summarize(trials, rows), active });
	try {
		report();
		for (const trial of trials) {
			if (controller.signal.aborted) break;
			report(trial);
			const row = await supervise({
				config: { ...config, ...trial, ownerDir },
				task: selected.find((t) => t.id === trial.caseId),
				trialDir: join(out, trial.id),
				signal: controller.signal,
				checkpoint: report,
			});
			rows.push(row);
			report();
			console.log(
				`${trial.id}  ${row.status}  ${row.elapsedMs} ms  ${row.costUsd === null ? "unpriced" : row.costUsd + " USD"}`,
			);
		}
		console.log(JSON.stringify(summarize(trials, rows).arms, null, 2));
		console.log(join(out, "report.json"));
		process.exitCode = controller.signal.aborted ? 130 : rows.some((r) => r.status !== "accepted") ? 1 : 0;
	} finally {
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 2;
});
