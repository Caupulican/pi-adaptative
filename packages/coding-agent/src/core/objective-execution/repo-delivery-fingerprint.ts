/**
 * Size-independent checkout fingerprint. Git output and file bytes are hashed as
 * streams. A moving checkout is retried once, then reported unstable.
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { bindChildProcessAbort, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { withoutInheritedGitLocation } from "../exec.ts";
import type { WorkEvidenceOperationOptions } from "../system-one/work-diff.ts";
import { parseRepositoryHeadRecord } from "./repository-head-state.ts";

export type RepoDeliveryFingerprint =
	| {
			readonly ok: true;
			readonly repositoryRoot: string;
			readonly digest: string;
			readonly head: string;
			readonly indexDigest: string;
			readonly entries: ReadonlyMap<string, string>;
	  }
	| { readonly ok: false; readonly reason: "repository_fingerprint_unstable" | "repository_fingerprint_unavailable" };

export interface FingerprintHooks {
	/** Test seam: runs after each fence so a caller can move the checkout under the hash. */
	afterFence?: () => void;
	/** Test seam for process-lifecycle failure injection. */
	spawnGit?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	/** Test seam for bounded timeout verification. */
	gitTimeoutMs?: number;
}

const GIT_TIMEOUT_MS = 20_000;
const READ_CHUNK = 1024 * 1024;

function remainingTimeout(options: WorkEvidenceOperationOptions, maximum = GIT_TIMEOUT_MS): number {
	options.signal?.throwIfAborted();
	if (options.deadline === undefined) return maximum;
	const remaining = options.deadline - Date.now();
	if (remaining <= 0) throw new Error("Repository fingerprint deadline expired");
	return Math.min(maximum, remaining);
}

function gitEnv(): NodeJS.ProcessEnv {
	return { ...withoutInheritedGitLocation(), GIT_TERMINAL_PROMPT: "0" };
}

