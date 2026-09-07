import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import type { ExecutionContext } from "@caupulican/pi-agent-core/paths";
import type { TaskDirectoryBackend } from "./task-directory-validation.ts";

function directoryIdentity(info: BigIntStats): string {
	// No timestamps: birthtime may be ctime on filesystems without creation time, and may
	// change on Darwin. Bigints preserve native device/file IDs without precision loss.
	return createHash("sha256").update(`${info.dev}:${info.ino}`).digest("hex").slice(0, 32);
}

interface NativeTaskDirectoryBackend extends TaskDirectoryBackend {
	createAttachmentId(root: string, nonce?: string): string;
	validateAttachment(context: ExecutionContext, resolved: ExecutionContext, signal?: AbortSignal): Promise<void>;
}

/** Native adapter only. Remote/virtual backends must provide their own directory resolver. */
export function createNativeTaskDirectoryBackend(): NativeTaskDirectoryBackend {
	const hostPrefix = `native:${createHash("sha256").update(`${process.platform}\0${hostname()}`).digest("hex").slice(0, 32)}:`;
	return {
		flavor: process.platform === "win32" ? "win32" : "posix",
		createAttachmentId(root, nonce = randomUUID()) {
			const info = statSync(root, { bigint: true, throwIfNoEntry: false });
			// A missing ambient root must not prevent status/reattach. It never gains authority if
			// another directory later appears there: only an explicit attachment captures identity.
			return info ? `${hostPrefix}${directoryIdentity(info)}:${nonce}` : `unattached:${nonce}`;
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
			if (!info.isDirectory())
				throw Object.assign(new Error("Task working directory is not a directory"), { code: "ENOTDIR" });
			return resolved;
		},
	};
}
