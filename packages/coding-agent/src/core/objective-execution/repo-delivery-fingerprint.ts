/**
 * Size-independent checkout fingerprint. Git output and file bytes are hashed as
 * streams. A moving checkout is retried once, then reported unstable.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { withoutInheritedGitLocation } from "../exec.ts";

export type RepoDeliveryFingerprint =
	| { readonly ok: true; readonly digest: string; readonly entries: ReadonlyMap<string, string> }
	| { readonly ok: false; readonly reason: "repository_fingerprint_unstable" | "repository_fingerprint_unavailable" };

export interface FingerprintHooks {
	/** Test seam: runs after each fence so a caller can move the checkout under the hash. */
	afterFence?: () => void;
}

const GIT_TIMEOUT_MS = 20_000;
const READ_CHUNK = 1024 * 1024;

function gitEnv(): NodeJS.ProcessEnv {
	return { ...withoutInheritedGitLocation(), GIT_TERMINAL_PROMPT: "0" };
}

function runGit(repoRoot: string, args: readonly string[], onData: (chunk: Buffer) => void): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn("git", args, {
				cwd: repoRoot,
				env: gitEnv(),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
		}, GIT_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			onData(chunk);
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
	});
}

async function gitText(repoRoot: string, args: readonly string[]): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	const ok = await runGit(repoRoot, args, (chunk) => {
		chunks.push(chunk);
	});
	if (!ok) return undefined;
	return Buffer.concat(chunks).toString("utf8").trim();
}

function streamHashFile(absolute: string): string | undefined {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(absolute);
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		if (code === "ENOENT") return "deleted";
		return undefined;
	}
	if (stat.isSymbolicLink()) {
		try {
			return createHash("sha256")
				.update(`symlink ${readlinkSync(absolute)}`)
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
	let fd: number | undefined;
	try {
		fd = openSync(absolute, "r");
		const chunk = Buffer.alloc(READ_CHUNK);
		while (true) {
			const read = readSync(fd, chunk, 0, chunk.length, null);
			if (read === 0) break;
			hash.update(chunk.subarray(0, read));
		}
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		if (code === "ENOENT") return "deleted";
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
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

function takeStatusRecords(buffer: Buffer): { readonly records: StatusRecord[]; readonly rest: Buffer } {
	const records: StatusRecord[] = [];
	let start = 0;
	while (start < buffer.length) {
		const nul = buffer.indexOf(0, start);
		if (nul < 0) break;
		const text = buffer.toString("utf8", start, nul);
		start = nul + 1;
		if (text.startsWith("2 ")) {
			const origNul = buffer.indexOf(0, start);
			if (origNul < 0) return { records, rest: buffer.subarray(start - text.length - 1) };
			const orig = buffer.toString("utf8", start, origNul);
			start = origNul + 1;
			records.push(parseStatusRecord(text, orig));
			continue;
		}
		if (text.length > 0) records.push(parseStatusRecord(text));
	}
	return { records, rest: buffer.subarray(start) };
}

interface Fence {
	readonly head: string;
	readonly indexDigest: string;
	readonly records: readonly StatusRecord[];
	readonly token: string;
}

async function readFence(repoRoot: string): Promise<Fence | undefined> {
	const head = await gitText(repoRoot, ["rev-parse", "HEAD"]);
	if (!head) return undefined;
	const index = createHash("sha256");
	const indexOk = await runGit(repoRoot, ["ls-files", "--stage", "-z"], (chunk) => {
		index.update(chunk);
	});
	if (!indexOk) return undefined;
	const indexDigest = index.digest("hex");
	const records: StatusRecord[] = [];
	let pending = Buffer.alloc(0);
	const statusOk = await runGit(repoRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], (chunk) => {
		pending = Buffer.concat([pending, chunk]);
		const taken = takeStatusRecords(pending);
		records.push(...taken.records);
		pending = Buffer.from(taken.rest);
	});
	if (!statusOk || pending.length > 0) return undefined;
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
		hash.update(record.text);
		hash.update("\0");
		if (!record.path) continue;
		const absolute = safePath(repoRoot, record.path);
		if (!absolute) return undefined;
		let mark: string | undefined;
		if (record.submodule) {
			const sub = await gitText(absolute, ["rev-parse", "HEAD"]);
			mark = sub ? `submodule ${sub}` : "submodule";
		} else mark = streamHashFile(absolute);
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
	repoRoot: string,
	hooks?: FingerprintHooks,
): Promise<RepoDeliveryFingerprint> {
	if (!repoRoot) return { ok: false, reason: "repository_fingerprint_unavailable" };
	const attempt = async (): Promise<RepoDeliveryFingerprint | "retry"> => {
		try {
			const before = await readFence(repoRoot);
			if (!before) return { ok: false, reason: "repository_fingerprint_unavailable" };
			hooks?.afterFence?.();
			const digested = await digestFence(repoRoot, before);
			if (!digested) return { ok: false, reason: "repository_fingerprint_unavailable" };
			const after = await readFence(repoRoot);
			if (!after) return { ok: false, reason: "repository_fingerprint_unavailable" };
			if (before.token !== after.token) return "retry";
			return { ok: true, digest: digested.digest, entries: digested.entries };
		} catch {
			return { ok: false, reason: "repository_fingerprint_unavailable" };
		}
	};
	const first = await attempt();
	if (first !== "retry") return first;
	const second = await attempt();
	if (second === "retry") return { ok: false, reason: "repository_fingerprint_unstable" };
	return second;
}

export async function sharesRepository(left: string, right: string): Promise<boolean> {
	const leftDir = await gitText(left, ["rev-parse", "--absolute-git-dir"]);
	const rightDir = await gitText(right, ["rev-parse", "--absolute-git-dir"]);
	if (!leftDir || !rightDir) return true;
	return leftDir === rightDir;
}
