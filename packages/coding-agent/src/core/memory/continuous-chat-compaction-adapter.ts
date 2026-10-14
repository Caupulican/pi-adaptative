/**
 * Compaction port over the foreground's accepted provider prefix. Each compaction repeats the accepted request's system
 * prompt and tools, then sends its view and task through the isolated request path. The conversation is plain text: a
 * tool call or a stop other than "stop" fails the node.
 */

import { randomUUID } from "node:crypto";
import type { Api, Message, Model, Tool, Usage } from "@caupulican/pi-ai";
import type { AgentContext } from "../../kernel/loop-config.ts";
import { projectToolsForProvider } from "../../kernel/provider-tool-projection.ts";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session-contracts.ts";
import { hasReportableUsage } from "../spawned-usage.ts";
import type {
	ContinuousChatCompactionConversation,
	ContinuousChatCompactionPort,
	ContinuousChatCompactionPrefix,
} from "./continuous-chat-compaction.ts";
import { renderContinuousChatViewBlocks } from "./continuous-chat-projection.ts";
import {
	CONTINUOUS_CHAT_COMPACTION_THINKING_LEVEL,
	type ContinuousChatSummaryModelResolution,
} from "./continuous-chat-settings.ts";

/** Report-id prefix of a compaction reply's paid spend in the history-usage owner. */
const CONTINUOUS_CHAT_USAGE_KIND = "memory-continuous-chat-compaction";

/** The exact system prompt and tools of a provider request. A compaction repeats both. */
export interface ContinuousChatPrefixSnapshot {
	systemPrompt: string;
	tools: readonly Tool[];
}

/** The prefix an agent context sends, with its tools projected the way the request planner projects them. */
export function continuousChatPrefixOf(
	context: Pick<AgentContext, "systemPrompt" | "tools">,
): ContinuousChatPrefixSnapshot {
	return { systemPrompt: context.systemPrompt, tools: projectToolsForProvider(context.tools ?? []) };
}

/**
 * The accepted provider prefix. The accepted-request hook records it. Until a request is accepted, `resolve` falls back
 * to the agent's current prefix, which is what the next request will send.
 */
export class ContinuousChatPrefixSource {
	private accepted: ContinuousChatPrefixSnapshot | undefined;

	record(snapshot: ContinuousChatPrefixSnapshot): void {
		this.accepted = snapshot;
	}

	/** Discards the recorded snapshot, so `resolve` falls back to the agent's current prefix again. */
	reset(): void {
		this.accepted = undefined;
	}

	current(): ContinuousChatPrefixSnapshot | undefined {
		return this.accepted;
	}

	resolve(fallback: () => ContinuousChatPrefixSnapshot): ContinuousChatPrefixSnapshot {
		return this.accepted ?? fallback();
	}
}

/** The compaction port the host activates. `validate()` runs before any legacy import, runtime start or dispatch. */
export interface ContinuousChatCompactionAdapterPort extends ContinuousChatCompactionPort {
	/** Throws one actionable Error when the configured summary model cannot run the chat's compactions. */
	validate(): void;
}

export interface ContinuousChatCompactionAdapterDeps {
	/** The owner's isolated completion, `ReflectionController.runIsolatedCompletion`. */
	complete(options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** The getter the runtime also receives as `prefixHead`, so a compaction and its job agree on the snapshot. */
	prefixHead(): ContinuousChatPrefixSnapshot;
	/** The configured summary model, checked now: setting, registry, egress and thinking level. */
	summary(): ContinuousChatSummaryModelResolution;
	/** Records one reply's paid spend in the history-usage owner. Must not throw. */
	recordUsage(usage: Usage, call: { reportId: string; provider: string; model: string }): void;
	/** Notifies the session when a summary model fails at runtime so `summary()` can self-heal onto a healthy model. */
	onModelFailure?(model: Model<Api>, errorMessage: string | undefined): void;
}

export class ContinuousChatCompactionAdapter implements ContinuousChatCompactionAdapterPort {
	private readonly deps: ContinuousChatCompactionAdapterDeps;

	constructor(deps: ContinuousChatCompactionAdapterDeps) {
		this.deps = deps;
	}

	validate(): void {
		const summary = this.deps.summary();
		if (!summary.ok) throw new Error(summary.reason);
	}

	/**
	 * The job's own system prompt and tools are not sent: the accepted request's snapshot is. The conversation's first
	 * message carries the causal view; each send appends its task.
	 */
	open(prefix: ContinuousChatCompactionPrefix): ContinuousChatCompactionConversation {
		const head = this.deps.prefixHead();
		const systemPrompt = head.systemPrompt;
		const tools = [...head.tools];
		const summary = this.deps.summary();
		if (!summary.ok) throw new Error(summary.reason);
		let summaryModel = summary.model;
		let history: Message[] = [
			{ role: "user", content: renderContinuousChatViewBlocks(prefix.view), timestamp: Date.now() },
		];
		return {
			send: async (message, signal) => {
				const task: Message = { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() };
				const request = [...history, task];
				const runTurn = async (model: Model<Api>, activeTools: Tool[] = tools) => {
					const completion = await this.deps.complete({
						systemPrompt,
						messages: [],
						requestContext: { systemPrompt, tools: activeTools, messages: request },
						model,
						thinkingLevel: CONTINUOUS_CHAT_COMPACTION_THINKING_LEVEL,
						cacheRetention: "short",
						laneKind: "continuous-chat",
						signal,
					});
					const reply = completion.messages?.at(-1);
					const assistant = reply?.role === "assistant" ? reply : undefined;
					// Every reply is paid: record it before any check below can throw, even one with no assistant message.
					if (hasReportableUsage(completion.usage)) {
						this.deps.recordUsage(completion.usage, {
							reportId: `${CONTINUOUS_CHAT_USAGE_KIND}:${randomUUID()}`,
							provider: assistant?.provider ?? model.provider,
							model: assistant?.model ?? model.id,
						});
					}
					return { completion, assistant };
				};
				let { completion: result, assistant } = await runTurn(summaryModel);
				if (result.stopReason === "error") {
					this.deps.onModelFailure?.(summaryModel, result.errorMessage);
					const nextSummary = this.deps.summary();
					if (
						nextSummary.ok &&
						(nextSummary.model.provider !== summaryModel.provider || nextSummary.model.id !== summaryModel.id)
					) {
						summaryModel = nextSummary.model;
						({ completion: result, assistant } = await runTurn(summaryModel));
					}
				}
				if (
					tools.length > 0 &&
					(result.stopReason === "toolUse" || assistant?.content.some((block) => block.type === "toolCall"))
				) {
					({ completion: result, assistant } = await runTurn(summaryModel, []));
				}
				if (assistant === undefined) throw new Error("Continuous-chat compaction produced no assistant reply.");
				if (result.stopReason !== "stop") {
					const reason = result.errorMessage ?? "no error message";
					throw new Error(`Continuous-chat compaction stopped (${result.stopReason}): ${reason}`);
				}
				if (assistant.content.some((block) => block.type === "toolCall")) {
					throw new Error("Continuous-chat compaction called a tool; compactions are tool-free.");
				}
				history = [...request, assistant];
				return result.text;
			},
		};
	}
}

/** Builds the compaction port that the runtime and the chat host receive. */
export function createContinuousChatCompactionAdapter(
	deps: ContinuousChatCompactionAdapterDeps,
): ContinuousChatCompactionAdapterPort {
	return new ContinuousChatCompactionAdapter(deps);
}
