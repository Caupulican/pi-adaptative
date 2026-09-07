import type { Static, TSchema } from "typebox";
import { captureExecutionContext, type ExecutionContext } from "./execution-context.ts";
import { getToolExecutionKey } from "./tool-failure-memory.ts";
import type { AgentTool } from "./types.ts";

export interface BoundToolInvocation<TParameters extends TSchema = TSchema, TDetails = unknown> {
	readonly tool: AgentTool<TParameters, TDetails>;
	readonly executionContext: ExecutionContext;
	readonly executionScope: string;
	release(): void;
}

/** One binding identity for live admission, durable handoff, and recovery evidence. */
export function executionContextScope(context: ExecutionContext): string {
	return getToolExecutionKey("context", context);
}

/** The schema and scheduling identity stay registry-owned; only execution is host-bound. */
export async function bindToolInvocation<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
	id: string,
	args: Static<TParameters>,
	signal?: AbortSignal,
): Promise<BoundToolInvocation<TParameters, TDetails> | undefined> {
	if (!tool.bindInvocation) return undefined;
	signal?.throwIfAborted();
	const invocation = await tool.bindInvocation(id, args, signal);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		invocation.release();
	};
	try {
		signal?.throwIfAborted();
		const executionContext = captureExecutionContext(invocation.executionContext);
		return {
			tool: { ...tool, execute: invocation.execute.bind(invocation), failureRecovery: invocation.failureRecovery },
			executionContext,
			executionScope: executionContextScope(executionContext),
			release,
		};
	} catch (error) {
		release();
		throw error;
	}
}
