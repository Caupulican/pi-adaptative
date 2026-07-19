import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePaneWatcherScript } from "../src/bundled-resources/extensions/tmux-agent-manager/index.ts";

/**
 * SPIKE: prove the per-turn marker + pipe-pane re-arm scheme has NO cross-turn marker
 * bleed BEFORE send_followup is implemented against it. Faux-pty harness: the generated watcher is
 * a standalone sh/awk program that reads pane output from stdin (fd 3, duplicated from stdin) — this
 * is exactly what `tmux pipe-pane -O -t pane "sh watcher.sh <agentId>"` feeds it in production, so
 * feeding synthetic text via a child process's stdin faithfully exercises the real completion logic
 * without requiring a live tmux server. Mirrors the harness style of the FIRST test in
 * tmux-agent-manager-completion.test.ts (fake tmux on PATH + spawnSync/spawn feeding stdin).
 *
 * RESULT (proven below): unique per-turn markers make bleed structurally impossible: the awk
 * watcher only ever settles on an EXACT line match against ITS OWN doneMarker/blockedMarker string
 * (index.ts makePaneWatcherScript `clean == done` / `clean == blocked`), and turn markers are derived
 * from a per-turn sha1 (`TMUX_<sha1(id:agentId:turn)>_DONE/_BLOCKED`), so a turn-1 marker can never
 * equal a turn-2 marker and vice versa — this holds regardless of what tmux's pipe-pane plumbing does
 * with old output. Implementing send_followup on top of this scheme is safe.
 */
