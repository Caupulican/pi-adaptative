/**
 * Compaction port over the foreground's accepted provider prefix. A summary model that is the accepted request's own
 * model repeats that request's system prompt and tools, so the compaction reads the turns' cached prefix. Any other
 * summary model shares no cache with the turns: it gets the chat's own stable system prompt and no tools, so a call does
 * not pay for the foreground's prompt and tool schemas. The view and task go through the isolated request path. A reply
 * is plain text: a tool call or a stop other than "stop" fails the node.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Api, Message, Model, Tool, Usage } from "@caupulican/pi-ai";
import type { AgentContext } from "../../kernel/loop-config.ts";
import { projectToolsForProvider } from "../../kernel/provider-tool-projection.ts";
import { classifyFailure } from "../../kernel/reliability/classifier.ts";
import { computeRetryDelayMs, DEFAULT_RETRY_POLICY, sleepAbortable } from "../../kernel/reliability/retry.ts";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session-contracts.ts";
import { hasReportableUsage } from "../spawned-usage.ts";
import type { TimerPort } from "../util/timer-port.ts";
import type {
	ContinuousChatCompactionConversation,
	ContinuousChatCompactionPort,
	ContinuousChatCompactionPrefix,
} from "./continuous-chat-compaction.ts";
import { renderContinuousChatViewBlocks } from "./continuous-chat-projection.ts";
import { CONTINUOUS_CHAT_SYSTEM_PROMPT } from "./continuous-chat-prompt.ts";
import type { ContinuousChatSummaryModelResolution } from "./continuous-chat-settings.ts";
import type { ContinuousChatNodeCoordinate } from "./continuous-chat-tree.ts";

/** Report-id prefix of a compaction reply's paid spend in the history-usage owner. */
const CONTINUOUS_CHAT_USAGE_KIND = "memory-continuous-chat-compaction";

/** The model a request ran on, as far as a provider's prompt cache tells models apart. */
export type ContinuousChatPrefixModel = Pick<Model<Api>, "provider" | "id" | "api" | "baseUrl">;

/** The exact system prompt, tools and model of a provider request. A compaction on the same model repeats all three. */
export interface ContinuousChatPrefixSnapshot {
	systemPrompt: string;
	tools: readonly Tool[];
	model: ContinuousChatPrefixModel | undefined;
}

