import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withFileLockSync, writeFileAtomicSync } from "../../core/util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../../kernel/storage/bounded-file.ts";

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

export function resolveCiGitPaths(cwd: string): CiGitPaths {
	const parts = execFileSync("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
		maxBuffer: 32_768,
	})
		.trim()
		.split(/\r?\n/);
	if (parts.length !== 3) throw new Error("Cannot resolve CI repository directories.");
	return {
		root: resolve(cwd, parts[0]),
		gitDir: resolve(cwd, parts[1]),
		commonDir: resolve(cwd, parts[2]),
		statusDir: join(resolve(cwd, parts[2]), "pi-ci"),
	};
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

export function readCiStatusRecords(directory: string): CiStatusRecord[] {
	if (!existsSync(directory)) return [];
	const files = readBoundedDirectoryNamesSync(directory, 512, "CI status directory").filter(
		(file) => file.endsWith(".json") && file !== "source-v1.json",
	);
	if (files.length > 64) throw new Error("CI status discovery exceeds its branch bound.");
	return files.flatMap((file) => {
		const record = readCiStatusFile(join(directory, file));
		return record ? [record] : [];
	});
}

export function writeCiStatus(paths: CiGitPaths, branch: string, requested: CiStatusRecord): void {
	const path = ciStatusPath(paths.statusDir, branch);
	withFileLockSync(path, () => {
		const current = readCiStatusFile(path);
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
	if (status.state === "watch_failed" || status.state === "unreadable") return { kind: "unknown", status };
	if (status.state !== "completed" || status.conclusion === "success") return { kind: "none" };
	return { kind: "red", status, failedJobs: status.failedJobs ?? [] };
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