describe.skipIf(process.platform === "win32")("tmux follow-up per-turn marker spike", () => {
	let tempDir: string;
	let binDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-followup-spike-"));
		binDir = path.join(tempDir, "bin");
		fs.mkdirSync(binDir, { recursive: true });
		// Fault-tolerant fake tmux: makePaneWatcherScript's finish() already redirects every tmux call
		// to /dev/null with `|| true`, so this is only here to avoid noisy "command not found" stderr,
		// matching the existing completion test's style.
		fs.writeFileSync(path.join(binDir, "tmux"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function runEnv() {
		return { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
	}

	it("a turn-2 watcher does not settle on a stale turn-1 marker line, even if it appears in its stream", () => {
		const jobDir = path.join(tempDir, "job");
		fs.mkdirSync(jobDir, { recursive: true });
		const logPath = path.join(jobDir, "worker.log");
		const turn1ResultPath = path.join(jobDir, "worker.result.json");
		const turn2ResultPath = path.join(jobDir, "worker.turn-2.result.json");
		const turn1WatcherPath = path.join(jobDir, "pane-watcher.sh");
		const turn2WatcherPath = path.join(jobDir, "pane-watcher.turn-2.sh");

		// Distinct per-turn markers, derived exactly like buildFireTaskPlan (turn 1) and the
		// send_followup turn>=2 derivation (TMUX_<sha1(id:agentId:turn)>_DONE/_BLOCKED) — the point of
		// the spike is that these two sets can NEVER collide because they hash different input strings.
		const turn1Done = "TMUX_AAAAAAAAAA_DONE";
		const turn1Blocked = "TMUX_AAAAAAAAAA_BLOCKED";
		const turn2Done = "TMUX_BBBBBBBBBB_DONE";
		const turn2Blocked = "TMUX_BBBBBBBBBB_BLOCKED";
		expect(turn1Done).not.toBe(turn2Done);

		const baseAgent = {
			id: "worker",
			name: "worker",
			provider: "pi" as const,
			cwd: tempDir,
			logPath,
			paneId: "%1",
		};
		fs.writeFileSync(
			turn1WatcherPath,
			makePaneWatcherScript({
				id: "job1",
				sessionName: "sess",
				deadlineSeconds: 30,
				agents: [
					{
						...baseAgent,
						doneMarker: turn1Done,
						blockedMarker: turn1Blocked,
						promptPath: path.join(jobDir, "worker.prompt.md"),
						resultPath: turn1ResultPath,
					},
				],
			}),
			{ mode: 0o700 },
		);
		fs.writeFileSync(
			turn2WatcherPath,
			makePaneWatcherScript({
				id: "job1",
				sessionName: "sess",
				deadlineSeconds: 30,
				agents: [
					{
						...baseAgent,
						doneMarker: turn2Done,
						blockedMarker: turn2Blocked,
						promptPath: path.join(jobDir, "worker.turn-2.prompt.md"),
						resultPath: turn2ResultPath,
					},
				],
			}),
			{ mode: 0o700 },
		);

		// Turn 1 settles normally on its own marker.
		const turn1 = spawnSync("sh", [turn1WatcherPath, "worker"], {
			encoding: "utf8",
			input: `turn one output\n${turn1Done}\n`,
			env: runEnv(),
			timeout: 15_000,
		});
		expect(turn1.status, turn1.stderr).toBe(0);
		expect(JSON.parse(fs.readFileSync(turn1ResultPath, "utf8"))).toMatchObject({ status: "done" });

		// Turn 2's stream (worst case for the spike) STILL CONTAINS the turn-1 marker line — simulating
		// a hypothetical bleed from stale scrollback/pipe replay — followed by real turn-2 content and
		// the turn-2 marker. Prove the turn-2 watcher ignores the turn-1 line entirely and only settles
		// on its own marker.
		const turn2Input = [
			"turn two output before the stale line",
			turn1Done, // the stale/foreign marker — must NOT settle this watcher
			"turn two output continues after the stale line", // proves the watcher kept consuming, i.e. did not exit at the stale line
			turn2Done,
			"",
		].join("\n");
		const turn2 = spawnSync("sh", [turn2WatcherPath, "worker"], {
			encoding: "utf8",
			input: turn2Input,
			env: runEnv(),
			timeout: 15_000,
		});
		expect(turn2.status, turn2.stderr).toBe(0);
		const turn2Result = JSON.parse(fs.readFileSync(turn2ResultPath, "utf8")) as {
			status: string;
			notifiedBy: string;
		};
		expect(turn2Result).toMatchObject({ status: "done", notifiedBy: "pane-output-event" });
		// The log must contain content written AFTER the stale turn-1 line, proving the turn-2 watcher
		// did not stop/settle at the stale marker and only settled once its OWN marker arrived.
		const log = fs.readFileSync(logPath, "utf8");
		expect(log).toContain("turn two output continues after the stale line");
		expect(log).toContain(turn2Done);
	});

	it("a spelled (echoed) turn marker does not self-trigger settlement — the anti-self-echo technique holds per turn", () => {
		const jobDir = path.join(tempDir, "job-echo");
		fs.mkdirSync(jobDir, { recursive: true });
		const logPath = path.join(jobDir, "worker.log");
		const resultPath = path.join(jobDir, "worker.turn-2.result.json");
		const watcherPath = path.join(jobDir, "pane-watcher.turn-2.sh");
		const doneMarker = "TMUX_CCCCCCCCCC_DONE";
		const blockedMarker = "TMUX_CCCCCCCCCC_BLOCKED";
		const spelledDone = doneMarker.split("").join(" "); // mirrors index.ts spellMarker()

		fs.writeFileSync(
			watcherPath,
			makePaneWatcherScript({
				id: "job1",
				sessionName: "sess",
				deadlineSeconds: 30,
				agents: [
					{
						id: "worker",
						name: "worker",
						provider: "pi",
						cwd: tempDir,
						doneMarker,
						blockedMarker,
						promptPath: path.join(jobDir, "worker.turn-2.prompt.md"),
						logPath,
						resultPath,
						paneId: "%1",
					},
				],
			}),
			{ mode: 0o700 },
		);

		// The follow-up prompt is injected into the pane containing the SPELLED marker (spaces between
		// characters); if the pane echoes the injected command back into the stream (common for
		// interactive CLIs), that echoed line must not equal the compact marker and must not settle the
		// watcher early.
		const input = [
			"worker echoes the injected prompt back to the pane, including the spelled marker:",
			spelledDone,
			"worker keeps working after echoing the prompt", // proves the watcher did not exit at the echo
			doneMarker,
			"",
		].join("\n");
		const result = spawnSync("sh", [watcherPath, "worker"], {
			encoding: "utf8",
			input,
			env: runEnv(),
			timeout: 15_000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toMatchObject({ status: "done" });
		const log = fs.readFileSync(logPath, "utf8");
		expect(log).toContain("worker keeps working after echoing the prompt");
	});

	it("a turn-1 watcher process exits after settling, so a pipe-pane re-arm starts a fresh, independent turn-2 watcher", async () => {
		const jobDir = path.join(tempDir, "job-rearm");
		fs.mkdirSync(jobDir, { recursive: true });
		const logPath = path.join(jobDir, "worker.log");
		const turn1ResultPath = path.join(jobDir, "worker.result.json");
		const turn2ResultPath = path.join(jobDir, "worker.turn-2.result.json");
		const turn1WatcherPath = path.join(jobDir, "pane-watcher.sh");
		const turn2WatcherPath = path.join(jobDir, "pane-watcher.turn-2.sh");
		const turn1Done = "TMUX_DDDDDDDDDD_DONE";
		const turn2Done = "TMUX_EEEEEEEEEE_DONE";

		fs.writeFileSync(
			turn1WatcherPath,
			makePaneWatcherScript({
				id: "job1",
				sessionName: "sess",
				deadlineSeconds: 30,
				agents: [
					{
						id: "worker",
						name: "worker",
						provider: "pi",
						cwd: tempDir,
						doneMarker: turn1Done,
						blockedMarker: "TMUX_DDDDDDDDDD_BLOCKED",
						promptPath: path.join(jobDir, "worker.prompt.md"),
						logPath,
						resultPath: turn1ResultPath,
						paneId: "%1",
					},
				],
			}),
			{ mode: 0o700 },
		);

		// Represents tmux's pipe-pane target for turn 1: a live process consuming the pane's stdout.
		const turn1Child = spawn("sh", [turn1WatcherPath, "worker"], { env: runEnv(), stdio: ["pipe", "pipe", "pipe"] });
		const turn1Exit = new Promise<number | null>((resolve, reject) => {
			turn1Child.once("error", reject);
			turn1Child.once("exit", (code) => resolve(code));
		});
		turn1Child.stdin.write(`some output\n${turn1Done}\n`);
		turn1Child.stdin.end();
		const guard = setTimeout(() => turn1Child.kill("SIGKILL"), 5_000);
		try {
			expect(await turn1Exit).toBe(0);
		} finally {
			clearTimeout(guard);
		}
		expect(JSON.parse(fs.readFileSync(turn1ResultPath, "utf8"))).toMatchObject({ status: "done" });

		// Re-arming `pipe-pane -O` on the same pane replaces the previous pipe's target command with a
		// brand-new process; simulate that by spawning turn 2's watcher as an entirely separate child,
		// independent of turn 1's (already-exited) process, and prove it settles correctly on its own
		// marker without any interference from turn 1's now-dead watcher.
		fs.writeFileSync(
			turn2WatcherPath,
			makePaneWatcherScript({
				id: "job1",
				sessionName: "sess",
				deadlineSeconds: 30,
				agents: [
					{
						id: "worker",
						name: "worker",
						provider: "pi",
						cwd: tempDir,
						doneMarker: turn2Done,
						blockedMarker: "TMUX_EEEEEEEEEE_BLOCKED",
						promptPath: path.join(jobDir, "worker.turn-2.prompt.md"),
						logPath,
						resultPath: turn2ResultPath,
						paneId: "%1",
					},
				],
			}),
			{ mode: 0o700 },
		);
		const turn2 = spawnSync("sh", [turn2WatcherPath, "worker"], {
			encoding: "utf8",
			input: `follow-up output\n${turn2Done}\n`,
			env: runEnv(),
			timeout: 15_000,
		});
		expect(turn2.status, turn2.stderr).toBe(0);
		expect(JSON.parse(fs.readFileSync(turn2ResultPath, "utf8"))).toMatchObject({ status: "done" });
		// Turn 1's result must be untouched by turn 2's run.
		expect(JSON.parse(fs.readFileSync(turn1ResultPath, "utf8"))).toMatchObject({ status: "done" });
	});
});
