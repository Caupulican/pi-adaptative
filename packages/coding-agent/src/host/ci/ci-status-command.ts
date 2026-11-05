import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getStableSelfLaunchTarget } from "../../core/process-matrix/self-launch-target.ts";
import { boundedRedactedDiagnosticText } from "../../core/security/secret-text.ts";
import { CiSourceStore, ciSourceRetainedAttempts, ciSourceRetiredRuns } from "./ci-source-store.ts";
import {
	CI_REGISTRATION_GRACE_MS,
	CI_WORKFLOW,
	type CiGitPaths,
	type CiStatusRecord,
	ciStatusPath,
	completedCiStatus,
	describeStatus,
	readCiHead,
	readCiStatusFile,
	resolveCiGitPaths,
	writeCiStatus,
} from "./ci-status-record.ts";
import { createCiCommandPort, GithubActionsCiProvider } from "./github-actions-ci-provider.ts";

export {
	commitObligation,
	describeStatus,
	readCiStatus,
	statusDirectory,
	statusFile,
} from "./ci-status-record.ts";
export const CI_STATUS_COMMAND = "--ci-status";
const REGISTRATION_INTERVAL_MS = 20_000;

export function prePushTargets(stdin: string): { sha: string; branch: string }[] {
	return stdin
		.split("\n")
		.map((line) => line.trim().split(/\s+/u))
		.filter((parts) => parts.length === 4 && !/^0+$/.test(parts[1]) && parts[2].startsWith("refs/heads/"))
		.map(([, sha, remoteRef]) => ({ sha, branch: remoteRef.slice("refs/heads/".length) }));
}

async function collectStatus(
	paths: CiGitPaths,
	sha: string,
	branch: string,
	signal: AbortSignal,
): Promise<CiStatusRecord | undefined> {
	const provider = new GithubActionsCiProvider(createCiCommandPort(paths.root));
	const store = new CiSourceStore(paths.statusDir, {
		onDiagnostic: (message) => process.stderr.write(`ci-status: ${message}\n`),
	});
	const repository = await provider.repository(signal);
	const retained = store.snapshot();
	const collection = await provider.collect(
		sha,
		signal,
		ciSourceRetainedAttempts(retained),
		ciSourceRetiredRuns(retained, repository),
	);
	store.retain(collection.events);
	const current = collection.current;
	if (!current) return undefined;
	if (current.status !== "completed")
		return {
			sha,
			branch,
			workflow: CI_WORKFLOW,
			runId: current.runId,
			runAttempt: current.runAttempt,
			runNumber: current.runNumber,
			state: "pending",
			pid: process.pid,
			startedAt: new Date().toISOString(),
		};
	const event = collection.events.find((entry) => entry.eventId === current.eventId)!;
	return completedCiStatus(provider, { sha, branch }, current, event, signal);
}

export async function watch(sha: string, branch: string, root = process.cwd()): Promise<void> {
	const paths = resolveCiGitPaths(root);
	const base = { sha, branch, workflow: CI_WORKFLOW };
	writeCiStatus(paths, branch, { ...base, state: "pending", startedAt: new Date().toISOString(), pid: process.pid });
	const signal = new AbortController().signal;
	const provider = new GithubActionsCiProvider(createCiCommandPort(paths.root));
	try {
		const started = Date.now();
		for (;;) {
			const status = await collectStatus(paths, sha, branch, signal);
			if (!status) {
				if (Date.now() - started > CI_REGISTRATION_GRACE_MS) {
					// A rejected push or an untriggered workflow has no CI outcome: unknown, never red.
					writeCiStatus(paths, branch, {
						...base,
						state: "no_run",
						error: `no ${CI_WORKFLOW} run appeared for this revision`,
						completedAt: new Date().toISOString(),
					});
					return;
				}
				await delay(REGISTRATION_INTERVAL_MS);
				continue;
			}
			writeCiStatus(paths, branch, status);
			if (status.state === "completed") return;
			try {
				await provider.waitForRun(status.runId!, signal);
			} catch {
				await delay(REGISTRATION_INTERVAL_MS);
			}
		}
	} catch (error) {
		writeCiStatus(paths, branch, {
			...base,
			state: "watch_failed",
			error: boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)) ?? "unavailable",
			completedAt: new Date().toISOString(),
		});
	}
}