function userText(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function sameCacheModel(a: ContinuousChatPrefixModel, b: ContinuousChatPrefixModel): boolean {
	return a.provider === b.provider && a.id === b.id && a.api === b.api && a.baseUrl === b.baseUrl;
}

/** The prefix an agent context sends, with its tools projected the way the request planner projects them. */
export function continuousChatPrefixOf(
	context: Pick<AgentContext, "systemPrompt" | "tools"> & { model?: ContinuousChatPrefixModel },
): ContinuousChatPrefixSnapshot {
	return {
		systemPrompt: context.systemPrompt,
		tools: projectToolsForProvider(context.tools ?? []),
		model: context.model,
	};
}

/**
 * The accepted provider prefix. The accepted-request hook records it. Until a request is accepted, `resolve` falls back
 * to the agent's current prefix, which is what the next request will send.
 */
export class ContinuousChatPrefixSource {
	private accepted: ContinuousChatPrefixSnapshot | undefined;

	/** Records what an accepted provider request sent: its system prompt and tools, and the model that cached them. */
	record(context: { systemPrompt?: string; tools?: readonly Tool[] }, model: ContinuousChatPrefixModel): void {
		this.accepted = { systemPrompt: context.systemPrompt ?? "", tools: context.tools ?? [], model };
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

/** Background compaction port. `validate()` reports availability without controlling chat activation. */
export interface ContinuousChatCompactionAdapterPort extends ContinuousChatCompactionPort {
	/** Throws one actionable Error when the configured summary model cannot run the chat's compactions. */
	validate(): void;
}

export interface ContinuousChatCompactionAdapterDeps {
	/** Transport backoff shares the chat owner's injected clock. */
	timers?: TimerPort;
	/** The owner's isolated completion, `ReflectionController.runIsolatedCompletion`. */
	complete(options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** The getter the runtime also receives as `prefixHead`, so a compaction and its job agree on the snapshot. */
	prefixHead(): ContinuousChatPrefixSnapshot;
	/** The configured summary model, checked now: setting, registry, egress and thinking level. */
	summary(): ContinuousChatSummaryModelResolution;
	/** Records one reply's paid spend in the history-usage owner. Must not throw. */
	recordUsage(usage: Usage, call: { reportId: string; provider: string; model: string; attempt: number }): void;
	/** Notifies the session when a summary model fails at runtime so `summary()` can self-heal onto a healthy model. */
	onModelFailure?(model: Model<Api>, errorMessage: string | undefined): void;
}

export class ContinuousChatCompactionAdapter implements ContinuousChatCompactionAdapterPort {
	private readonly deps: ContinuousChatCompactionAdapterDeps;

	constructor(deps: ContinuousChatCompactionAdapterDeps) {
		this.deps = deps;
	}

	validate(): void {
		this.summaryModel();
	}

	recoveryKey(): string | undefined {
		const summary = this.deps.summary();
		if (!summary.ok) return undefined;
		const { provider, id, api, baseUrl } = summary.model;
		const prefix = this.deps.prefixHead();
		const shared = prefix.model !== undefined && sameCacheModel(prefix.model, summary.model);
		return createHash("sha256")
			.update(
				JSON.stringify([
					provider,
					id,
					api,
					baseUrl,
					summary.thinkingLevel,
					shared ? prefix.systemPrompt : CONTINUOUS_CHAT_SYSTEM_PROMPT,
					shared ? prefix.tools : [],
				]),
			)
			.digest("hex");
	}

	private summaryModel(): Model<Api> {
		return this.summaryResolution().model;
	}

	private summaryResolution(): Extract<ContinuousChatSummaryModelResolution, { ok: true }> {
		const summary = this.deps.summary();
		if (!summary.ok) throw new Error(summary.reason);
		return summary;
	}

	private guardSummaryRequest(model: Model<Api>, signal: AbortSignal | undefined): undefined {
		signal?.throwIfAborted();
		const current = this.summaryModel();
		if (
			current.provider !== model.provider ||
			current.id !== model.id ||
			current.api !== model.api ||
			current.baseUrl !== model.baseUrl
		) {
			throw new Error("Continuous-chat summary model changed before its request could start.");
		}
		return undefined;
	}

	/**
	 * The job's own system prompt and tools are not sent: the accepted request's snapshot is, when the summary model
	 * shares its cache, and the chat's stable system prompt without tools otherwise. Every send is an independent request:
	 * the node's causal view, its task, and only the latest correction note when the send carries one. No earlier reply
	 * (thinking included) and no earlier note is replayed. Every paid call's report id names the job, the node it
	 * builds, the reply and the attempt, so one ledger row maps to exactly one call.
	 */
	open(
		prefix: ContinuousChatCompactionPrefix,
		target: ContinuousChatNodeCoordinate,
	): ContinuousChatCompactionConversation {
		const jobId = randomUUID();
		const node = `node-${target.level}-${target.ordinal}`;
		let replyIndex = 0;
		const head = this.deps.prefixHead();
		this.validate();
		const view: Message = {
			role: "user",
			content: renderContinuousChatViewBlocks(prefix.view),
			timestamp: Date.now(),
		};
		return {
			send: async ({ task, correction }, signal) => {
				const replyNumber = ++replyIndex;
				let attempt = 0;
				const request: Message[] = [view, userText(task)];
				if (correction !== undefined) request.push(userText(correction));
				const runTurn = async (toolFree = false) => {
					signal?.throwIfAborted();
					const { model, thinkingLevel } = this.summaryResolution();
					const sharesCache = head.model !== undefined && sameCacheModel(head.model, model);
					const systemPrompt = sharesCache ? head.systemPrompt : CONTINUOUS_CHAT_SYSTEM_PROMPT;
					const activeTools = sharesCache && !toolFree ? [...head.tools] : [];
					let guardRejected = false;
					const requestGuard = (requestModel: Model<Api>, requestSignal: AbortSignal | undefined): undefined => {
						try {
							return this.guardSummaryRequest(requestModel, requestSignal);
						} catch (error) {
							guardRejected = true;
							throw error;
						}
					};
					const attemptNumber = ++attempt;
					const completion = await this.deps.complete({
						systemPrompt,
						messages: [],
						requestContext: { systemPrompt, tools: activeTools, messages: request },
						model,
						thinkingLevel,
						cacheRetention: "short",
						laneKind: "continuous-chat",
						requestPreflight: ({ model: requestModel }, requestSignal) =>
							requestGuard(requestModel, requestSignal),
						requestGuard,
						signal,
					});
					const reply = completion.messages?.at(-1);
					const assistant = reply?.role === "assistant" ? reply : undefined;
					// Every reply is paid: record it before any check below can throw, even one with no assistant message.
					if (hasReportableUsage(completion.usage)) {
						this.deps.recordUsage(completion.usage, {
							reportId: `${CONTINUOUS_CHAT_USAGE_KIND}:${jobId}:${node}:reply-${replyNumber}:attempt-${attemptNumber}`,
							provider: assistant?.provider ?? model.provider,
							model: assistant?.model ?? model.id,
							attempt: attemptNumber,
						});
					}
					return { completion, assistant, model, guardRejected, sentTools: activeTools.length > 0 };
				};
				let { completion: result, assistant, model: summaryModel, guardRejected, sentTools } = await runTurn();
				let toolFree = false;
				while (true) {
					signal?.throwIfAborted();
					if (guardRejected) break;
					const failed = result.stopReason === "error";
					if (failed) this.deps.onModelFailure?.(summaryModel, result.errorMessage);
					if (attempt >= DEFAULT_RETRY_POLICY.maxAttempts) break;
					if (failed) {
						const nextSummary = this.deps.summary();
						if (!nextSummary.ok) break;
						if (sameCacheModel(summaryModel, nextSummary.model)) {
							const failure = classifyFailure({
								message: result.errorMessage ?? "",
								provider: summaryModel.provider,
							});
							if (!failure.retryable) break;
							await sleepAbortable(
								computeRetryDelayMs(DEFAULT_RETRY_POLICY, attempt, { retryAfterMs: failure.retryAfterMs }),
								signal,
								this.deps.timers,
							);
						}
					} else if (
						sentTools &&
						(result.stopReason === "toolUse" || assistant?.content.some((block) => block.type === "toolCall"))
					) {
						toolFree = true;
					} else {
						break;
					}
					({
						completion: result,
						assistant,
						model: summaryModel,
						guardRejected,
						sentTools,
					} = await runTurn(toolFree));
				}
				if (assistant === undefined) throw new Error("Continuous-chat compaction produced no assistant reply.");
				if (result.stopReason !== "stop") {
					const reason = result.errorMessage ?? "no error message";
					throw new Error(`Continuous-chat compaction stopped (${result.stopReason}): ${reason}`);
				}
				if (assistant.content.some((block) => block.type === "toolCall")) {
					throw new Error("Continuous-chat compaction called a tool; compactions are tool-free.");
				}
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
