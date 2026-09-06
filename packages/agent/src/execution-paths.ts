import { posix, win32 } from "node:path";

export type ExecutionPathFlavor = "posix" | "win32";

/** Backend-owned syntax. Never selected from process.platform or the spelling of a tool argument. */
export function executionPathApi(flavor: ExecutionPathFlavor): typeof posix {
	if (flavor === "posix") return posix;
	if (flavor === "win32") return win32;
	throw new Error("Unsupported execution path flavor");
}

export function assertExecutionAbsolutePath(value: string, flavor: ExecutionPathFlavor): void {
	if (value.includes("\0") || !executionPathApi(flavor).isAbsolute(value)) {
		throw new Error("Execution context requires an absolute path without NUL bytes");
	}
	if (flavor === "win32" && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value)) {
		throw new Error("Windows execution context requires a drive or UNC share");
	}
}

/** Pure lexical resolution. Authorization must separately consult the backend filesystem. */
export function resolveExecutionPath(input: string, cwd: string, flavor: ExecutionPathFlavor): string {
	assertExecutionAbsolutePath(cwd, flavor);
	if (input.includes("\0")) throw new Error("Execution path contains NUL bytes");
	if (flavor === "win32" && /^[A-Za-z]:(?![\\/])/u.test(input)) {
		throw new Error("Ambiguous drive-relative execution path; supply a fully qualified path");
	}
	return executionPathApi(flavor).resolve(cwd, input);
}

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

/** Host construction boundary; a path is not a workspace identity or an authority grant. */
export function createExecutionContext(input: ExecutionContext): ExecutionContext {
	for (const identity of [input.sessionId, input.attachment.workspaceId, input.attachment.attachmentId]) {
		if (!identity || identity.length > 256 || /[\u0000-\u001f\u007f]/u.test(identity)) {
			throw new Error("Execution identity must be bounded nonempty text");
		}
	}
	if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error("Invalid execution generation");
	if (typeof input.attachment.caseSensitive !== "boolean") throw new Error("Missing filesystem case policy");
	const { flavor } = input.attachment;
	assertExecutionAbsolutePath(input.attachment.root, flavor);
	assertExecutionAbsolutePath(input.cwd, flavor);
	const paths = executionPathApi(flavor);
	return Object.freeze({
		attachment: Object.freeze({ ...input.attachment, root: paths.normalize(input.attachment.root) }),
		sessionId: input.sessionId,
		generation: input.generation,
		cwd: paths.normalize(input.cwd),
	});
}

export type ExecutionResourceReference = {
	readonly base: "workspace" | "cwd" | "absolute";
	readonly path: string;
};

export interface ResolvedExecutionResource {
	readonly context: ExecutionContext;
	readonly path: string;
	/** Only present for a resource lexically inside this attachment; not proof of filesystem authority. */
	readonly workspacePath?: string;
}

export function resolveExecutionResource(
	context: ExecutionContext,
	resource: ExecutionResourceReference,
): ResolvedExecutionResource {
	const { attachment } = context;
	const paths = executionPathApi(attachment.flavor);
	if (resource.base === "absolute") assertExecutionAbsolutePath(resource.path, attachment.flavor);
	else if (resource.base !== "workspace" && resource.base !== "cwd") throw new Error("Unknown resource base");
	else if (resource.base === "workspace" && paths.isAbsolute(resource.path)) {
		throw new Error("Workspace resource references must be relative to their attachment");
	}
	const path = resolveExecutionPath(
		resource.path,
		resource.base === "workspace" ? attachment.root : context.cwd,
		attachment.flavor,
	);
	const root = attachment.root.replace(attachment.flavor === "win32" ? /[\\/]+$/u : /\/+$/u, "");
	const targetIdentity = attachment.caseSensitive ? path : path.toLowerCase();
	const rootIdentity = attachment.caseSensitive ? root : root.toLowerCase();
	const inside = targetIdentity === rootIdentity || targetIdentity.startsWith(`${rootIdentity}${paths.sep}`);
	if (resource.base === "workspace" && !inside) throw new Error("Resource escaped its workspace attachment");
	return Object.freeze({
		context,
		path,
		...(inside ? { workspacePath: path.slice(root.length).replace(/^[\\/]/u, "") } : {}),
	});
}
