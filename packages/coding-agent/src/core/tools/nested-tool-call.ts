import { validateToolArguments } from "@caupulican/pi-ai/validation";
import {
	type AgentTool,
	type AgentToolResult,
	type ExecutionContext,
	type ExecutionPathAuthority,
	readAgentToolExecutionError,
	readAgentToolPolicyDeniedError,
} from "../../kernel/index.ts";
import { type BoundToolInvocation, bindToolInvocation } from "../../kernel/tool-invocation-binding.ts";

/**
 * A tool call made from inside another admitted tool call (a `lookup` request, a `python` script's `pi_tools` call).
 * The carrying tool owns no authority of its own: each sub-call is resolved to the session's registered executor
 * for its tool, validated against that tool's schema, bound by that tool's own `bindInvocation`, admitted by the
 * surface (see {@link NestedCallAdmitter}) and executed by that tool's own `execute`. A sub-call the surface refuses
 * settles as a refusal; it is never run unadmitted.
 */

/** One sub-call a carrying tool asks its surface to admit. */
export interface NestedCall {
	/** Unique within the parent call (`<parent id>#<n>`). */
	readonly id: string;
	readonly toolName: string;
	/** Arguments already validated against the tool's own schema. */
	readonly args: Record<string, unknown>;
	/** The sub-call's own binding, as its tool acquired it. */
	readonly executionContext?: ExecutionContext;
	readonly pathAuthority?: ExecutionPathAuthority;
}

/** An admitted sub-call: start it right before its body, finish it with the body's result. */
export interface NestedCallAdmission {
	readonly kind: "admitted";
	/** Runs the hooks the surface registered for the start of the body. A policy refusal throws. */
	start(): void;
	/**
	 * Closes the call after its body returned or threw: the surface's result hooks and terminal records run, then its
	 * cleanups. Returns the policy-finalized content and error flag.
	 */
	finish(
		result: AgentToolResult<unknown>,
		isError: boolean,
		signal?: AbortSignal,
	): Promise<{ content: AgentToolResult<unknown>["content"]; isError: boolean }>;
	/** Drops an admitted call whose body never started. */
	abandon(): void;
}

export interface NestedCallRefusal {
	readonly kind: "refused";
	readonly reason: string;
}

/**
 * The surface's admission of one sub-call of an admitted parent call, through the same checks a standalone call of
 * `call.toolName` faces. A surface with no admission to give refuses; it never admits by default.
 */
export type NestedCallAdmitter = (
	parentToolCallId: string,
	call: NestedCall,
	signal?: AbortSignal,
) => Promise<NestedCallAdmission | NestedCallRefusal>;

export interface NestedCallHost {
	/**
	 * The executor this surface registers under `name` (credential guard, scope envelopes, verification and
	 * directory binding included), or undefined when the surface withholds that tool.
	 */
	resolveTool(name: string): AgentTool | undefined;
	admit: NestedCallAdmitter;
}

export type NestedCallStatus = "ok" | "error" | "refused";

export interface NestedCallOutcome {
	status: NestedCallStatus;
	/** The tool's text; a refusal or a thrown failure reads `refused: <reason>` / `error: <message>`. */
	text: string;
	/** The bare reason of a refusal or a thrown failure. */
	reason?: string;
}

/** A sub-call that is admitted and waiting to run, or one already settled. */
export type StartedNestedCall = { run: () => Promise<NestedCallOutcome> } | { settled: NestedCallOutcome };

export const refusedNestedOutcome = (reason: string): NestedCallOutcome => ({
	status: "refused",
	text: `refused: ${reason}`,
	reason,
});
const errorOutcome = (message: string): NestedCallOutcome => ({
	status: "error",
	text: `error: ${message}`,
	reason: message,
});

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A thrown refusal is a guard answering before the operation; any other throw is a failed operation. */
function outcomeFromThrown(error: unknown): NestedCallOutcome {
	const denial = readAgentToolPolicyDeniedError(error);
	if (denial) return refusedNestedOutcome(denial.message);
	const execution = readAgentToolExecutionError(error);
	if (execution?.failureCode === "credential_access_blocked") return refusedNestedOutcome(execution.message);
	return errorOutcome(describeError(error));
}

