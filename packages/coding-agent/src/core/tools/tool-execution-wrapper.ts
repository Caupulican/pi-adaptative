import { captureExecutionContext, type ExecutionContext } from "@caupulican/pi-agent-core";

interface ExecutableTool {
	execute: (...args: never[]) => unknown;
	bindInvocation?: (...args: never[]) => Promise<{
		executionContext: ExecutionContext;
		execute: (...args: never[]) => unknown;
		failureRecovery?: unknown;
		release(): void;
	}>;
}

/** Apply a tool decorator to both direct and admitted execution, without acquiring a second lease. */
export function wrapToolExecution<T extends ExecutableTool>(
	tool: T,
	decorate: (executor: T, executionContext?: ExecutionContext) => T,
): T {
	const wrapped = decorate(tool);
	const bind = tool.bindInvocation;
	if (!bind) return wrapped;
	return {
		...wrapped,
		execute: wrapped.execute.bind(wrapped),
		bindInvocation: async (...args: Parameters<NonNullable<T["bindInvocation"]>>) => {
			const invocation = await bind.call(tool, ...args);
			try {
				const executionContext = captureExecutionContext(invocation.executionContext);
				// Only executor-owned fields change. Never let invocation metadata replace the registry schema or name.
				const bound = decorate(
					{
						...tool,
						execute: invocation.execute.bind(invocation),
						failureRecovery: invocation.failureRecovery,
						bindInvocation: undefined,
					} as T,
					executionContext,
				);
				return {
					...invocation,
					executionContext,
					execute: bound.execute.bind(bound),
					// Prototype methods are not enumerable; the original lease remains the owner.
					release: () => invocation.release(),
					...("failureRecovery" in bound ? { failureRecovery: bound.failureRecovery } : {}),
				};
			} catch (error) {
				invocation.release();
				throw error;
			}
		},
	} as T;
}
