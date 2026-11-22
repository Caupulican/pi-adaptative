// Prepare independent repositories and supervise each session outside its own event loop.
import { execFileSync, fork } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../../packages/coding-agent/src/config.ts";
import { killTreeNow } from "../../packages/coding-agent/src/kernel/reliability/process-tree.ts";
import { grade } from "./corpus.mjs";

export function saveJson(path, data) {
	writeFileSync(path + ".tmp", JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
	renameSync(path + ".tmp", path);
}

function fixtureEnvironment(cwd) {
	return {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: resolve(cwd, ".git", "fixture.gitconfig"),
		GIT_AUTHOR_NAME: "Pi Evaluation",
		GIT_COMMITTER_NAME: "Pi Evaluation",
		GIT_AUTHOR_EMAIL: "pi@localhost",
		GIT_COMMITTER_EMAIL: "pi@localhost",
	};
}

export function seedWorkspace(cwd, task) {
	mkdirSync(cwd, { mode: 0o700 });
	for (const [name, contents] of Object.entries(task.files)) {
		mkdirSync(dirname(join(cwd, name)), { recursive: true });
		writeFileSync(join(cwd, name), contents);
	}
	const env = fixtureEnvironment(cwd);
	// Native Git reads this ordinary empty file on every platform. An empty template and
	// isolated configuration leave the new repository with no hooks or global signing policy.
	mkdirSync(dirname(env.GIT_CONFIG_GLOBAL), { mode: 0o700 });
	writeFileSync(env.GIT_CONFIG_GLOBAL, "", { mode: 0o600, flag: "wx" });
	Object.assign(env, {
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
	});
	const git = (...args) =>
		execFileSync("git", args, {
			cwd,
			env,
			stdio: "pipe",
		});
	git("init", "--quiet", "--template=", "--initial-branch=main");
	git("add", "--force", "--", ...Object.keys(task.files));
	git("commit", "--quiet", "-m", "Seed coding evaluation fixture");
	return git("rev-parse", "--verify", "HEAD").toString().trim();
}

export async function supervise({
	config,
	task,
	trialDir,
	signal,
	checkpoint,
	entry = new URL("./trial.mjs", import.meta.url),
}) {
	const start = performance.now();
	const row = {
		id: config.id,
		arm: config.arm,
		caseId: config.caseId,
		repetition: config.repetition,
		startedAt: new Date().toISOString(),
		corrections: 0,
		attempts: [],
		costUsd: null,
	};
	const cwd = join(trialDir, "work");
	const agentDir = join(trialDir, "agent");
	let forced;
	try {
		mkdirSync(trialDir, { mode: 0o700 });
		mkdirSync(agentDir, { mode: 0o700 });
		if (config.skillMode) {
			const skillDirectory = join(agentDir, "skills", "study");
			mkdirSync(skillDirectory, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(skillDirectory, "SKILL.md"),
				`---\nname: ${JSON.stringify(config.skillName)}\ndescription: Guidance selected for this coding task.\n---\n\n${config.skillBody}\n`,
				{ mode: 0o600, flag: "wx" },
			);
		}
		const seedCommit = seedWorkspace(cwd, task);
		const input = join(trialDir, "input.json");
		saveJson(input, { ...config, agentDir, seedCommit });
		const env = {
			...fixtureEnvironment(cwd),
			[ENV_AGENT_DIR]: agentDir,
			[ENV_SESSION_DIR]: join(agentDir, "sessions"),
		};
		const child = fork(entry, [input], {
			cwd,
			env,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			detached: process.platform !== "win32",
		});
		await new Promise((resolve, reject) => {
			const stop = (reason) => {
				if (forced) return;
				forced = reason;
				const result = killTreeNow(child);
				if (!result.success && !result.gone && child.exitCode === null && child.signalCode === null) {
					row.diagnostic = result.error;
					child.kill("SIGKILL");
				}
			};
			const abort = () => stop("interrupted");
			const timeout = setTimeout(() => stop("timeout"), config.timeoutMs);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			child.on("message", (message) => {
				if (config.skillMode && message?.kind === "grade") {
					try {
						const findings =
							typeof message.answer === "string" && message.answer.length <= 1024 * 1024
								? grade(task, cwd, message.answer)
								: ["Submission exceeds the grader input bound."];
						child.send({ kind: "grade-result", request: message.request, findings });
					} catch {
						row.diagnostic = "Independent grader failed";
						stop("error");
					}
					return;
				}
				Object.assign(row, message);
				try {
					checkpoint({ ...row, elapsedMs: Math.round(performance.now() - start) });
				} catch (error) {
					row.diagnostic = `Checkpoint failed: ${error.message}`;
					stop("error");
				}
			});
			child.once("error", reject);
			child.once("close", (code) => {
				clearTimeout(timeout);
				signal.removeEventListener("abort", abort);
				if (forced || code !== 0 || !["accepted", "rejected"].includes(row.status)) {
					row.status = forced ?? "error";
					row.costUsd = null;
					row.diagnostic ??= forced ?? `Trial process closed with exit code ${code}`;
				}
				resolve();
			});
		});
	} catch (error) {
		row.status = "error";
		row.diagnostic = String(error.message).slice(0, 300);
		row.costUsd = null;
	}
	return { ...row, elapsedMs: Math.round(performance.now() - start) };
}