function contentText(content: AgentToolResult<unknown>["content"]): string {
	const images = content.filter((block) => block.type === "image").length;
	const text = content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (images === 0) return text;
	return `${text}${text ? "\n" : ""}[${images} image${images === 1 ? "" : "s"} omitted; read the file as its own call to see it]`;
}

function validatedArguments(tool: AgentTool, id: string, args: Record<string, unknown>): Record<string, unknown> {
	const prepared = tool.prepareArguments ? (tool.prepareArguments(args) as Record<string, unknown>) : args;
	return validateToolArguments(
		tool,
		{ type: "toolCall", id, name: tool.name, arguments: prepared },
		{ repairEnabled: false },
	);
}

/**
 * Prepares one sub-call up to admission: resolve the tool, validate the arguments against its schema, acquire its
 * binding, ask the surface to admit it. The returned `run` starts the admitted body and settles it as one outcome;
 * whatever goes wrong around it settles that sub-call only and never rejects.
 */
export async function startNestedCall(
	host: NestedCallHost,
	parentToolCallId: string,
	id: string,
	toolName: string,
	rawArgs: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<StartedNestedCall> {
	const tool = host.resolveTool(toolName);
	if (!tool) return { settled: refusedNestedOutcome(`the ${toolName} tool is not available in this session`) };
	let args: Record<string, unknown>;
	try {
		args = validatedArguments(tool, id, rawArgs);
	} catch (error) {
		return { settled: errorOutcome(`invalid request: ${describeError(error)}`) };
	}
	let binding: BoundToolInvocation | undefined;
	let admission: NestedCallAdmission | NestedCallRefusal;
	try {
		binding = tool.bindInvocation ? await bindToolInvocation(tool, id, args, signal) : undefined;
		admission = await host.admit(
			parentToolCallId,
			{
				id,
				toolName,
				args,
				...(binding ? { executionContext: binding.executionContext } : {}),
				...(binding?.pathAuthority ? { pathAuthority: binding.pathAuthority } : {}),
			},
			signal,
		);
	} catch (error) {
		binding?.release();
		signal?.throwIfAborted();
		return { settled: refusedNestedOutcome(`not admitted (${describeError(error)})`) };
	}
	if (admission.kind === "refused") {
		binding?.release();
		return { settled: refusedNestedOutcome(admission.reason) };
	}
	const executor = binding?.tool ?? tool;
	return {
		run: async () => {
			try {
				try {
					admission.start();
				} catch (error) {
					admission.abandon();
					return outcomeFromThrown(error);
				}
				let result: AgentToolResult<unknown>;
				let thrown: NestedCallOutcome | undefined;
				try {
					result = await executor.execute(id, args as never, signal);
				} catch (error) {
					thrown = outcomeFromThrown(error);
					result = { content: [{ type: "text", text: thrown.text }], details: undefined, isError: true };
				}
				let content = result.content;
				let isError = thrown !== undefined || result.isError === true;
				let hookNote = "";
				try {
					({ content, isError } = await admission.finish(result, isError, signal));
				} catch (error) {
					// The operation ran; a failed result hook is told, not turned into a different result.
					hookNote = `\n[result hooks failed: ${describeError(error)}]`;
				}
				if (thrown) return thrown;
				return { status: isError ? "error" : "ok", text: `${contentText(content)}${hookNote}` };
			} catch (error) {
				// A sub-call settles as its own outcome; whatever went wrong around it never rejects its siblings.
				return outcomeFromThrown(error);
			} finally {
				binding?.release();
			}
		},
	};
}
