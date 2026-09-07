import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readlink, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutionContext, ExecutionPathAuthority, ExecutionPathFlavor } from "@caupulican/pi-agent-core";
import { executionPathApi } from "@caupulican/pi-agent-core/paths";
import { getWorkTenantDir } from "../agent-paths.ts";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
import { awaitPreflight } from "../preflight.ts";
import { isMissingPathError } from "../util/filesystem-errors.ts";
import type { TaskDirectoryBackend } from "./task-directory-validation.ts";

function directoryIdentity(info: BigIntStats): string {
	// No timestamps: birthtime may be ctime on filesystems without creation time, and may
	// change on Darwin. Bigints preserve native device/file IDs without precision loss.
	return createHash("sha256").update(`${info.dev}:${info.ino}`).digest("hex").slice(0, 32);
}

const MAX_LINK_HOPS = 40;

/**
 * Spell a link target the way the executing backend names it. The native realpath binding reports
 * the kernel's final name, which on Windows can be a volume GUID namespace with no DOS spelling;
 * that form is not a usable execution path. A mount point is the canonical DOS name of the volume it
 * mounts, so a link whose target only has a volume name resolves to the link itself.
 */
export function resolveNativeLinkTarget(linkPath: string, target: string, flavor: ExecutionPathFlavor): string {
	const paths = executionPathApi(flavor);
	let spelled = target;
	if (flavor === "win32") {
		if (/^[\\/]{2}[?.][\\/]UNC[\\/]/iu.test(spelled)) spelled = `\\\\${spelled.slice(8)}`;
		else if (/^[\\/]{2}[?.][\\/]/u.test(spelled)) spelled = spelled.slice(4);
		if (/^Volume\{[0-9A-Fa-f-]+\}/u.test(spelled)) return linkPath;
	}
	return paths.isAbsolute(spelled) ? paths.resolve(spelled) : paths.resolve(paths.dirname(linkPath), spelled);
}

/**
 * Canonicalize component by component in the backend's own syntax. The filesystem root is its own
 * canonical name, so a session started at a drive or filesystem root always admits; every resolved
 * link keeps a drive/UNC spelling. Missing and non-directory components surface with their native codes.
 */
async function canonicalizeNativePath(
	path: string,
	flavor: ExecutionPathFlavor,
	signal?: AbortSignal,
	hops = 0,
): Promise<string> {
	const paths = executionPathApi(flavor);
	const absolute = paths.resolve(path);
	const { root } = paths.parse(absolute);
	const segments = absolute
		.slice(root.length)
		.split(flavor === "win32" ? /[\\/]+/u : /\/+/u)
		.filter((segment) => segment.length > 0);
	let current = root;
	for (const segment of segments) {
		signal?.throwIfAborted();
		const candidate = paths.join(current, segment);
		const info = await lstat(candidate);
		if (!info.isSymbolicLink()) {
			current = candidate;
			continue;
		}
		if (hops >= MAX_LINK_HOPS) {
			throw Object.assign(new Error(`Too many links while resolving ${candidate}`), { code: "ELOOP" });
		}
		const target = resolveNativeLinkTarget(candidate, await readlink(candidate), flavor);
		current = target === candidate ? candidate : await canonicalizeNativePath(target, flavor, signal, hops + 1);
	}
	return current;
}

function requireDirectory(info: { isDirectory(): boolean }): void {
	if (!info.isDirectory())
		throw Object.assign(new Error("Task working directory is not a directory"), { code: "ENOTDIR" });
}

export interface NativeTaskDirectoryBackend extends TaskDirectoryBackend, Omit<ExecutionPathAuthority, "flavor"> {
	createAttachmentId(root: string, nonce?: string, signal?: AbortSignal): Promise<string>;
	validateAttachment(context: ExecutionContext, resolved: ExecutionContext, signal?: AbortSignal): Promise<void>;
}

/** Native adapter only. Remote/virtual backends must provide their own directory resolver. */
export function createNativeTaskDirectoryBackend(agentDir?: string): NativeTaskDirectoryBackend {
	const hostPrefix = `native:${createHash("sha256").update(`${process.platform}\0${hostname()}`).digest("hex").slice(0, 32)}:`;
	const home = homedir();
	const resolvedAgentDir = resolve(agentDir ?? join(home, ".pi", "agent"));
	const flavor: ExecutionPathFlavor = process.platform === "win32" ? "win32" : "posix";
	return {
		flavor,
		caseSensitive: process.platform !== "win32",
		homeDir: home,
		harnessRoots: [
			join(resolvedAgentDir, "okf-memory"),
			join(resolvedAgentDir, "skills"),
			join(resolvedAgentDir, "sessions"),
			join(resolvedAgentDir, "memory"),
			getWorkTenantDir(resolvedAgentDir, "context", "sessions"),
		],
		harnessFiles: [join(resolvedAgentDir, "MEMORY.md"), join(resolvedAgentDir, "USER.md")],
		async canonicalPath(path: string, signal?: AbortSignal): Promise<string | undefined> {
			signal?.throwIfAborted();
			try {
				return await canonicalizeNativePath(path, flavor, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				if (isMissingPathError(error)) return undefined;
				throw error;
			}
		},
		async isFile(path: string, signal?: AbortSignal): Promise<boolean | undefined> {
			signal?.throwIfAborted();
			try {
				const info = await stat(path);
				return info.isFile();
			} catch (error) {
				if (signal?.aborted) throw error;
				if (isMissingPathError(error)) return undefined;
				throw error;
			}
		},
		async safeRealpath(path: string, signal?: AbortSignal): Promise<string> {
			signal?.throwIfAborted();
			return safeRealpathSync(path);
		},
		async createAttachmentId(root: string, nonce = randomUUID(), signal?: AbortSignal): Promise<string> {
			const info = await awaitPreflight(() => stat(root, { bigint: true }), signal);
			signal?.throwIfAborted();
			requireDirectory(info);
			return `${hostPrefix}${directoryIdentity(info)}:${nonce}`;
		},
		async validateAttachment(
			context: ExecutionContext,
			_resolved: ExecutionContext,
			signal?: AbortSignal,
		): Promise<void> {
			signal?.throwIfAborted();
			if (!context.attachment.attachmentId.startsWith(hostPrefix))
				throw new Error(
					"Workspace attachment belongs to another host or is unavailable; use task_directory reattach",
				);
			const info = await stat(context.attachment.root, { bigint: true });
			signal?.throwIfAborted();
			if (!context.attachment.attachmentId.startsWith(`${hostPrefix}${directoryIdentity(info)}:`))
				throw new Error("Workspace directory identity changed; use task_directory reattach before executing");
		},
		async resolveDirectory(path: string, signal?: AbortSignal): Promise<string> {
			signal?.throwIfAborted();
			const resolved = await canonicalizeNativePath(path, flavor, signal);
			signal?.throwIfAborted();
			const info = await stat(resolved);
			signal?.throwIfAborted();
			requireDirectory(info);
			return resolved;
		},
	};
}