export async function reconcile(branch: string, root = process.cwd()): Promise<void> {
	const paths = resolveCiGitPaths(root);
	const previous = readCiStatusFile(ciStatusPath(paths.statusDir, branch));
	if (!previous?.sha) return;
	const status = await collectStatus(paths, previous.sha, branch, new AbortController().signal);
	if (status?.state === "completed") writeCiStatus(paths, branch, { ...status, reconciledBy: "pi" });
}

function startWatchers(paths: CiGitPaths, targets: readonly { sha: string; branch: string }[]): void {
	const launch = getStableSelfLaunchTarget();
	if (!launch) throw new Error("CI watcher cannot locate its packaged command entry point.");
	for (const { sha, branch } of targets) {
		mkdirSync(paths.statusDir, { recursive: true });
		// Registration precedes the remote push and detached startup. The interactive
		// source must know this pending subject before GitHub assigns its run number.
		writeCiStatus(paths, branch, {
			sha,
			branch,
			workflow: CI_WORKFLOW,
			state: "pending",
			startedAt: new Date().toISOString(),
		});
		const log = openSync(join(paths.statusDir, `watch-${branch.replaceAll("/", "__")}.log`), "w");
		try {
			const child = spawn(launch.executable, [...launch.argsPrefix, CI_STATUS_COMMAND, "watch", sha, branch], {
				cwd: paths.root,
				detached: true,
				stdio: ["ignore", log, log],
				windowsHide: true,
				env: { ...process.env, ...launch.environment },
			});
			child.on("error", (error) => {
				writeCiStatus(paths, branch, {
					sha,
					branch,
					workflow: CI_WORKFLOW,
					state: "watch_failed",
					error: boundedRedactedDiagnosticText(error.message) ?? "unavailable",
					completedAt: new Date().toISOString(),
				});
			});
			child.unref();
		} finally {
			closeSync(log);
		}
		process.stdout.write(
			`ci-status: watching ${CI_WORKFLOW} for ${branch} at ${sha.slice(0, 9)} (verdict lands in ${ciStatusPath(paths.statusDir, branch)})\n`,
		);
	}
}

export async function runCiStatusCommand(argv: readonly string[], root = process.cwd()): Promise<void> {
	const [command, ...rest] = argv[0] === CI_STATUS_COMMAND ? argv.slice(1) : argv;
	if (command === "watch" && rest.length === 2) return watch(rest[0], rest[1], root);
	if (command === "reconcile" && rest.length === 1) return reconcile(rest[0], root);
	const paths = resolveCiGitPaths(root);
	if (command === "show") {
		const branch = rest[0] ?? readCiHead(paths).branch;
		process.stdout.write(
			`${describeStatus(branch ? readCiStatusFile(ciStatusPath(paths.statusDir, branch)) : undefined)}\n`,
		);
		return;
	}
	if (command === "pre-push") {
		const targets = prePushTargets(readFileSync(0, "utf8"));
		for (const { branch } of targets) {
			const previous = readCiStatusFile(ciStatusPath(paths.statusDir, branch));
			if (previous?.state === "completed" && previous.conclusion !== "success")
				process.stdout.write(
					`ci-status: the last recorded ${CI_WORKFLOW} on ${branch} is red:\n${describeStatus(previous)}\n`,
				);
		}
		startWatchers(paths, targets);
		return;
	}
	throw new Error("usage: --ci-status <pre-push|watch <sha> <branch>|reconcile <branch>|show [branch]>");
}
