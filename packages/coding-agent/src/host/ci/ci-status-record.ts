import { execFile, execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type CiStatusView, ciStatusViewFromRecord } from "../../core/ci-status-view.ts";
import type { CiAttemptTerminalEvent, CiCurrentObservation } from "../../core/events/host-event-contract.ts";
import { boundedRedactedDiagnosticText } from "../../core/security/secret-text.ts";
import { withFileLockSync, writeFileAtomicSync } from "../../core/util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../../kernel/storage/bounded-file.ts";
import type { CiProvider } from "./ci-provider.ts";

export const CI_WORKFLOW = "ci.yml";
export interface CiGitPaths {
	readonly root: string;
	readonly gitDir: string;
	readonly commonDir: string;
	readonly statusDir: string;
}

export interface CiStatusRecord {
	readonly state: string;
	readonly sha?: string;
	readonly branch?: string;
	readonly workflow?: string;
	readonly conclusion?: string;
	readonly runId?: number;
	readonly runAttempt?: number;
	readonly runNumber?: number;
	readonly url?: string;
	readonly failedJobs?: readonly string[];
	readonly pid?: number;
	readonly startedAt?: string;
	readonly completedAt?: string;
	readonly error?: string;
	readonly pushedBy?: string;
	readonly reconciledBy?: string;
}

const GIT_PATHS_ARGS = ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"];

function ciGitPathsFrom(cwd: string, output: string): CiGitPaths {
	const parts = output.trim().split(/\r?\n/);
	if (parts.length !== 3) throw new Error("Cannot resolve CI repository directories.");
	return {
		root: resolve(cwd, parts[0]),
		gitDir: resolve(cwd, parts[1]),
		commonDir: resolve(cwd, parts[2]),
		statusDir: join(resolve(cwd, parts[2]), "pi-ci"),
	};
}

export function resolveCiGitPaths(cwd: string): CiGitPaths {
	return ciGitPathsFrom(
		cwd,
		execFileSync("git", GIT_PATHS_ARGS, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			maxBuffer: 32_768,
		}),
	);
}

/** Session hosts resolve without blocking the event loop; `undefined` outside a Git work tree. */
export function resolveCiGitPathsAsync(cwd: string, signal: AbortSignal): Promise<CiGitPaths | undefined> {
	return new Promise((resolvePaths, reject) => {
		signal.throwIfAborted();
		execFile(
			"git",
			GIT_PATHS_ARGS,
			{ cwd, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 32_768, signal },
			(error, stdout) => {
				if (signal.aborted) reject(signal.reason);
				else if (error) resolvePaths(undefined);
				else {
					try {
						resolvePaths(ciGitPathsFrom(cwd, stdout));
					} catch (failure) {
						reject(failure);
					}
				}
			},
		);
	});
}

/** How long a pushed revision may wait for its workflow run before it is recorded as `no_run`. */
export const CI_REGISTRATION_GRACE_MS = 5 * 60_000;

