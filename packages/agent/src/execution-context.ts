import { readWireRecord } from "./wire-record.ts";

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
	/** Optional host task identity; distinct tasks never share invocation/recovery identity by accident. */
	readonly taskId?: string;
	readonly generation: number;
	readonly cwd: string;
}

/** Live filesystem capabilities for an executing backend. Not serialized to journal data. */
export interface ExecutionPathAuthority {
	readonly flavor?: ExecutionPathFlavor;
	readonly caseSensitive?: boolean;
	canonicalPath(path: string, signal?: AbortSignal): Promise<string | undefined> | string | undefined;
	isFile?(path: string, signal?: AbortSignal): Promise<boolean | undefined> | boolean | undefined;
	safeRealpath?(path: string, signal?: AbortSignal): Promise<string> | string;
	readonly homeDir?: string;
	readonly harnessRoots?: readonly string[];
	readonly harnessFiles?: readonly string[];
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
	for (const identity of [
		input.sessionId,
		input.attachment.workspaceId,
		input.attachment.attachmentId,
		...(input.taskId === undefined ? [] : [input.taskId]),
	]) {
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
		...(input.taskId === undefined ? {} : { taskId: input.taskId }),
		generation: input.generation,
		cwd: input.cwd,
	});
}

const CONTEXT_FIELDS = new Set(["attachment", "sessionId", "taskId", "generation", "cwd"]);
const ATTACHMENT_FIELDS = new Set(["workspaceId", "attachmentId", "root", "flavor", "caseSensitive"]);

/** Decode journal/wire data without evaluating accessors or retaining caller-owned objects. */
export function decodeExecutionContext(value: unknown): ExecutionContext | undefined {
	try {
		const record = readWireRecord(value, CONTEXT_FIELDS);
		if (!record) return undefined;
		const attachment = readWireRecord(record.attachment, ATTACHMENT_FIELDS);
		if (
			!attachment ||
			typeof record.sessionId !== "string" ||
			(record.taskId !== undefined && typeof record.taskId !== "string") ||
			typeof record.generation !== "number" ||
			typeof record.cwd !== "string" ||
			typeof attachment.workspaceId !== "string" ||
			typeof attachment.attachmentId !== "string" ||
			typeof attachment.root !== "string" ||
			(attachment.flavor !== "posix" && attachment.flavor !== "win32") ||
			typeof attachment.caseSensitive !== "boolean"
		)
			return undefined;
		return captureExecutionContext({
			attachment: {
				workspaceId: attachment.workspaceId,
				attachmentId: attachment.attachmentId,
				root: attachment.root,
				flavor: attachment.flavor,
				caseSensitive: attachment.caseSensitive,
			},
			sessionId: record.sessionId,
			taskId: record.taskId,
			generation: record.generation,
			cwd: record.cwd,
		});
	} catch {
		return undefined;
	}
}
