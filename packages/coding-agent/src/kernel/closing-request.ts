/** Selects the input that owns a request, builds tool-free contexts, and deduplicates closing instructions. */
import { countHistoryWork } from "@caupulican/pi-ai/history-work";
import type { AgentContext, AgentHaltRequest, AgentLoopConfig } from "./loop-config.ts";
import { serializedMessagesEqual } from "./message-revision.ts";
import type { AgentMessage } from "./types.ts";
import type { VerificationObligationTracker } from "./verification-obligations.ts";
import { isExternalEvidenceMessage } from "./worker-control-stamp.ts";

const RUNAWAY_STOP_CLOSING_SYSTEM_PROMPT = [
	"RUNAWAY STOP CLOSING TURN",
	"The host stopped a repeated tool-call loop. No tools are available in this final request.",
	"Write one concise factual closing message for the user: completed work, the unresolved operation or blocker, and the safest next action.",
	"Do not claim unperformed work. Do not emit a tool call or tool-call markup.",
].join("\n");

export interface HaltReport {
	instruction: Extract<AgentMessage, { role: "user" }>;
	systemDirective?: string;
}

export function closingRequestContext(
	context: AgentContext,
	halt?: HaltReport,
	obligations?: VerificationObligationTracker,
): AgentContext {
	// The worker control row already contains the complete reporting instruction. Keep the
	// request prefix intact. The loop enforces the execution boundary on the returned response.
	if (halt && halt.systemDirective === undefined) return { ...context, instructionTail: halt.instruction };
	const directive = halt?.systemDirective ?? RUNAWAY_STOP_CLOSING_SYSTEM_PROMPT;
	return {
		...toolFreeRequestContext(context, "the tool-free closing request withholds every tool"),
		systemPrompt: context.systemPrompt ? `${context.systemPrompt}\n\n${directive}` : directive,
		trailingInstruction: obligations?.requestInstruction(),
		...(halt ? { instructionTail: halt.instruction } : {}),
	};
}

export function toolFreeRequestContext(context: AgentContext, surfaceChange: string): AgentContext {
	return { ...context, tools: [], surfaceChange };
}

/** A plain halt instruction may be persisted or converted as one text block. */
export function closingInstructionText(content: HaltReport["instruction"]["content"]): string | undefined {
	if (typeof content === "string") return content;
	if (content.length === 1 && content[0]?.type === "text") return content[0].text;
	return undefined;
}

export function previousHaltMessage(
	messages: AgentMessage[],
	halt: AgentHaltRequest,
): HaltReport["instruction"] | undefined {
	if (halt.firstDelivery) return undefined;
	// A re-attempt may follow an aborted assistant response or a retained host record. The
	// most recent user row tells us whether this control instruction already reached the transcript.
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "user") continue;
		countHistoryWork(messages, "oldRowsRead", messages.length - index);
		return closingInstructionText(message.content) === halt.userMessage ? message : undefined;
	}
	countHistoryWork(messages, "oldRowsRead", messages.length);
	return undefined;
}

/** A retry can carry a failed response behind the durable halt row. Only the provider view moves the instruction. */
export function closingProviderHistory(
	source: AgentContext,
	messages: AgentMessage[],
	head: number,
): { messages: AgentMessage[]; head: number } {
	if (!source.instructionTail) return { messages, head };
	const instruction = source.instructionTail === true ? source.messages.at(-1) : source.instructionTail;
	if (!instruction) throw new Error("A closing provider request needs its durable instruction.");
	const matches = (candidate: AgentMessage): boolean => preservesClosingInstruction(instruction, candidate);
	const index = messages.findLastIndex(matches);
	if (index === -1) throw new Error("Provider context plan did not preserve the closing instruction.");
	if (index === messages.length - 1) return { messages, head };
	const reordered = messages.slice();
	reordered.push(...reordered.splice(index, 1));
	countHistoryWork(source.messages, "copiedRows", messages.length);
	return { messages: reordered, head: head - Number(index < head) };
}

/** Halt tool policy permits only the message's literal user instruction through conversion. */
export function preservesClosingInstruction(source: AgentMessage, converted: AgentMessage | undefined): boolean {
	if (source.role !== "user" || converted?.role !== "user" || converted.timestamp !== source.timestamp) {
		return false;
	}
	if (source === converted) return true;
	const original = closingInstructionText(source.content);
	return original !== undefined
		? closingInstructionText(converted.content) === original
		: serializedMessagesEqual(source, converted);
}

export function selectRequestOpening(
	messages: readonly AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	previous?: AgentMessage,
): AgentMessage | undefined {
	let fallback: AgentMessage | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user" && !isExternalEvidenceMessage(message)) return message;
		if (message.role !== "custom") continue;
		fallback ??= message;
		if (config.resolveResponseMode?.({ ...context, requestOpening: message }) !== undefined) return message;
	}
	return previous ?? fallback;
}

export function requestContextForOpening(
	context: AgentContext,
	messages: readonly AgentMessage[],
	config: AgentLoopConfig,
	state: Pick<AgentContext, "requestOpening">,
): AgentContext {
	state.requestOpening = selectRequestOpening(
		messages.length ? messages : context.messages.slice(-1),
		context,
		config,
		state.requestOpening,
	);
	return {
		...context,
		requestOpening: state.requestOpening,
		messages: config.workingHistory?.refresh(context.messages) ?? context.messages.slice(),
	};
}
