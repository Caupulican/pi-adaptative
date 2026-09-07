import {
	createExecutionContext,
	type ExecutionContext,
	type ExecutionPathFlavor,
	resolveExecutionResource,
} from "@caupulican/pi-agent-core/paths";

export interface TaskDirectoryBackend {
	readonly flavor: ExecutionPathFlavor;
	/** Resolve links and require an existing directory; preserve backend error identity. */
	resolveDirectory(path: string, signal?: AbortSignal): Promise<string>;
}

/** Existence and containment are not authority. The host must authorize both path views. */
export function createTaskDirectoryValidator(
	backend: TaskDirectoryBackend,
	authorize: (context: ExecutionContext, resolved: ExecutionContext, signal?: AbortSignal) => Promise<void>,
): (context: ExecutionContext, signal?: AbortSignal) => Promise<void> {
	return async (context, signal) => {
		signal?.throwIfAborted();
		if (context.attachment.flavor !== backend.flavor) {
			throw new Error("Workspace backend differs from its saved attachment; explicitly reattach before executing");
		}
		const root = await backend.resolveDirectory(context.attachment.root, signal);
		signal?.throwIfAborted();
		const cwd = context.cwd === context.attachment.root ? root : await backend.resolveDirectory(context.cwd, signal);
		signal?.throwIfAborted();
		const resolved = createExecutionContext({ ...context, attachment: { ...context.attachment, root }, cwd });
		if (resolveExecutionResource(resolved, { base: "absolute", path: cwd }).workspacePath === undefined) {
			throw new Error("Resolved task directory escaped its workspace attachment");
		}
		await authorize(context, resolved, signal);
		signal?.throwIfAborted();
	};
}
