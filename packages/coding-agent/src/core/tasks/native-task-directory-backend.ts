import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutionContext, ExecutionPathAuthority } from "@caupulican/pi-agent-core";
import { getWorkTenantDir } from "../agent-paths.ts";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
import { awaitPreflight } from "../preflight.ts";
import type { TaskDirectoryBackend } from "./task-directory-validation.ts";

function directoryIdentity(info: BigIntStats): string {
	// No timestamps: birthtime may be ctime on filesystems without creation time, and may
	// change on Darwin. Bigints preserve native device/file IDs without precision loss.
	return createHash("sha256").update(`${info.dev}:${info.ino}`).digest("hex").slice(0, 32);
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
	return {
		flavor: process.platform === "win32" ? "win32" : "posix",
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
				return await realpath(path);
			} catch {
				return undefined;
			}
		},
		async isFile(path: string, signal?: AbortSignal): Promise<boolean | undefined> {
			signal?.throwIfAborted();
			try {
				const info = await stat(path);
				return info.isFile();
			} catch {
				return undefined;
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
			const resolved = await realpath(path);
			signal?.throwIfAborted();
			const info = await stat(resolved);
			signal?.throwIfAborted();
			requireDirectory(info);
			return resolved;
		},
	};
}
