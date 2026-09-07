/** Backend syntax and immutable invocation identity, independent of Node or a local filesystem. */
export type ExecutionPathFlavor = "posix" | "win32";

export interface ExecutionAttachment {
	readonly workspaceId: string;
	readonly attachmentId: string;
	readonly root: string;
	readonly flavor: ExecutionPathFlavor;
	readonly caseSensitive: boolean;
}

export interface ExecutionContext {
	readonly attachment: ExecutionAttachment;
	readonly sessionId: string;
	readonly generation: number;
	readonly cwd: string;
}

export function assertExecutionAbsolutePath(value: string, flavor: ExecutionPathFlavor): void {
	if (flavor !== "posix" && flavor !== "win32") throw new Error("Unsupported execution path flavor");
	if (value.includes("\0") || (flavor === "posix" && !value.startsWith("/"))) {
		throw new Error("Execution context requires an absolute path without NUL bytes");
	}
	if (flavor === "win32" && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value)) {
		throw new Error("Windows execution context requires a drive or UNC share");
	}
}

/** Capture an already backend-resolved context without consulting the operator's filesystem. */
export function captureExecutionContext(input: ExecutionContext): ExecutionContext {
	for (const identity of [input.sessionId, input.attachment.workspaceId, input.attachment.attachmentId]) {
		if (!identity || identity.length > 256 || /[\u0000-\u001f\u007f]/u.test(identity)) {
			throw new Error("Execution identity must be bounded nonempty text");
		}
	}
	if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error("Invalid execution generation");
	if (typeof input.attachment.caseSensitive !== "boolean") throw new Error("Missing filesystem case policy");
	assertExecutionAbsolutePath(input.attachment.root, input.attachment.flavor);
	assertExecutionAbsolutePath(input.cwd, input.attachment.flavor);
	return Object.freeze({
		attachment: Object.freeze({ ...input.attachment }),
		sessionId: input.sessionId,
		generation: input.generation,
		cwd: input.cwd,
	});
}
