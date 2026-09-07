import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import type { ExecutionContext } from "@caupulican/pi-agent-core/paths";
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

interface NativeTaskDirectoryBackend extends TaskDirectoryBackend {
	createAttachmentId(root: string, nonce?: string, signal?: AbortSignal): Promise<string>;
	validateAttachment(context: ExecutionContext, resolved: ExecutionContext, signal?: AbortSignal): Promise<void>;
}

/** Native adapter only. Remote/virtual backends must provide their own directory resolver. */
export function createNativeTaskDirectoryBackend(): NativeTaskDirectoryBackend {
	const hostPrefix = `native:${createHash("sha256").update(`${process.platform}\0${hostname()}`).digest("hex").slice(0, 32)}:`;
	return {
		flavor: process.platform === "win32" ? "win32" : "posix",
		async createAttachmentId(root, nonce = randomUUID(), signal) {
			const info = await awaitPreflight(() => stat(root, { bigint: true }), signal);
			signal?.throwIfAborted();
			requireDirectory(info);
			return `${hostPrefix}${directoryIdentity(info)}:${nonce}`;
		},
		async validateAttachment(context, _resolved, signal) {
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
		async resolveDirectory(path, signal) {
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
