import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendRunRecord,
	cleanupImprovementSandbox,
	computeMadConfidence,
	createImprovementLoopTool,
	createImprovementSandbox,
	decideImprovement,
	exportImprovementSandboxPatch,
	type ImprovementRunRecord,
	initImprovementLoop,
	metricMapFromOutput,
	parseGitPorcelainStatus,
	parseMetricLines,
	planOwnedDiscard,
	readImprovementLoopState,
	readRunRecords,
	recordImprovementRun,
	runImprovementMeasurement,
	selectPrimaryMetric,
} from "../src/core/improvement-loop.ts";

let tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-improvement-loop-"));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createTempGitRepo(): Promise<string> {
	const repo = join(await tempDir(), "repo");
	await mkdir(repo, { recursive: true });
	git(repo, ["init"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test User"]);
	await writeFile(join(repo, "file.txt"), "one\n");
	git(repo, ["add", "file.txt"]);
	git(repo, ["commit", "-m", "initial"]);
	return repo;
}

afterEach(async () => {
	await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	tempDirs = [];
});

describe("improvement-loop metrics", () => {
	it("parses decimal METRIC lines and rejects unsafe or non-decimal values", () => {
		const parsed = parseMetricLines(
			[
				"noise",
				"METRIC total_ms=12.5",
				"METRIC total_ms=11.75",
				"METRIC render.µs=1.25e3",
				"METRIC __proto__=1",
				"METRIC constructor=2",
				"METRIC hex=0x10",
				"METRIC nan=NaN",
				"METRIC inf=Infinity",
				"METRIC bad-name!=5",
			].join("\n"),
		);

		expect(Object.fromEntries(parsed)).toEqual({ total_ms: 11.75, "render.µs": 1250 });
	});

	it("selects the configured primary metric", () => {
		const metrics = metricMapFromOutput("METRIC total_ms=9\nMETRIC secondary=3");
		expect(selectPrimaryMetric(metrics, "total_ms")).toBe(9);
		expect(selectPrimaryMetric(metrics, "missing")).toBeNull();
	});
});

describe("improvement-loop decision engine", () => {
	it("keeps the first valid metric as the baseline", () => {
		expect(decideImprovement({ currentMetric: 100, checksPass: true }).decision).toBe("keep");
		expect(decideImprovement({ currentMetric: 100, checksPass: true }).reason).toBe("baseline");
	});

	it("keeps lower-is-better and higher-is-better metric wins", () => {
		expect(decideImprovement({ currentMetric: 90, bestMetric: 100, direction: "lower" }).decision).toBe("keep");
		expect(decideImprovement({ currentMetric: 110, bestMetric: 100, direction: "higher" }).decision).toBe("keep");
	});

	it("discards equal or worse metrics", () => {
		expect(decideImprovement({ currentMetric: 100, bestMetric: 100, direction: "lower" })).toMatchObject({
			decision: "discard",
			reason: "not_better_than_best",
		});
		expect(decideImprovement({ currentMetric: 101, bestMetric: 100, direction: "lower" })).toMatchObject({
			decision: "discard",
			reason: "not_better_than_best",
		});
	});

	it("lets correctness failures override metric wins", () => {
		expect(decideImprovement({ currentMetric: 50, bestMetric: 100, checksPass: false })).toMatchObject({
			decision: "discard",
			reason: "checks_failed",
		});
	});

	it("blocks missing or invalid metrics", () => {
		expect(decideImprovement({ currentMetric: null })).toMatchObject({
			decision: "blocked",
			reason: "metric_missing",
		});
		expect(decideImprovement({ currentMetric: Number.NaN })).toMatchObject({
			decision: "blocked",
			reason: "metric_invalid",
		});
	});

	it("rejects wins below absolute or relative thresholds", () => {
		expect(decideImprovement({ currentMetric: 99.8, bestMetric: 100, minDelta: 1 })).toMatchObject({
			decision: "discard",
			reason: "below_min_delta",
		});
		expect(decideImprovement({ currentMetric: 99.5, bestMetric: 100, minRelativeDelta: 0.01 })).toMatchObject({
			decision: "discard",
			reason: "below_min_relative_delta",
		});
	});

	it("uses MAD confidence to keep strong wins and retry noisy weak wins", () => {
		const strong = decideImprovement({
			currentMetric: 90,
			bestMetric: 100,
			minConfidence: 2,
			confidenceMode: "mad",
			noiseMetrics: [100, 101, 99],
		});
		expect(strong.decision).toBe("keep");
		expect(strong.confidence.value).toBeGreaterThanOrEqual(2);

		const weak = decideImprovement({
			currentMetric: 99.5,
			bestMetric: 100,
			minConfidence: 2,
			confidenceMode: "mad",
			noiseMetrics: [100, 101, 99],
		});
		expect(weak).toMatchObject({ decision: "retry", reason: "below_confidence" });
	});

	it("reports insufficient noise evidence when confidence is required", () => {
		expect(
			decideImprovement({
				currentMetric: 90,
				bestMetric: 100,
				minConfidence: 2,
				confidenceMode: "mad",
				noiseMetrics: [100],
			}),
		).toMatchObject({ decision: "retry", reason: "insufficient_noise_evidence" });
	});

	it("computes MAD confidence directly", () => {
		const confidence = computeMadConfidence(10, [100, 101, 99, 90]);
		expect(confidence.mode).toBe("mad");
		expect(confidence.value).toBeGreaterThan(1);
	});
});

describe("improvement-loop append-only log", () => {
	it("appends and reads JSONL run records", async () => {
		const dir = await tempDir();
		const logPath = join(dir, "runs", "log.jsonl");
		const record: ImprovementRunRecord = {
			runId: "1",
			metricName: "total_ms",
			direction: "lower",
			metric: 90,
			checksPass: true,
			decision: "keep",
			reason: "metric_improved",
			timestamp: 123,
		};

		await appendRunRecord(logPath, record);
		await appendRunRecord(logPath, { ...record, runId: "2", decision: "discard", reason: "not_better_than_best" });

		expect(await readRunRecords(logPath)).toEqual([
			record,
			{ ...record, runId: "2", decision: "discard", reason: "not_better_than_best" },
		]);
	});
});

describe("improvement-loop persistent state", () => {
	it("initializes, records, reconstructs, and tracks best kept metric in user-level state", async () => {
		const dir = await tempDir();
		const cwd = join(dir, "repo");
		const agentDir = join(dir, "agent");

		const initial = await initImprovementLoop({
			cwd,
			agentDir,
			loopId: "Speed Loop!",
			objective: "speed up benchmark",
			metricName: "total_ms",
			direction: "lower",
			minDelta: 1,
		});

		expect(initial.config.loopId).toBe("Speed-Loop");
		expect(initial.logPath).toContain(agentDir);
		expect(initial.runs).toHaveLength(0);

		const baseline = await recordImprovementRun({
			cwd,
			agentDir,
			loopId: "Speed Loop!",
			metric: 100,
			checksPass: true,
		});
		expect(baseline.lastDecision).toMatchObject({ decision: "keep", reason: "baseline" });
		expect(baseline.baselineMetric).toBe(100);
		expect(baseline.bestMetric).toBe(100);

		const worse = await recordImprovementRun({ cwd, agentDir, loopId: "Speed Loop!", metric: 101, checksPass: true });
		expect(worse.lastDecision).toMatchObject({ decision: "discard", reason: "not_better_than_best" });
		expect(worse.bestMetric).toBe(100);

		const better = await recordImprovementRun({ cwd, agentDir, loopId: "Speed Loop!", metric: 90, checksPass: true });
		expect(better.lastDecision).toMatchObject({ decision: "keep", reason: "metric_improved" });
		expect(better.bestMetric).toBe(90);
		expect(better.bestRunId).toBe(3);

		const reconstructed = await readImprovementLoopState({ cwd, agentDir, loopId: "Speed Loop!" });
		expect(reconstructed?.runs.map((run) => run.decision)).toEqual(["keep", "discard", "keep"]);
		expect(reconstructed?.bestMetric).toBe(90);
	});

	it("refuses to replace existing loop state unless reset is explicit", async () => {
		const dir = await tempDir();
		const cwd = join(dir, "repo");
		const agentDir = join(dir, "agent");
		const init = { cwd, agentDir, objective: "speed", metricName: "ms" };

		await initImprovementLoop(init);
		await expect(initImprovementLoop(init)).rejects.toThrow(/already exists/);
		await expect(initImprovementLoop({ ...init, reset: true })).resolves.toMatchObject({ runs: [] });
	});

	it("exposes a full init/status/record tool without writing state into the repo", async () => {
		const dir = await tempDir();
		const cwd = join(dir, "repo");
		const agentDir = join(dir, "agent");
		const envKey = "PI-ADAPTATIVE_CODING_AGENT_DIR";
		const previous = process.env[envKey];
		process.env[envKey] = agentDir;
		try {
			const tool = createImprovementLoopTool();
			const ctx = { cwd } as any;

			const init = await tool.execute(
				"init",
				{ action: "init", objective: "speed", metricName: "ms", reset: true },
				undefined,
				undefined,
				ctx,
			);
			expect(init.details.state?.logPath).toContain(agentDir);

			const record = await tool.execute(
				"record",
				{ action: "record", currentMetric: 10, checksPass: true },
				undefined,
				undefined,
				ctx,
			);
			expect(record.details.decision).toMatchObject({ decision: "keep", reason: "baseline" });

			const status = await tool.execute("status", { action: "status" }, undefined, undefined, ctx);
			expect(status.details.state?.runs).toHaveLength(1);
			expect(status.details.logPath.startsWith(cwd)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env[envKey];
			else process.env[envKey] = previous;
		}
	});
});

describe("improvement-loop measurement runner", () => {
	it("runs a measurement command, parses primary/secondary metrics, and runs checks", async () => {
		const calls: string[] = [];
		const measurement = await runImprovementMeasurement({
			cwd: "/tmp/work",
			command: "bench",
			checksCommand: "check",
			metricName: "total_ms",
			exec: async (_command, args) => {
				const script = args[1];
				calls.push(script);
				if (script === "bench") {
					return {
						stdout: "METRIC total_ms=9\nMETRIC render_ms=4\n",
						stderr: "",
						code: 0,
						killed: false,
					};
				}
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			},
		});

		expect(calls).toEqual(["bench", "check"]);
		expect(measurement.primaryMetric).toBe(9);
		expect(measurement.parsedMetrics).toEqual({ total_ms: 9, render_ms: 4 });
		expect(measurement.checksPass).toBe(true);
	});

	it("records action=measure through the loop tool and lets failed checks override metric wins", async () => {
		const dir = await tempDir();
		const cwd = join(dir, "repo");
		const agentDir = join(dir, "agent");
		const envKey = "PI-ADAPTATIVE_CODING_AGENT_DIR";
		const previous = process.env[envKey];
		process.env[envKey] = agentDir;
		try {
			let benchValue = 100;
			let checksPass = true;
			const tool = createImprovementLoopTool(async (_command, args) => {
				const script = args[1];
				if (script === "bench") {
					return { stdout: `METRIC ms=${benchValue}\n`, stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: checksPass ? "" : "failed", code: checksPass ? 0 : 1, killed: false };
			});
			const ctx = { cwd } as any;

			await tool.execute(
				"init",
				{ action: "init", objective: "speed", metricName: "ms", reset: true },
				undefined,
				undefined,
				ctx,
			);

			const baseline = await tool.execute(
				"measure",
				{ action: "measure", command: "bench", checksCommand: "check" },
				undefined,
				undefined,
				ctx,
			);
			expect(baseline.details.decision).toMatchObject({ decision: "keep", reason: "baseline" });

			benchValue = 90;
			checksPass = false;
			const failedChecks = await tool.execute(
				"measure",
				{ action: "measure", command: "bench", checksCommand: "check" },
				undefined,
				undefined,
				ctx,
			);
			expect(failedChecks.details.measurement?.primaryMetric).toBe(90);
			expect(failedChecks.details.decision).toMatchObject({ decision: "discard", reason: "checks_failed" });
			expect(failedChecks.details.state?.bestMetric).toBe(100);
		} finally {
			if (previous === undefined) delete process.env[envKey];
			else process.env[envKey] = previous;
		}
	});
});

describe("improvement-loop disposable git sandbox", () => {
	it("creates and cleans a real git worktree sandbox under user-level state", async () => {
		const repo = await createTempGitRepo();
		const agentDir = join(await tempDir(), "agent");
		await initImprovementLoop({ cwd: repo, agentDir, objective: "speed", metricName: "ms", reset: true });
		const exec = async (command: string, args: string[], options?: { cwd?: string }) => {
			try {
				const stdout = execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
				return { stdout, stderr: "", code: 0, killed: false };
			} catch (error) {
				const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
				return {
					stdout: err.stdout?.toString() ?? "",
					stderr: err.stderr?.toString() ?? "",
					code: err.status ?? 1,
					killed: false,
				};
			}
		};

		const created = await createImprovementSandbox({ cwd: repo, agentDir, exec, sandboxId: "trial" });
		expect(created.activeSandbox?.sandboxId).toBe("trial");
		expect(created.activeSandbox?.worktreePath).toContain(agentDir);
		expect(git(repo, ["worktree", "list"])).toContain(created.activeSandbox?.worktreePath);

		const cleaned = await cleanupImprovementSandbox({ cwd: repo, agentDir, exec, reason: "discard" });
		expect(cleaned.activeSandbox).toBeNull();
		expect(cleaned.sandboxes.at(-1)?.status).toBe("cleaned");
		expect(git(repo, ["worktree", "list"])).not.toContain(created.activeSandbox?.worktreePath);
	});

	it("exports a keep patch from sandbox before cleanup", async () => {
		const repo = await createTempGitRepo();
		const agentDir = join(await tempDir(), "agent");
		await initImprovementLoop({ cwd: repo, agentDir, objective: "speed", metricName: "ms", reset: true });
		const exec = async (command: string, args: string[], options?: { cwd?: string }) => {
			try {
				return {
					stdout: execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8" }),
					stderr: "",
					code: 0,
					killed: false,
				};
			} catch (error) {
				const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
				return {
					stdout: err.stdout?.toString() ?? "",
					stderr: err.stderr?.toString() ?? "",
					code: err.status ?? 1,
					killed: false,
				};
			}
		};

		const created = await createImprovementSandbox({ cwd: repo, agentDir, exec, sandboxId: "keep" });
		await writeFile(join(created.activeSandbox!.worktreePath, "file.txt"), "two\n");
		const exported = await exportImprovementSandboxPatch({ cwd: repo, agentDir, exec });
		expect(exported.activeSandbox?.patchPath).toContain(agentDir);
		expect(await readFile(exported.activeSandbox!.patchPath!, "utf8")).toContain("+two");

		const cleaned = await cleanupImprovementSandbox({ cwd: repo, agentDir, exec, reason: "after export" });
		expect(cleaned.sandboxes.at(-1)?.patchPath).toBe(exported.activeSandbox?.patchPath);
		expect(git(repo, ["status", "--porcelain"]).trim()).toBe("");
	});

	it("blocks sandbox creation from a dirty real repo unless explicitly allowed", async () => {
		const repo = await createTempGitRepo();
		const agentDir = join(await tempDir(), "agent");
		await writeFile(join(repo, "file.txt"), "dirty\n");
		await initImprovementLoop({ cwd: repo, agentDir, objective: "speed", metricName: "ms", reset: true });
		const exec = async (command: string, args: string[], options?: { cwd?: string }) => {
			try {
				return {
					stdout: execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8" }),
					stderr: "",
					code: 0,
					killed: false,
				};
			} catch (error) {
				const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
				return {
					stdout: err.stdout?.toString() ?? "",
					stderr: err.stderr?.toString() ?? "",
					code: err.status ?? 1,
					killed: false,
				};
			}
		};

		await expect(createImprovementSandbox({ cwd: repo, agentDir, exec, sandboxId: "dirty" })).rejects.toThrow(
			/dirty repository/,
		);
		const created = await createImprovementSandbox({
			cwd: repo,
			agentDir,
			exec,
			sandboxId: "dirty",
			allowDirtyRepo: true,
		});
		expect(created.activeSandbox?.sandboxId).toBe("dirty");
		await cleanupImprovementSandbox({ cwd: repo, agentDir, exec });
	});

	it("exposes sandbox lifecycle through the improvement_loop tool", async () => {
		const repo = await createTempGitRepo();
		const agentDir = join(await tempDir(), "agent");
		const envKey = "PI-ADAPTATIVE_CODING_AGENT_DIR";
		const previous = process.env[envKey];
		process.env[envKey] = agentDir;
		try {
			const exec = async (command: string, args: string[], options?: { cwd?: string }) => {
				try {
					return {
						stdout: execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8" }),
						stderr: "",
						code: 0,
						killed: false,
					};
				} catch (error) {
					const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
					return {
						stdout: err.stdout?.toString() ?? "",
						stderr: err.stderr?.toString() ?? "",
						code: err.status ?? 1,
						killed: false,
					};
				}
			};
			const tool = createImprovementLoopTool(exec);
			const ctx = { cwd: repo } as any;
			await tool.execute(
				"init",
				{ action: "init", objective: "speed", metricName: "ms", reset: true },
				undefined,
				undefined,
				ctx,
			);
			const created = await tool.execute(
				"sandbox",
				{ action: "sandbox_create", sandboxId: "tool" },
				undefined,
				undefined,
				ctx,
			);
			expect(created.details.sandbox?.status).toBe("active");
			expect(created.details.state?.activeSandbox?.sandboxId).toBe("tool");
			await writeFile(join(created.details.sandbox!.worktreePath, "file.txt"), "tool-change\n");
			const measured = await tool.execute(
				"measure",
				{ action: "measure", command: "test -f file.txt && printf 'METRIC ms=1\\n'", useSandbox: true },
				undefined,
				undefined,
				ctx,
			);
			expect(measured.details.decision).toMatchObject({ decision: "keep", reason: "baseline" });
			const exported = await tool.execute("export", { action: "sandbox_export" }, undefined, undefined, ctx);
			expect(exported.details.sandbox?.patchPath).toContain(agentDir);
			const cleaned = await tool.execute(
				"cleanup",
				{ action: "sandbox_cleanup", cleanupReason: "done" },
				undefined,
				undefined,
				ctx,
			);
			expect(cleaned.details.state?.activeSandbox).toBeNull();
			expect(cleaned.details.sandbox?.status).toBe("cleaned");
		} finally {
			if (previous === undefined) delete process.env[envKey];
			else process.env[envKey] = previous;
		}
	});
});

describe("improvement-loop owned discard planning", () => {
	it("plans owned reverts while preserving logs and user-dirty files", () => {
		const before = " M user.txt\n?? scratch.txt";
		const after = [
			" M user.txt",
			" M owned.ts",
			"?? new-owned.ts",
			" M other.ts",
			" M .pi/improvement-loop/log.jsonl",
		].join("\n");

		const plan = planOwnedDiscard({
			beforeStatus: before,
			afterStatus: after,
			ownedPaths: ["user.txt", "owned.ts", "new-owned.ts"],
			preservePaths: [".pi"],
		});

		expect(plan.revertPaths).toEqual(["new-owned.ts", "owned.ts"]);
		expect(plan.protectedUserDirtyPaths).toEqual(["user.txt"]);
		expect(plan.preservePaths).toEqual([".pi/improvement-loop/log.jsonl"]);
		expect(plan.unownedChangedPaths).toEqual(["other.ts"]);
		expect(plan.canDiscardOwnedChanges).toBe(false);
	});

	it("parses porcelain rename entries", () => {
		expect(parseGitPorcelainStatus("R  old.ts -> new.ts")).toEqual([
			{ index: "R", workingTree: " ", origPath: "old.ts", path: "new.ts" },
		]);
	});
});
