import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { CredentialProjectIdentity } from "./credential-manager.ts";

const MAX_GIT_POINTER_BYTES = 4 * 1024;
const MAX_GIT_HEAD_BYTES = 1024;
const MAX_GIT_CONFIG_BYTES = 1024 * 1024;

function opaqueKey(kind: "git" | "local", identity: string): string {
	return `${kind}:${createHash("sha256").update(identity).digest("hex")}`;
}

function canonicalizeGitRemote(remote: string): string | undefined {
	const candidate = remote.trim();
	if (!candidate || /[\0\r\n]/.test(candidate)) return undefined;

	if (!candidate.includes("://")) {
		const scp = candidate.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
		if (!scp) return undefined;
		const host = scp[1]?.toLowerCase();
		const path = scp[2]
			?.replace(/^\/+/, "")
			.replace(/\/+$/, "")
			.replace(/\.git$/i, "");
		return host && path ? `${host}/${path}` : undefined;
	}

	try {
		const url = new URL(candidate);
		if (!["git:", "http:", "https:", "ssh:"].includes(url.protocol) || !url.hostname) return undefined;
		const path = url.pathname
			.replace(/^\/+/, "")
			.replace(/\/+$/, "")
			.replace(/\.git$/i, "");
		if (!path) return undefined;
		const host = `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
		return `${host}/${path}`;
	} catch {
		return undefined;
	}
}

export function createPortableGitProjectKey(remote: string): string {
	const canonical = canonicalizeGitRemote(remote);
	if (!canonical) throw new Error("Git remote is not portable.");
	return opaqueKey("git", canonical);
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

function isValidGitHead(head: string): boolean {
	const value = head.endsWith("\n") ? head.slice(0, -1).replace(/\r$/, "") : head;
	if (/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value)) return true;
	const reference = value.match(/^ref: (refs\/.+)$/)?.[1];
	return (
		reference !== undefined &&
		!/[\x00-\x20\x7f~^:?*[\]\\]/.test(reference) &&
		!reference.includes("..") &&
		!reference.includes("@{") &&
		!reference.includes("//") &&
		!reference.endsWith("/") &&
		!reference.endsWith(".") &&
		!reference.endsWith(".lock")
	);
}

async function isGitDirectory(path: string): Promise<boolean> {
	if (!(await isDirectory(path))) return false;
	const head = await readBounded(join(path, "HEAD"), MAX_GIT_HEAD_BYTES);
	return head !== undefined && isValidGitHead(head);
}

async function readBounded(path: string, maxBytes: number): Promise<string | undefined> {
	try {
		const metadata = await stat(path);
		if (!metadata.isFile() || metadata.size > maxBytes) return undefined;
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

interface GitRepositoryLocation {
	root: string;
	gitDir: string;
}

async function resolveGitDirectory(root: string, marker: string): Promise<string | undefined> {
	if (await isGitDirectory(marker)) return marker;
	if (!(await isFile(marker))) return undefined;
	const pointer = await readBounded(marker, MAX_GIT_POINTER_BYTES);
	const gitDirValue = pointer?.match(/^gitdir:\s*(.+?)\s*$/im)?.[1];
	if (!gitDirValue || /[\0\r\n]/.test(gitDirValue)) return undefined;
	const gitDir = resolve(root, gitDirValue);
	return (await isGitDirectory(gitDir)) ? gitDir : undefined;
}

async function findGitRepository(cwd: string): Promise<GitRepositoryLocation | undefined> {
	let current = await realpath(cwd).catch(() => resolve(cwd));
	while (true) {
		const gitDir = await resolveGitDirectory(current, join(current, ".git"));
		if (gitDir) return { root: current, gitDir };
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function resolveGitConfigPath(gitDir: string): Promise<string | undefined> {
	const direct = join(gitDir, "config");
	if (await isFile(direct)) return direct;
	const commonPointer = await readBounded(join(gitDir, "commondir"), MAX_GIT_POINTER_BYTES);
	const commonValue = commonPointer?.trim();
	if (!commonValue || /[\0\r\n]/.test(commonValue)) return undefined;
	const commonDir = isAbsolute(commonValue) ? commonValue : resolve(gitDir, commonValue);
	const shared = join(commonDir, "config");
	return (await isFile(shared)) ? shared : undefined;
}

function readOriginRemote(config: string): string | undefined {
	let inOrigin = false;
	for (const line of config.split(/\r?\n/)) {
		const section = line.match(/^\s*\[([^\]]+)]\s*$/)?.[1];
		if (section !== undefined) {
			inOrigin = /^remote\s+"origin"$/i.test(section.trim());
			continue;
		}
		if (!inOrigin) continue;
		const assignment = line.match(/^\s*url\s*=\s*(.*?)\s*$/i)?.[1];
		if (assignment) return assignment;
	}
	return undefined;
}

export async function resolveCredentialProject(cwd: string): Promise<CredentialProjectIdentity> {
	const repository = await findGitRepository(cwd);
	const root = repository?.root ?? (await realpath(cwd).catch(() => resolve(cwd)));
	if (repository) {
		const configPath = await resolveGitConfigPath(repository.gitDir);
		const config = configPath ? await readBounded(configPath, MAX_GIT_CONFIG_BYTES) : undefined;
		const remote = config ? readOriginRemote(config) : undefined;
		const canonical = remote ? canonicalizeGitRemote(remote) : undefined;
		if (canonical) {
			return { key: opaqueKey("git", canonical), root, label: basename(root), portable: true };
		}
	}
	return {
		key: opaqueKey("local", `${hostname()}\0${root}`),
		root,
		label: basename(root) || root,
		portable: false,
	};
}
