/** Ordered execution events and protocol results for admitted and declined tool calls. */
import type { ToolResultMessage } from "@caupulican/pi-ai/types";
import type { AgentEventSink } from "./agent-loop.ts";
import { retainCommittedToolReceipt } from "./committed-tool-receipt.ts";
import { stampToolInvocation } from "./tool-invocation-receipt.ts";
import type {
	AgentRequestId,
	AgentToolCall,
	AgentToolResult,
	CommittedToolReport,
	ToolCallRepairInfo,
} from "./types.ts";

interface ToolCallEventOutcome {
	committedReport?: CommittedToolReport;
	toolCall: AgentToolCall;
	result: AgentToolResult<unknown>;
	isError: boolean;
}

export async function declineCallsAfterCompletion(
	calls: readonly AgentToolCall[],
	requestId: AgentRequestId,
	emit: AgentEventSink,
	messages: ToolResultMessage[],
): Promise<void> {
	for (const toolCall of calls) {
		const outcome: ToolCallEventOutcome = {
			toolCall,
			isError: true,
			result: {
				content: [
					{
						type: "text",
						text: "This call did not start because an earlier call completed the work in this batch.",
					},
				],
				details: stampToolInvocation(
					{},
					{ version: 1, requestId, execution: "not_started", postprocessingFailures: [] },
				),
			},
		};
		await emitToolExecutionStart(toolCall, emit);
		await emitToolExecutionEnd(outcome, emit);
		const message = createToolResultMessage(outcome);
		await emitToolResultMessage(message, emit);
		messages.push(message);
	}
}

export async function emitToolExecutionStart(toolCall: AgentToolCall, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
		repair: getToolCallRepairInfo(toolCall),
	});
}

export function getToolCallRepairInfo(toolCall: AgentToolCall): ToolCallRepairInfo | undefined {
	if (!toolCall.rawArguments && !toolCall.repairNotes?.length) return undefined;
	return {
		repaired: true,
		...(toolCall.rawArguments ? { rawArguments: toolCall.rawArguments } : {}),
		...(toolCall.repairNotes?.length ? { notes: toolCall.repairNotes } : {}),
	};
}

export async function emitToolExecutionEnd(finalized: ToolCallEventOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
		repair: getToolCallRepairInfo(finalized.toolCall),
	});
}

export function createToolResultMessage(finalized: ToolCallEventOutcome): ToolResultMessage {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		...(finalized.toolCall.toolSearch
			? {
					toolSearch: {
						strict: finalized.toolCall.toolSearch.strict,
						tools: finalized.isError ? [] : structuredClone(finalized.toolCall.toolSearch.tools),
					},
				}
			: {}),
		content: finalized.result.content,
		details: finalized.result.details,
		usage: finalized.result.usage,
		isError: finalized.isError,
		// Persisted so a reloaded transcript still separates a completed operation's own status from a
		// tool that could not run at all.
		...(finalized.isError && finalized.result.errorKind ? { errorKind: finalized.result.errorKind } : {}),
		timestamp: Date.now(),
	};
	if (finalized.committedReport) retainCommittedToolReceipt(message);
	return message;
}

export async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
