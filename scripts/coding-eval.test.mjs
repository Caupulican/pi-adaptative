// Offline observations only. No provider credentials, network requests or model calls.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ENV_AGENT_DIR } from "../packages/coding-agent/src/config.ts";
import { planTrials, runGradedTask, summarize } from "./coding-eval/comparison.mjs";
import { cases, grade } from "./coding-eval/corpus.mjs";
import { seedWorkspace, supervise } from "./coding-eval/driver.mjs";

function temporary(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-coding-eval-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function fixture(t, id) {
	const task = cases.find((c) => c.id === id);
	const cwd = join(temporary(t), "work");
	seedWorkspace(cwd, task);
	return { task, cwd };
}

const diagnosis = '{"file":"src/options.ts","operator":"||","effectiveRetries":4,"replacement":"??"}';

test("single-file grade requires behavior and the requested documentation", (t) => {
	const { cwd, task } = fixture(t, "slugify");
	assert.ok(grade(task, cwd, "Done").length);
	const body = String.raw`export function slugify(text: string) { return text.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, "-"); }`;
	writeFileSync(join(cwd, "util.ts"), body);
	assert.ok(grade(task, cwd, "").length);
	writeFileSync(join(cwd, "util.ts"), "/** Slugify text. */\n" + body);
	assert.deepEqual(grade(task, cwd, ""), []);
	writeFileSync(join(cwd, "util.ts"), "/** Slugify text. */\n" + body.replace("/\\s+/g", "/\\s/g"));
	assert.ok(grade(task, cwd, "").length);
});

test("migration accepts semantic JSON, preserves zero and verifies the schema", (t) => {
	const { cwd, task } = fixture(t, "retry-migration");
	for (const name of Object.keys(task.files))
		writeFileSync(join(cwd, name), task.files[name].replaceAll('"retries"', '"maxRetries"'));
	const offline = join(cwd, "presets/offline.json");
	const original = readFileSync(offline, "utf8");
	writeFileSync(offline, original.replace('"maxRetries": 0', '"maxRetries": 3'));
	assert.match(grade(task, cwd, "accepted")[0], /offline/);
	writeFileSync(offline, original);
	assert.deepEqual(grade(task, cwd, ""), []);
	writeFileSync(join(cwd, "schema.json"), "{");
	assert.match(grade(task, cwd, "")[0], /schema/);
});

test("diagnosis requires the exact result and an unchanged checkout", (t) => {
	const { cwd, task } = fixture(t, "trace-override");
	assert.deepEqual(grade(task, cwd, diagnosis), []);
	assert.ok(grade(task, cwd, diagnosis.replace("4", "0")).length);
	writeFileSync(join(cwd, "src/job.ts"), "");
	assert.match(grade(task, cwd, diagnosis)[0], /unchanged/);
});

test("unexpected files and symlinked submissions fail grading", (t) => {
	const { cwd, task } = fixture(t, "slugify");
	const src = join(cwd, "util.ts");
	writeFileSync(join(cwd, "surprise"), "");
	assert.match(grade(task, cwd, "")[0], /unexpected/);
	rmSync(join(cwd, "surprise"));
	rmSync(src);
	symlinkSync(tmpdir(), src, "junction");
	assert.match(grade(task, cwd, "")[0], /unexpected/);
});

test("a false success claim gets one standardized correction, then an independent regrade", async (t) => {
	const { cwd, task } = fixture(t, "trace-override");
	const prompts = [];
	const observations = [];
	const result = await runGradedTask({
		task,
		turn(prompt) {
			prompts.push(prompt);
			return prompts.length === 1 ? "verified" : diagnosis;
		},
		assess: (answer) => grade(task, cwd, answer),
		maxCorrections: 1,
		observe: (data) => observations.push(data),
	});
	assert.equal(result, "accepted");
	assert.equal(prompts[0], task.prompt);
	assert.match(prompts[1], /Return the requested JSON/);
	assert.equal(observations.at(-1).corrections, 1);
	assert.deepEqual(observations.at(-1).submissions[1], { corrections: 1, findings: [] });
	assert.equal(observations.at(-1).submissions[0].findings.length, 1);
});

test("no correction budget preserves first-pass rejection; grader faults propagate", async () => {
	const input = { task: cases[0], turn: () => "success", assess: () => ["failed"], observe() {}, maxCorrections: 0 };
	assert.equal(await runGradedTask(input), "rejected");
	await assert.rejects(
		runGradedTask({
			...input,
			assess() {
				throw new Error("grader failure");
			},
		}),
		/grader failure/,
	);
});

test("order reverses for adjacent cases and within each repeated case", () => {
	const plan = planTrials(cases.slice(0, 3), 2);
	assert.equal(plan.length, 12);
	assert.equal(new Set(plan.map((p) => p.id)).size, 12);
	assert.deepEqual(
		plan.slice(0, 4).map((p) => p.arm),
		["direct", "auto", "auto", "direct"],
	);
	for (let i = 0; i < 6; i++) assert.notEqual(plan[i].arm, plan[i + 6].arm);
});

test("cost per acceptance charges failed work and withholds unknown or incomplete totals", () => {
	const plan = planTrials(cases.slice(0, 1), 2);
	const rows = plan.map((p) => ({
		...p,
		status: p.repetition === 1 ? "accepted" : "rejected",
		costUsd: p.repetition,
		elapsedMs: 20,
		corrections: p.repetition - 1,
		attempts: p.arm === "auto" ? [{ id: "worker" }] : [],
	}));
	const measured = summarize(plan, rows);
	assert.equal(measured.arms.direct.costUsdPerAccepted, 3);
	assert.equal(measured.arms.direct.elapsedMsPerAccepted, 40);
	assert.equal(measured.arms.auto.delegated, 2);
	assert.equal(measured.arms.direct.firstPass, 1);
	rows[2] = { ...rows[2], status: "timeout", costUsd: null };
	const partial = summarize(plan, rows.slice(0, 3));
	assert.equal(partial.complete, false);
	assert.equal(partial.arms.direct.pending, 1);
	assert.equal(partial.arms.direct.costUsdPerAccepted, null);
	assert.equal(partial.arms.auto.statusCounts.timeout, 1);
	assert.equal(partial.arms.auto.costUsdPerAccepted, null);
	assert.equal(partial.pairs.length, 1);
	assert.equal(summarize(plan, rows).pairs[1].costUsdDelta, null);
});

test("the external deadline retains checkpoints from a stalled synthetic session and invalidates its partial price", async (t) => {
	const dir = temporary(t);
	const entry = join(dir, "fake.mjs");
	writeFileSync(
		entry,
		"process.send({ costUsd: 0.12, recordedApiEquivalentUsd: 0.12, corrections: 1 }); setInterval(() => {}, 1000);",
	);
	const config = { ...planTrials(cases, 1)[0], timeoutMs: 1500 };
	const checkpoints = [];
	const row = await supervise({
		config,
		task: cases[0],
		trialDir: join(dir, "trial"),
		signal: new AbortController().signal,
		checkpoint: (r) => checkpoints.push(r),
		entry,
	});
	assert.equal(row.status, "timeout");
	assert.equal(row.costUsd, null);
	assert.equal(row.recordedApiEquivalentUsd, 0.12);
	assert.equal(row.corrections, 1);
	assert.equal(checkpoints.length, 1);
});

test("the normal command grades both SDK arms using an in-memory transport and retains model usage", async (t) => {
	const home = temporary(t);
	const mock = join(home, "transport.mjs");
	const out = join(home, "result");
	const owner = join(home, "credentials");
	mkdirSync(owner);
	const model = "offline-fixture";
	const fakeURL = "http://127.0.0.1:1/v1";
	writeFileSync(
		join(owner, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					baseUrl: fakeURL,
					apiKey: "fixture-only",
					models: [
						{
							id: model,
							reasoning: true,
							thinkingLevelMap: { off: null, minimal: null, low: "low" },
							cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	const chunk = {
		id: "fixture",
		object: "chat.completion.chunk",
		model,
		created: 1,
		choices: [{ index: 0, delta: { role: "assistant", content: diagnosis }, finish_reason: "stop" }],
		usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
	};
	const workerCall = {
		...chunk,
		choices: [
			{
				index: 0,
				delta: {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call_fixture",
							type: "function",
							function: {
								name: "delegate",
								arguments: JSON.stringify({
									action: "start",
									instructions: "Inspect the retry count and report the effective value of zero.",
								}),
							},
						},
					],
				},
				finish_reason: "tool_calls",
			},
		],
	};
	writeFileSync(
		mock,
		`let dispatched = false;
	globalThis.fetch = async (request, options) => {
		const url = typeof request === "string" ? request : request.url ?? String(request);
		if (url !== ${JSON.stringify(fakeURL + "/chat/completions")}) throw new Error("Offline fixture rejected fetch");
		const body = JSON.parse(options?.body ?? await request.text());
		const delegate = !dispatched && JSON.stringify(body.messages?.at(-1)).includes("A scheduled job configured") && body.tools?.some((tool) => tool.function?.name === "delegate");
		if (delegate) dispatched = true;
		const chunk = delegate ? ${JSON.stringify(workerCall)} : ${JSON.stringify(chunk)};
		return new Response("data: " + JSON.stringify(chunk) + "\\n\\ndata: [DONE]\\n\\n", { headers: { "Content-Type": "text/event-stream" } });
	};`,
	);
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		SystemRoot: process.env.SystemRoot,
		[ENV_AGENT_DIR]: owner,
		NODE_OPTIONS: "--import=" + pathToFileURL(mock).href,
	};
	const run = await promisify(execFile)(
		process.execPath,
		[
			"--conditions=pi-source",
			"scripts/coding-eval/cli.mjs",
			"--run",
			"--model",
			"fixture/" + model,
			"--case",
			"trace-override",
			"--timeout-ms",
			"90000",
			"--out",
			out,
		],
		{ env, timeout: 200000 },
	).catch((error) => error);
	const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
	assert.deepEqual(
		report.trials.map((r) => r.status),
		["accepted", "accepted"],
		JSON.stringify(report.trials),
	);
	assert.equal(run.code, undefined);
	assert.equal(report.trials[0].activeTools.includes("delegate"), false);
	assert.equal(report.trials[1].activeTools.includes("delegate"), true);
	const auto = report.trials[1];
	assert.equal(auto.settings.workerDelegation.modelPins.default.thinkingLevel, "low");
	assert.equal(auto.foreground.thinking, "low");
	assert.match(auto.settings.worktreeSync.gateCommand, /^git diff --check [a-f0-9]{40,64}$/u);
	assert.equal(report.arms.auto.delegated, 1, JSON.stringify(auto));
	assert.ok(
		auto.models.some((m) => m.role === "subagent" && m.tokens > 0),
		JSON.stringify(auto),
	);
	assert.ok(auto.costUsd > report.trials[0].costUsd, JSON.stringify(auto));
	// The scripted worker provides the answer without inspecting the file it was assigned.
	// Pi retains that failed worker verdict and its spend even though the root answer passes.
	assert.equal(auto.attempts[0].status, "failed");
	assert.equal(auto.outcomes[0].status, "failed");
	assert.equal(auto.workerSpend.acceptedTasks, 0);
	assert.ok(auto.workerSpend.recordedUsd > 0);
	assert.ok(Math.abs(auto.costUsd - auto.models.reduce((sum, m) => sum + m.costUsd, 0)) < 1e-10);
	assert.ok(report.trials.every((r) => r.models.some((m) => m.role === "root" && m.tokens > 0)));
	assert.ok(report.arms.direct.costUsdPerAccepted > 0);
});

test("cross-module repair requires adapters and reducer to agree across both replay orders", (t) => {
	const { cwd, task } = fixture(t, "event-adapters");
	for (const [name, fn, id, seq, status] of [
		["sources/build.ts", "buildEvent", "job", "attempt", 'e.ok ? "passed" : "failed"'],
		["sources/deploy.ts", "deployEvent", "target", "revision", "e.result"],
	])
		writeFileSync(
			join(cwd, name),
			`export const ${fn} = (e: any) => ({id:e.${id}, sequence:e.${seq}, status:${status}});`,
		);
	assert.match(grade(task, cwd, "")[0], /reducer/);
	writeFileSync(
		join(cwd, "state/latest.ts"),
		`export function latest(events: any[]) {
		const best = new Map(); for (const e of events) if (!best.has(e.id) || e.sequence > best.get(e.id).sequence) best.set(e.id, e);
		return Object.fromEntries([...best].map(([id,e]) => [id,e.status]));
	}`,
	);
	assert.deepEqual(grade(task, cwd, ""), []);
});

test("native file search loads without inspecting sockets and restores Node's setting on failure", async (t) => {
	if (process.platform !== "linux" || typeof process.report?.excludeNetwork !== "boolean") {
		t.skip("Node Linux network-report switch required");
		return;
	}
	const { loadAvailableFffNodePackage } = await import("../packages/coding-agent/src/utils/fff-node-install.ts");
	const original = process.report.excludeNetwork;
	const seen = [];
	try {
		for (const initial of [false, true]) {
			process.report.excludeNetwork = initial;
			const module = loadAvailableFffNodePackage([
				() => {
					seen.push(process.report.excludeNetwork);
					throw new Error("fixture load failure");
				},
				() => {
					seen.push(process.report.excludeNetwork);
					return "fixture module";
				},
			]);
			assert.equal(module, "fixture module");
			assert.equal(process.report.excludeNetwork, initial);
		}
		assert.deepEqual(seen, [true, true, true, true]);
	} finally {
		process.report.excludeNetwork = original;
	}
});

test("edit receipts expose a changed blank ending while preserving literal source", async () => {
	const { editEndingNotice } = await import("../packages/coding-agent/src/core/tools/edit-diff.ts");
	assert.match(editEndingNotice("before\n", "after\n\n"), /2 consecutive line breaks \(previously 1\)/);
	assert.match(editEndingNotice("before\n\n\n", "after\n\n"), /previously 3/);
	assert.equal(editEndingNotice("before\n", "after\n"), "");
	assert.equal(editEndingNotice("before\n\n", "after\n\n"), "");
});