async function runGit(
	repoRoot: string,
	args: readonly string[],
	onData: (chunk: Buffer) => void,
	hooks?: FingerprintHooks,
	options: WorkEvidenceOperationOptions = {},
): Promise<boolean> {
	const timeoutMs = remainingTimeout(options, hooks?.gitTimeoutMs ?? GIT_TIMEOUT_MS);
	let child: ChildProcess;
	try {
		child = (hooks?.spawnGit ?? spawn)("git", [...args], {
			cwd: repoRoot,
			detached: process.platform !== "win32",
			env: gitEnv(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch {
		return false;
	}
	if (options.signal) bindChildProcessAbort(child, options.signal);
	child.stdout?.on("data", onData);
	// Git diagnostics are not part of the fingerprint, but the pipe must remain drained or enough
	// stderr can block the child before its terminal event and turn a deadline into a false hang.
	child.stderr?.resume();
	try {
		const terminal = await waitForChildProcessWithTermination(child, {
			timeoutMs,
			killGraceMs: 1_000,
			...(options.signal ? { signal: options.signal } : {}),
		});
		if (terminal.reason === "aborted") options.signal?.throwIfAborted();
		return terminal.reason === "exited" && terminal.code === 0;
	} catch (error) {
		if (options.signal?.aborted) throw error;
		return false;
	}
}

async function gitText(
	repoRoot: string,
	args: readonly string[],
	hooks?: FingerprintHooks,
	options: WorkEvidenceOperationOptions = {},
): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	const ok = await runGit(
		repoRoot,
		args,
		(chunk) => {
			chunks.push(chunk);
		},
		hooks,
		options,
	);
	if (!ok) return undefined;
	return Buffer.concat(chunks).toString("utf8").trim();
}

async function streamHashFile(absolute: string, options: WorkEvidenceOperationOptions): Promise<string | undefined> {
	remainingTimeout(options);
	let stat: Awaited<ReturnType<typeof lstat>>;
	try {
		stat = await lstat(absolute);
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		if (code === "ENOENT") return "deleted";
		return undefined;
	}
	if (stat.isSymbolicLink()) {
		try {
			return createHash("sha256")
				.update(`symlink ${await readlink(absolute)}`)
				.digest("hex");
		} catch {
			return undefined;
		}
	}
	if (stat.isDirectory()) return `directory ${stat.mode & 0o777}`;
	if (!stat.isFile()) return `other ${stat.mode}`;
	const hash = createHash("sha256");
	hash.update(String(stat.mode & 0o777));
	hash.update("\0");
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(absolute, "r");
		const chunk = Buffer.alloc(READ_CHUNK);
		while (true) {
			remainingTimeout(options);
			const result = await handle.read(chunk, 0, chunk.length, null);
			if (result.bytesRead === 0) break;
			hash.update(chunk.subarray(0, result.bytesRead));
		}
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		if (code === "ENOENT") return "deleted";
		return undefined;
	} finally {
		await handle?.close();
	}
	return hash.digest("hex");
}

function safePath(repoRoot: string, rel: string): string | undefined {
	if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) return undefined;
	const absolute = join(repoRoot, rel);
	const back = relative(repoRoot, absolute);
	if (!back || back.startsWith("..") || isAbsolute(back)) return undefined;
	return absolute;
}

interface StatusRecord {
	readonly text: string;
	readonly path?: string;
	readonly origPath?: string;
	readonly submodule: boolean;
}

function parseStatusRecord(text: string, origPath?: string): StatusRecord {
	if (text.startsWith("? ")) {
		return { text, path: text.slice(2), submodule: false, ...(origPath ? { origPath } : {}) };
	}
	const parts = text.split(" ");
	const kind = parts[0];
	const pathIndex = kind === "2" ? 9 : kind === "u" ? 10 : 8;
	const path = parts.slice(pathIndex).join(" ");
	const submodule = (parts[2] ?? "").startsWith("S");
	return { text, path: path || undefined, submodule, ...(origPath ? { origPath } : {}) };
}

function takeStatusRecords(buffer: Buffer): {
	readonly records: StatusRecord[];
	readonly headRecords: string[];
	readonly rest: Buffer;
} {
	const records: StatusRecord[] = [];
	const headRecords: string[] = [];
	let start = 0;
	while (start < buffer.length) {
		const nul = buffer.indexOf(0, start);
		if (nul < 0) break;
		const text = buffer.toString("utf8", start, nul);
		start = nul + 1;
		if (text.startsWith("# ")) {
			if (text.startsWith("# branch.oid ")) headRecords.push(text);
			continue;
		}
		if (text.startsWith("2 ")) {
			const origNul = buffer.indexOf(0, start);
			if (origNul < 0) return { records, headRecords, rest: buffer.subarray(start - text.length - 1) };
			const orig = buffer.toString("utf8", start, origNul);
			start = origNul + 1;
			records.push(parseStatusRecord(text, orig));
			continue;
		}
		if (text.length > 0) records.push(parseStatusRecord(text));
	}
	return { records, headRecords, rest: buffer.subarray(start) };
}

interface Fence {
	readonly head: string;
	readonly indexDigest: string;
	readonly records: readonly StatusRecord[];
	readonly token: string;
}

async function readFence(
	repoRoot: string,
	hooks?: FingerprintHooks,
	options: WorkEvidenceOperationOptions = {},
): Promise<Fence | undefined> {
	const index = createHash("sha256");
	const indexOk = await runGit(
		repoRoot,
		["ls-files", "--stage", "-z"],
		(chunk) => {
			index.update(chunk);
		},
		hooks,
		options,
	);
	if (!indexOk) return undefined;
	const indexDigest = index.digest("hex");
	const records: StatusRecord[] = [];
	const headRecords: string[] = [];
	let pending = Buffer.alloc(0);
	const statusOk = await runGit(
		repoRoot,
		["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
		(chunk) => {
			pending = Buffer.concat([pending, chunk]);
			const taken = takeStatusRecords(pending);
			records.push(...taken.records);
			headRecords.push(...taken.headRecords);
			pending = Buffer.from(taken.rest);
		},
		hooks,
		options,
	);
	if (!statusOk || pending.length > 0 || headRecords.length !== 1) return undefined;
	const head = parseRepositoryHeadRecord(headRecords[0]!);
	if (!head) return undefined;
	const token = createHash("sha256");
	token.update(head);
	token.update("\0");
	token.update(indexDigest);
	token.update("\0");
	for (const record of records) {
		token.update(record.text);
		token.update("\0");
		if (record.origPath) token.update(record.origPath);
		token.update("\0");
	}
	return { head, indexDigest, records, token: token.digest("hex") };
}

async function digestFence(
	repoRoot: string,
	fence: Fence,
	hooks?: FingerprintHooks,
	options: WorkEvidenceOperationOptions = {},
): Promise<{ readonly digest: string; readonly entries: Map<string, string> } | undefined> {
	const hash = createHash("sha256");
	const entries = new Map<string, string>();
	hash.update("head");
	hash.update("\0");
	hash.update(fence.head);
	hash.update("\0");
	hash.update("index");
	hash.update("\0");
	hash.update(fence.indexDigest);
	hash.update("\0");
	for (const record of fence.records) {
		remainingTimeout(options);
		hash.update(record.text);
		hash.update("\0");
		if (!record.path) continue;
		const absolute = safePath(repoRoot, record.path);
		if (!absolute) return undefined;
		let mark: string | undefined;
		if (record.submodule) {
			const sub = await gitText(absolute, ["rev-parse", "HEAD"], hooks, options);
			mark = sub ? `submodule ${sub}` : "submodule";
		} else mark = await streamHashFile(absolute, options);
		if (!mark) return undefined;
		entries.set(record.path, mark);
		hash.update(record.path);
		hash.update("\0");
		hash.update(mark);
		hash.update("\0");
		if (record.origPath) {
			hash.update(record.origPath);
			hash.update("\0");
		}
	}
	return { digest: hash.digest("hex"), entries };
}

export async function captureRepoDeliveryFingerprint(
	workingDirectory: string,
	hooks?: FingerprintHooks,
	options: WorkEvidenceOperationOptions = {},
): Promise<RepoDeliveryFingerprint> {
	if (!workingDirectory) return { ok: false, reason: "repository_fingerprint_unavailable" };
	const repoRoot = await gitText(workingDirectory, ["rev-parse", "--show-toplevel"], hooks, options);
	if (!repoRoot) return { ok: false, reason: "repository_fingerprint_unavailable" };
	const attempt = async (): Promise<RepoDeliveryFingerprint | "retry"> => {
		try {
			const before = await readFence(repoRoot, hooks, options);
			if (!before) return { ok: false, reason: "repository_fingerprint_unavailable" };
			hooks?.afterFence?.();
			const digested = await digestFence(repoRoot, before, hooks, options);
			if (!digested) return { ok: false, reason: "repository_fingerprint_unavailable" };
			const after = await readFence(repoRoot, hooks, options);
			if (!after) return { ok: false, reason: "repository_fingerprint_unavailable" };
			if (before.token !== after.token) return "retry";
			return {
				ok: true,
				repositoryRoot: repoRoot,
				digest: digested.digest,
				head: before.head,
				indexDigest: before.indexDigest,
				entries: digested.entries,
			};
		} catch (error) {
			if (options.signal?.aborted) throw error;
			return { ok: false, reason: "repository_fingerprint_unavailable" };
		}
	};
	const first = await attempt();
	if (first !== "retry") return first;
	const second = await attempt();
	if (second === "retry") return { ok: false, reason: "repository_fingerprint_unstable" };
	return second;
}

export async function sharesRepository(
	left: string,
	right: string,
	options: WorkEvidenceOperationOptions = {},
): Promise<boolean> {
	const leftDir = await gitText(left, ["rev-parse", "--absolute-git-dir"], undefined, options);
	const rightDir = await gitText(right, ["rev-parse", "--absolute-git-dir"], undefined, options);
	if (!leftDir || !rightDir) return true;
	return leftDir === rightDir;
}
