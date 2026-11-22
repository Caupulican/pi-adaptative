// Offline plan by default. Paid execution requires an explicit run and a fresh private output directory.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isPathWithinScope, realPathIdentity } from "../../packages/coding-agent/src/core/autonomy/path-scope.ts";
import { ORCHESTRATION_THINKING_LEVELS } from "../../packages/coding-agent/src/core/orchestration/contracts.ts";
import { MAX_ACTIVE_SKILL_BODY_BYTES, validateSkillName } from "../../packages/coding-agent/src/core/skills.ts";
import { getDirectoryResourceProfileInfo } from "../../packages/coding-agent/src/core/settings/settings-rules.ts";
import { readBoundedTextFileSync } from "../../packages/coding-agent/src/core/util/bounded-file.ts";
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";
import {
	recordSkillComparison,
	skillBodyDigest,
} from "../../packages/coding-agent/src/core/learning/skill-comparison.ts";
import { planTrials, summarize } from "./comparison.mjs";
import { cases, corpusVersion, skillSafetyCase } from "./corpus.mjs";
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
  --skill-name NAME --baseline-skill FILE --candidate-skill FILE
                     Compare two Markdown skill bodies with foreground-only tools
  --project PATH     Project scope for a skill comparison (default invocation cwd)
Without --run this prints the ordered plan without opening a provider session.`;

function integer(value, min, max, name) {
	const n = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max)
		throw new Error(`Invalid --${name} (expected ${min}–${max})`);
	return n;
}

function measuredSourceDigest() {
	const paths = execFileSync("git", [
		"ls-files", "-z", "--cached", "--others", "--deduplicate", "--exclude-standard", "--",
		":(glob)packages/*/src/**", ":(glob)packages/*/package.json", "vendor", "package.json", "package-lock.json",
		"scripts/coding-eval", "scripts/lib/fixture-module.mjs", "scripts/lib/live-native-driver.mjs", "scripts/lib/live-session-observer.mjs",
	], {cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024}).split("\0").filter(Boolean).sort();
	const digest = createHash("sha256");
	for (const path of paths) {
		const name = join(root, path);
		const stat = lstatSync(name, {throwIfNoEntry: false});
		if (!stat) continue;
		if (!stat.isSymbolicLink() && !stat.isFile()) throw new Error(`Cannot fingerprint evaluation source ${path}`);
		const bytes = stat.isSymbolicLink() ? readlinkSync(name, {encoding: "buffer"}) : readFileSync(name);
		const kind = stat.isSymbolicLink() ? "link" : "file";
		digest.update(JSON.stringify([path, kind, createHash("sha256").update(bytes).digest("hex")])).update("\n");
	}
	return digest.digest("hex");
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
			"skill-name": { type: "string" },
			"baseline-skill": { type: "string" },
			"candidate-skill": { type: "string" },
			project: { type: "string" },
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
	const skillMode = [values["skill-name"], values["baseline-skill"], values["candidate-skill"]].some(
		(value) => value !== undefined,
	);
	let skillBodies;
	const project = realPathIdentity(resolve(values.project ?? process.cwd()));
	if (skillMode) {
		if (!values["skill-name"] || !values["baseline-skill"] || !values["candidate-skill"])
			throw new Error("Skill comparison requires --skill-name, --baseline-skill and --candidate-skill");
		if (validateSkillName(values["skill-name"]).length) throw new Error("Invalid skill name");
		if (!lstatSync(project).isDirectory()) throw new Error("Project scope must be a directory");
		if (values["probe-worker"] || values["account-routing"] || values.candidate.length || values["system-one"])
			throw new Error("Skill comparisons require identical foreground-only execution without automatic routing");
		skillBodies = Object.fromEntries(
			["baseline", "candidate"].map((arm) => {
				const path = resolve(values[`${arm}-skill`]);
				const body = readBoundedTextFileSync(path, MAX_ACTIVE_SKILL_BODY_BYTES, "Evaluation skill body").trim();
				if (!body || body.includes("\0")) throw new Error("Skill body must be nonempty Markdown text");
				return [arm, body];
			}),
		);
		if (skillBodyDigest(skillBodies.baseline) === skillBodyDigest(skillBodies.candidate))
			throw new Error("Baseline and candidate skill bodies must differ");
	} else if (values.project) throw new Error("--project requires a skill comparison");
	if (skillMode) selected.push(skillSafetyCase);
	if (values.candidate.length && !values["account-routing"]) throw new Error("--candidate requires --account-routing");
	if (!ORCHESTRATION_THINKING_LEVELS.includes(values.thinking)) throw new Error("Unknown thinking level");
	if (values["probe-worker"] && values["account-routing"])
		throw new Error("A pinned worker probe requires account routing off");
	const config = {
		probeWorker: values["probe-worker"],
		thinking: values.thinking,
		accountRouting: values["account-routing"],
		hostedOnly: skillMode || values["hosted-only"],
		systemOne: values["system-one"],
		model: values.model ?? null,
		candidates: values.candidate,
		maxCorrections: integer(values["max-corrections"], 0, 5, "max-corrections"),
		timeoutMs: integer(values["timeout-ms"], 1, 2147483647, "timeout-ms"),
		...(skillMode ? { skillName: values["skill-name"], skillMode: true } : {}),
	};
	const trials = planTrials(selected, repetitions, skillMode ? ["baseline", "candidate"] : undefined);
	const digest = createHash("sha256");
	for (const name of ["corpus.mjs", "../lib/live-native-driver.mjs", "../lib/fixture-module.mjs"])
		digest.update(readFileSync(new URL(name, import.meta.url)));
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	const sourceSha256 = measuredSourceDigest();
	const manifest = {
		sourceSha256,
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
		...(skillMode
			? {
					studyId: randomUUID(),
					projectHash: getDirectoryResourceProfileInfo(project).hash,
					baselineDigest: skillBodyDigest(skillBodies.baseline),
					candidateDigest: skillBodyDigest(skillBodies.candidate),
				}
			: {}),
	};
	if (!values.run) return console.log(JSON.stringify(manifest, null, 2));
	if (!config.model || !values.out) throw new Error("--run requires --model and --out");
	const out = resolve(values.out);
	if (skillMode) {
		let parent = out;
		while (!existsSync(parent)) parent = dirname(parent);
		let repository;
		try {
			repository = execFileSync("git", ["-C", parent, "rev-parse", "--show-toplevel"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			/* Outside a repository. */
		}
		if (repository) throw new Error("Private skill evaluation output must be outside Git working trees");
	}
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
	let finalSourceSha256 = null;
	let skillComparison = skillMode ? { status: "pending" } : undefined;
	const report = (active = null) =>
		saveJson(join(out, "report.json"), {
			...summarize(trials, rows),
			active,
			sourceSha256,
			finalSourceSha256,
			...(skillComparison ? { skillComparison } : {}),
		});
	try {
		report();
		for (const trial of trials) {
			if (controller.signal.aborted) break;
			report(trial);
			const row = await supervise({
				config: { ...config, ...trial, ownerDir, ...(skillMode ? { skillBody: skillBodies[trial.arm] } : {}) },
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
		finalSourceSha256 = measuredSourceDigest();
		report();
		if (finalSourceSha256 !== sourceSha256)
			throw new Error("Evaluation source changed during the study. Run results span different source trees.");
		const effectiveThinking = rows[0]?.foreground?.thinking;
		const completeSkillEvidence =
			ORCHESTRATION_THINKING_LEVELS.includes(effectiveThinking) &&
			rows.length === trials.length &&
			rows.every(
				(row) =>
					["accepted", "rejected"].includes(row.status) &&
					row.skillApplied === true &&
					row.foreground?.thinking === effectiveThinking &&
					[ row.foreground?.provider, row.foreground?.model ].join("/") === config.model &&
					row.skillDigest === manifest[`${row.arm}Digest`] &&
					Number.isSafeInteger(row.tokens) &&
					row.tokens > 0 &&
					!row.attempts?.length,
			);
		if (skillMode && completeSkillEvidence) {
			const pairs = trials
				.filter((trial) => trial.arm === "baseline")
				.map((trial) => {
					const reading = (arm) => {
						const row = rows.find(
							(item) => item.caseId === trial.caseId && item.repetition === trial.repetition && item.arm === arm,
						);
						return { passed: row.status === "accepted", corrections: row.corrections, tokens: row.tokens };
					};
					return {
						caseId: trial.caseId,
						repetition: trial.repetition,
						baseline: reading("baseline"),
						candidate: reading("candidate"),
					};
				});
			const receipt = recordSkillComparison(ownerDir, project, {
				studyId: manifest.studyId,
				skill: config.skillName,
				model: config.model,
				thinkingLevel: effectiveThinking,
				baselineDigest: manifest.baselineDigest,
				candidateDigest: manifest.candidateDigest,
				corpusDigest: manifest.corpusSha256,
				sourceDigest: sourceSha256,
				completedAt: new Date().toISOString(),
				pairs,
			});
			saveJson(join(out, "receipt.json"), receipt);
			skillComparison = { status: "recorded", receipt };
		} else if (skillMode) {
			skillComparison = {
				status: "inconclusive",
				reason:
					"Every planned arm must finish grading with the selected body present, positive settled token usage, and no worker attempts.",
			};
		}
		report();
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