/** `undefined` when the record names no watcher process. */
export function ciWatcherAlive(record: CiStatusRecord): boolean | undefined {
	if (record.pid === undefined) return undefined;
	try {
		process.kill(record.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** File-only footer projection: no provider, network or source activation is needed. */
export function readCiStatusView(paths: CiGitPaths, now = Date.now()): CiStatusView | undefined {
	try {
		const head = readCiHead(paths);
		if (!head.branch) return undefined;
		const record = readCiStatusFile(ciStatusPath(paths.statusDir, head.branch));
		const watcherAlive = record?.state === "pending" ? ciWatcherAlive(record) : undefined;
		return ciStatusViewFromRecord(record, head.branch, now, watcherAlive);
	} catch {
		return undefined;
	}
}

export function statusDirectory(root = process.cwd()): string {
	return resolveCiGitPaths(root).statusDir;
}

export function statusFile(branch: string, root = process.cwd()): string {
	return ciStatusPath(resolveCiGitPaths(root).statusDir, branch);
}

export function ciStatusPath(directory: string, branch: string): string {
	if (!branch || branch.length > 1024) throw new Error("Invalid CI branch name.");
	return join(directory, `${encodeURIComponent(branch)}.json`);
}

export function readCiStatusFile(path: string): CiStatusRecord | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const record: unknown = JSON.parse(readBoundedTextFileSync(path, 64 * 1024, "CI record"));
		if (
			!record ||
			typeof record !== "object" ||
			Array.isArray(record) ||
			!("state" in record) ||
			typeof record.state !== "string"
		)
			throw new Error("Invalid CI status record.");
		const fields = record as Record<string, unknown>;
		for (const key of [
			"state",
			"sha",
			"branch",
			"workflow",
			"conclusion",
			"url",
			"startedAt",
			"completedAt",
			"error",
			"pushedBy",
			"reconciledBy",
		]) {
			if (fields[key] !== undefined && (typeof fields[key] !== "string" || (fields[key] as string).length > 4096))
				throw new Error("Invalid CI status text.");
		}
		for (const key of ["runId", "runAttempt", "runNumber", "pid"]) {
			if (
				fields[key] !== undefined &&
				(typeof fields[key] !== "number" || !Number.isSafeInteger(fields[key]) || (fields[key] as number) < 1)
			)
				throw new Error("Invalid CI status identity.");
		}
		if (
			fields.failedJobs !== undefined &&
			(!Array.isArray(fields.failedJobs) ||
				fields.failedJobs.length > 100 ||
				fields.failedJobs.some((job) => typeof job !== "string" || job.length > 512))
		)
			throw new Error("Invalid CI job summary.");
		return record as CiStatusRecord;
	} catch {
		return { state: "unreadable" };
	}
}

export function readCiStatus(branch: string, root = process.cwd()): CiStatusRecord | undefined {
	return readCiStatusFile(statusFile(branch, root));
}

const MAX_CI_STATUS_RECORDS = 64;

/** The most recently written branch records; older branches' verdicts stay on disk but are not read. */
export function readCiStatusRecords(directory: string): CiStatusRecord[] {
	if (!existsSync(directory)) return [];
	let files = readBoundedDirectoryNamesSync(directory, 512, "CI status directory").filter((file) =>
		file.endsWith(".json"),
	);
	if (files.length > MAX_CI_STATUS_RECORDS) {
		const modified = (file: string): number => {
			try {
				return statSync(join(directory, file)).mtimeMs;
			} catch {
				return 0;
			}
		};
		files = files
			.map((file) => ({ file, at: modified(file) }))
			.sort((a, b) => b.at - a.at)
			.slice(0, MAX_CI_STATUS_RECORDS)
			.map((entry) => entry.file);
	}
	return files.flatMap((file) => {
		const record = readCiStatusFile(join(directory, file));
		return record ? [record] : [];
	});
}

/**
 * `expectedSha` makes the write a compare-and-set: a reconciliation never replaces a record
 * another writer moved to a different revision after it was read.
 */
export function writeCiStatus(
	paths: CiGitPaths,
	branch: string,
	requested: CiStatusRecord,
	expectedSha?: string,
): void {
	const path = ciStatusPath(paths.statusDir, branch);
	withFileLockSync(path, () => {
		const current = readCiStatusFile(path);
		if (expectedSha !== undefined && current?.sha !== expectedSha) return;
		if (current?.sha && requested.sha && current.sha !== requested.sha) {
			try {
				execFileSync("git", ["merge-base", "--is-ancestor", requested.sha, current.sha], {
					cwd: paths.root,
					stdio: "ignore",
					timeout: 10_000,
				});
				return;
			} catch {
				/* A non-ancestor update owns the branch display. Retention is independent. */
			}
		}
		const pushedBy = process.env.PI_WORKER_LABEL?.trim();
		writeFileAtomicSync(path, `${JSON.stringify({ ...requested, ...(pushedBy ? { pushedBy } : {}) }, null, 2)}\n`);
	});
}

export function commitObligation(
	status: CiStatusRecord | undefined,
	isAncestorOfHead: (sha: string) => boolean,
):
	| { kind: "none" }
	| { kind: "pending" | "unknown"; status: CiStatusRecord }
	| { kind: "red"; status: CiStatusRecord; failedJobs: readonly string[] } {
	if (!status?.sha || !isAncestorOfHead(status.sha)) return { kind: "none" };
	if (status.state === "pending") return { kind: "pending", status };
	// watch_failed, unreadable and no_run (no run appeared: a rejected push or an untriggered
	// workflow) carry no CI outcome. They are unknown, never red.
	if (status.state !== "completed") return { kind: "unknown", status };
	if (status.conclusion === "success") return { kind: "none" };
	return { kind: "red", status, failedJobs: status.failedJobs ?? [] };
}

/** The display record for one terminal attempt, rebuilt from that attempt only (no prior fields). */
export async function completedCiStatus(
	provider: CiProvider,
	target: { readonly sha: string; readonly branch: string },
	current: CiCurrentObservation,
	event: CiAttemptTerminalEvent,
	signal: AbortSignal,
): Promise<CiStatusRecord> {
	let failedJobs: readonly string[] = [];
	let error: string | undefined;
	if (event.conclusion !== "success") {
		try {
			failedJobs = await provider.failedJobs(event.identity, signal);
		} catch (failure) {
			signal.throwIfAborted();
			error = `CI outcome retained; job detail unavailable: ${boundedRedactedDiagnosticText(failure instanceof Error ? failure.message : String(failure)) ?? "unavailable"}`;
		}
	}
	return {
		sha: target.sha,
		branch: target.branch,
		workflow: CI_WORKFLOW,
		state: "completed",
		conclusion: event.conclusion,
		runId: current.runId,
		runAttempt: current.runAttempt,
		runNumber: current.runNumber,
		url: event.runUrl,
		failedJobs,
		...(error ? { error } : {}),
		completedAt: new Date().toISOString(),
	};
}

export function describeStatus(status: CiStatusRecord | undefined): string {
	if (!status) return "no recorded CI verdict";
	if (status.state === "pending") return `${status.branch} ${status.sha?.slice(0, 9)}: ${CI_WORKFLOW} still running`;
	if (status.state !== "completed")
		return `${status.branch} ${status.sha?.slice(0, 9)}: ${status.state}${status.error ? ` (${status.error})` : ""}`;
	return [
		`${status.branch} ${status.sha?.slice(0, 9)}: ${CI_WORKFLOW} ${status.conclusion}${status.url ? ` ${status.url}` : ""}`,
		...(status.failedJobs ?? []).map((job) => `  failed job: ${job}`),
	].join("\n");
}

export function readCiHead(paths: CiGitPaths): { sha?: string; branch?: string; refDirectory: string } {
	const head = readBoundedTextFileSync(join(paths.gitDir, "HEAD"), 8192, "CI HEAD").trim();
	if (/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(head)) return { sha: head, refDirectory: paths.gitDir };
	if (!head.startsWith("ref: refs/heads/")) return { refDirectory: paths.gitDir };
	const ref = head.slice(5);
	if (ref.includes("..") || ref.includes("\\") || ref.includes("\0")) throw new Error("Invalid CI HEAD reference.");
	const refPath = join(paths.commonDir, ref);
	let sha: string | undefined;
	if (existsSync(refPath)) sha = readBoundedTextFileSync(refPath, 256, "CI branch reference").trim();
	else {
		const packed = join(paths.commonDir, "packed-refs");
		if (existsSync(packed)) {
			sha = readBoundedTextFileSync(packed, 2 * 1024 * 1024, "Packed CI references")
				.split(/\r?\n/)
				.find((line) => line.endsWith(` ${ref}`))
				?.split(" ")[0];
		}
	}
	return {
		...(/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(sha ?? "") ? { sha } : {}),
		branch: ref.slice("refs/heads/".length),
		refDirectory: existsSync(dirname(refPath)) ? dirname(refPath) : paths.commonDir,
	};
}
