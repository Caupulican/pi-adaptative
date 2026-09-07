import { posix, win32 } from "node:path";
import {
	assertExecutionAbsolutePath,
	captureExecutionContext,
	type ExecutionContext,
	type ExecutionPathFlavor,
} from "./execution-context.ts";

export {
	assertExecutionAbsolutePath,
	type ExecutionAttachment,
	type ExecutionContext,
	type ExecutionPathFlavor,
} from "./execution-context.ts";

/** Backend-owned syntax. Never selected from process.platform or the spelling of a tool argument. */
export function executionPathApi(flavor: ExecutionPathFlavor): typeof posix {
	if (flavor === "posix") return posix;
	if (flavor === "win32") return win32;
	throw new Error("Unsupported execution path flavor");
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

/** Host construction boundary; a path is not a workspace identity or an authority grant. */
export function createExecutionContext(input: ExecutionContext): ExecutionContext {
	const captured = captureExecutionContext(input);
	const paths = executionPathApi(captured.attachment.flavor);
	return captureExecutionContext({
		...captured,
		attachment: { ...captured.attachment, root: paths.normalize(captured.attachment.root) },
		cwd: paths.normalize(captured.cwd),
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
