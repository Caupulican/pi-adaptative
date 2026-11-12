/**
 * Compaction port over the foreground's accepted provider prefix. A summary model that is the accepted request's own
 * model repeats that request's system prompt and tools, so the compaction reads the turns' cached prefix. Any other
 * summary model shares no cache with the turns: it gets the chat's own stable system prompt and no tools, so a call does
 * not pay for the foreground's prompt and tool schemas. The view and task go through the isolated request path. A reply
 * is plain text: a tool call or a stop other than "stop" fails the node. A node's requests all run on the model and
 * thinking level resolved when it opened: a different resolution (a fallback model, a changed setting) is refused, never
 * sent, so this lane cannot drift onto a costlier model.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Api, Message, Model, Tool } from "@caupulican/pi-ai";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { AgentContext } from "../../kernel/loop-config.ts";
import { projectToolsForProvider } from "../../kernel/provider-tool-projection.ts";
import { classifyFailure } from "../../kernel/reliability/classifier.ts";
import { computeRetryDelayMs, DEFAULT_RETRY_POLICY, sleepAbortable } from "../../kernel/reliability/retry.ts";
import { safeErrorMessage } from "../../kernel/types.ts";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session-contracts.ts";
import { CompletionAccountingAdmissionError, CompletionResponseUsage } from "../cost/completion-response-usage.ts";
import type { SessionSemanticUsageDelivery } from "../cost/semantic-usage-delivery.ts";
import type { SemanticUsageLedgerIdentity } from "../cost/session-ledger-port.ts";
import {
	isolatedCompletionError,
	logProviderLanePark,
	providerAdmissionRefusalOf,
} from "../provider-admission/refusal.ts";
import type { TimerPort } from "../util/timer-port.ts";
import type {
	ContinuousChatCompactionConversation,
	ContinuousChatCompactionPort,
	ContinuousChatCompactionPrefix,
	ContinuousChatDispatchHold,
} from "./continuous-chat-compaction.ts";
import { ContinuousChatAccountingHold } from "./continuous-chat-compaction.ts";
import { renderContinuousChatViewBlocks } from "./continuous-chat-projection.ts";
import { CONTINUOUS_CHAT_SYSTEM_PROMPT } from "./continuous-chat-prompt.ts";
import type { ContinuousChatSummaryModelResolution } from "./continuous-chat-settings.ts";
import { ContinuousChatAccountingClaimWriteError, type ContinuousChatSpendMeter } from "./continuous-chat-spend.ts";
import type { ContinuousChatNodeCoordinate } from "./continuous-chat-tree.ts";

/** The model a request ran on, as far as a provider's prompt cache tells models apart. */
export type ContinuousChatPrefixModel = Pick<Model<Api>, "provider" | "id" | "api" | "baseUrl">;

/** The exact system prompt, tools and model of a provider request. A compaction on the same model repeats all three. */
export interface ContinuousChatPrefixSnapshot {
	systemPrompt: string;
	tools: readonly Tool[];
	model: ContinuousChatPrefixModel | undefined;
}

/** The model and thinking level a node opened with; every request of the node runs on exactly these. */
interface PinnedSummary {
	model: Model<Api>;
	thinkingLevel: Extract<ContinuousChatSummaryModelResolution, { ok: true }>["thinkingLevel"];
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
	/** The owner's isolated completion, `ReflectionController.runIsolatedCompletion`. */
	complete(options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** The getter the runtime also receives as `prefixHead`, so a compaction and its job agree on the snapshot. */
	prefixHead(): ContinuousChatPrefixSnapshot;
	/** The configured summary model, checked now: setting, registry, egress and thinking level. */
	summary(): ContinuousChatSummaryModelResolution;
	/** Resolved once when a job opens, so physical responses retain their original session owner. */
	usage(): SessionSemanticUsageDelivery;
	/** The summaries' daily spend, shared across projects: new claims wait once its limit is reached. */
	spend: ContinuousChatSpendMeter;
	/** Notifies the session when a summary model fails at runtime so `summary()` can self-heal onto a healthy model. */
	onModelFailure?(model: Model<Api>, errorMessage: string | undefined): void;
}

export class ContinuousChatCompactionAdapter implements ContinuousChatCompactionAdapterPort {
	private readonly deps: ContinuousChatCompactionAdapterDeps;
	private readonly timers: TimerPort;
	/** Settlements whose durable update failed; their persisted in-flight claims keep other owners fenced. */
	private readonly pendingSettlements = new Map<
		string,
		{
			key: string;
			token: string;
			healthy: boolean;
			physicalAttempted: boolean;
			measuredCostUsd?: number;
			observedAtMs?: number;
			warned?: boolean;
		}
	>();
	private settlementAlarm: unknown;
	private settlementAlarmScheduled = false;
	/** Epoch milliseconds before which the provider refused this lane; claims wait for it. */
	private providerHoldUntil = 0;

	constructor(deps: ContinuousChatCompactionAdapterDeps) {
		this.deps = deps;
		this.timers = deps.spend.timers;
	}

	private accountingKey(model: ContinuousChatPrefixModel, sessionId: string): string {
		return createHash("sha256")
			.update(JSON.stringify([sessionId, model.provider, model.id, model.api, model.baseUrl]))
			.digest("hex");
	}

	private settleAccounting(
		key: string,
		token: string,
		healthy: boolean,
		measuredCostUsd?: number,
		observedAtMs?: number,
		physicalAttempted = false,
	): void {
		this.pendingSettlements.set(token, {
			key,
			token,
			healthy,
			physicalAttempted,
			...(measuredCostUsd !== undefined ? { measuredCostUsd } : {}),
			...(observedAtMs !== undefined ? { observedAtMs } : {}),
		});
		this.flushSettlements();
	}

	private flushSettlements(): void {
		for (const [token, pending] of this.pendingSettlements) {
			try {
				this.deps.spend.settle(
					pending.key,
					token,
					pending.healthy,
					pending.measuredCostUsd,
					pending.observedAtMs,
					pending.physicalAttempted,
				);
				this.pendingSettlements.delete(token);
			} catch (error) {
				// The persisted claim remains the fence; the next dispatch poll retries the same settlement.
				if (!pending.warned) {
					pending.warned = true;
					harnessLog.warn("memory", "summary accounting settlement is waiting for storage", {
						reason: safeErrorMessage(error, "Accounting storage is unavailable."),
					});
				}
			}
		}
		if (this.pendingSettlements.size === 0) {
			if (this.settlementAlarmScheduled) this.timers.clearTimeout(this.settlementAlarm);
			this.settlementAlarmScheduled = false;
			this.settlementAlarm = undefined;
		} else if (!this.settlementAlarmScheduled) {
			// Keep retrying a retained settlement after the logical session stops; this alarm never keeps the process alive.
			this.settlementAlarmScheduled = true;
			try {
				this.settlementAlarm = this.timers.setTimeout(() => {
					this.settlementAlarmScheduled = false;
					this.settlementAlarm = undefined;
					this.flushSettlements();
				}, DEFAULT_RETRY_POLICY.baseDelayMs);
			} catch (error) {
				this.settlementAlarmScheduled = false;
				harnessLog.warn("memory", "summary accounting retry could not be scheduled", {
					reason: safeErrorMessage(error, "Accounting timer is unavailable."),
				});
			}
		}
	}

	private accountingHold(key: string): number {
		this.flushSettlements();
		try {
			return this.deps.spend.accountingWait(key);
		} catch {
			return DEFAULT_RETRY_POLICY.maxDelayMs;
		}
	}

	private accountingAdmission(key: string, identity: SemanticUsageLedgerIdentity): string {
		try {
			return this.deps.spend.claim(key, identity);
		} catch (error) {
			if (error instanceof ContinuousChatAccountingClaimWriteError) this.settleAccounting(key, error.token, false);
			throw new ContinuousChatAccountingHold(error);
		}
	}

	validate(): void {
		this.summaryModel();
	}

	dispatchHold(): ContinuousChatDispatchHold | undefined {
		const meter = this.deps.spend;
		let spend: string | undefined;
		try {
			spend = meter.hold();
		} catch {
			return {
				message: "Memory summaries wait for accounting storage.",
				retryInMs: DEFAULT_RETRY_POLICY.maxDelayMs,
			};
		}
		const providerWaitMs = this.providerHoldUntil - this.timers.now();
		const summary = this.deps.summary();
		const accountingWaitMs = summary.ok
			? this.accountingHold(this.accountingKey(summary.model, this.deps.usage().captureOrigin().sessionId))
			: 0;
		if (spend === undefined && providerWaitMs <= 0 && accountingWaitMs <= 0) return undefined;
		// The hold lifts when its earliest reason may have: the next UTC day for the limit, the reset for the provider.
		const wakes: number[] = [];
		if (spend !== undefined) wakes.push(meter.resetsInMs());
		if (providerWaitMs > 0) wakes.push(providerWaitMs);
		if (accountingWaitMs > 0) wakes.push(accountingWaitMs);
		return {
			message:
				spend ??
				(providerWaitMs > 0
					? "Memory summaries wait for the model provider's limit to reset."
					: "Memory summaries wait for response usage accounting to recover."),
			retryInMs: Math.min(...wakes),
		};
	}

	/** A refused request parks new claims until the provider can admit them again; it never counts as a failed attempt. */
	private noteProviderRefusal(source: unknown): void {
		const refusal = providerAdmissionRefusalOf(source);
		if (refusal === undefined) return;
		this.providerHoldUntil = Math.max(this.providerHoldUntil, refusal.retryAt);
		logProviderLanePark("continuous_chat", refusal);
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

	/**
	 * Throws unless the summary configuration resolves, now, to the model and thinking level the node opened with. An
	 * attempted substitution is logged at warn and fails the attempt in plain words; nothing is sent to the other model.
	 */
	private assertPinned(pinned: PinnedSummary, signal: AbortSignal | undefined): void {
		signal?.throwIfAborted();
		const current = this.summaryResolution();
		if (sameCacheModel(pinned.model, current.model) && pinned.thinkingLevel === current.thinkingLevel) return;
		this.refuseSubstitution(pinned, current);
	}

	private refuseSubstitution(pinned: PinnedSummary, attempted: PinnedSummary): never {
		const from = `${pinned.model.provider}/${pinned.model.id}`;
		const to = `${attempted.model.provider}/${attempted.model.id}`;
		harnessLog.warn("memory", "a summary request was refused because its model would change", {
			from,
			to,
			fromThinking: pinned.thinkingLevel,
			toThinking: attempted.thinkingLevel,
		});
		throw new Error(
			`The ICM chat's summaries run only on ${from} at ${pinned.thinkingLevel} thinking, and this one would have run on ${to} at ${attempted.thinkingLevel} thinking, so it was not sent. If ${from} is unavailable, restore it or set contextPolicy.memory.history.summaryModel to another model.`,
		);
	}

	/**
	 * The job's own system prompt and tools are not sent: the accepted request's snapshot is, when the summary model
	 * shares its cache, and the chat's stable system prompt without tools otherwise. Every send is an independent request:
	 * the node's causal view, its task, and only the latest correction note when the send carries one. No earlier reply
	 * (thinking included) and no earlier note is replayed. Every physical request reserves its own durable receipt
	 * before dispatch, bound to the job and node, even if the logical completion is cancelled.
	 */
	open(
		prefix: ContinuousChatCompactionPrefix,
		target: ContinuousChatNodeCoordinate,
	): ContinuousChatCompactionConversation {
		const jobId = randomUUID();
		const usageOwner = this.deps.usage();
		const capturedOrigin = usageOwner.captureOrigin();
		let accountingIdentity: SemanticUsageLedgerIdentity;
		try {
			accountingIdentity = usageOwner.summarySpendIdentity();
			if (accountingIdentity.sessionId !== capturedOrigin.sessionId)
				throw new Error("Summary accounting identity changed before admission.");
		} catch (error) {
			throw new ContinuousChatAccountingHold(error);
		}
		const node = `node-${target.level}-${target.ordinal}`;
		// A background node can summarize several tasks. Its execution-time goal is not its billing owner.
		const origin = { sessionId: capturedOrigin.sessionId, operationId: `${jobId}:${node}` };
		const head = this.deps.prefixHead();
		const { model: pinnedModel, thinkingLevel: pinnedThinking } = this.summaryResolution();
		const pinned: PinnedSummary = { model: pinnedModel, thinkingLevel: pinnedThinking };
		const accountingKey = this.accountingKey(pinnedModel, capturedOrigin.sessionId);
		const view: Message = {
			role: "user",
			content: renderContinuousChatViewBlocks(prefix.view, prefix.viewCache),
			timestamp: Date.now(),
		};
		return {
			send: async ({ task, correction }, signal) => {
				signal?.throwIfAborted();
				if (this.accountingHold(accountingKey) > 0) throw new ContinuousChatAccountingHold();
				let reservedToken: string | undefined = this.accountingAdmission(accountingKey, accountingIdentity);
				let usage: CompletionResponseUsage;
				try {
					usage = new CompletionResponseUsage(
						usageOwner,
						"history_summary",
						DEFAULT_RETRY_POLICY.maxAttempts,
						origin,
					);
				} catch (error) {
					this.settleAccounting(accountingKey, reservedToken, false);
					reservedToken = undefined;
					if (!(error instanceof CompletionAccountingAdmissionError)) throw error;
					throw new ContinuousChatAccountingHold(error);
				}
				try {
					let attempt = 0;
					const request: Message[] = [view, userText(task)];
					if (correction !== undefined) request.push(userText(correction));
					const runTurn = async (toolFree = false) => {
						this.assertPinned(pinned, signal);
						const { model, thinkingLevel } = pinned;
						const sharesCache = head.model !== undefined && sameCacheModel(head.model, model);
						const systemPrompt = sharesCache ? head.systemPrompt : CONTINUOUS_CHAT_SYSTEM_PROMPT;
						const activeTools = sharesCache && !toolFree ? [...head.tools] : [];
						let guardRejected = false;
						let accountingRejection: ContinuousChatAccountingHold | undefined;
						const requestGuard = (
							requestModel: Model<Api>,
							requestSignal: AbortSignal | undefined,
						): undefined => {
							try {
								if (reservedToken === undefined && this.accountingHold(accountingKey) > 0)
									throw new ContinuousChatAccountingHold();
								usage.assertAvailable();
								this.assertPinned(pinned, requestSignal);
								if (!sameCacheModel(pinned.model, requestModel)) {
									this.refuseSubstitution(pinned, {
										model: requestModel,
										thinkingLevel: pinned.thinkingLevel,
									});
								}
								return undefined;
							} catch (error) {
								if (error instanceof ContinuousChatAccountingHold) accountingRejection = error;
								guardRejected = true;
								throw error;
							}
						};
						attempt++;
						const completion = await this.deps
							.complete({
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
								providerResponseObserver: {
									begin: (requestModel, requestSignal) => {
										let token: string | undefined;
										try {
											token = reservedToken ?? this.accountingAdmission(accountingKey, accountingIdentity);
											reservedToken = undefined;
											const admittedToken = token;
											let observedAtMs: number | undefined;
											const ticket = usage.begin(
												requestModel,
												requestSignal,
												(settlement) => {
													this.settleAccounting(
														accountingKey,
														admittedToken,
														settlement.error === undefined,
														settlement.measuredCostUsd,
														observedAtMs,
														true,
													);
												},
												{
													receiptId: admittedToken,
													observedAtMs: () => observedAtMs,
													admitPhysical: () => this.deps.spend.attempt(accountingKey, admittedToken),
												},
											);
											return {
												complete: (message) => {
													// Freeze host observation time before the usage journal performs synchronous I/O.
													observedAtMs = this.timers.now();
													ticket.complete(message);
												},
												failed: (error) => ticket.failed(error),
											};
										} catch (error) {
											if (token) this.settleAccounting(accountingKey, token, false);
											if (error instanceof CompletionAccountingAdmissionError) {
												accountingRejection = new ContinuousChatAccountingHold(error);
												throw accountingRejection;
											}
											if (error instanceof ContinuousChatAccountingHold) accountingRejection = error;
											throw error;
										}
									},
								},
								signal,
							})
							.catch((error: unknown) => {
								this.noteProviderRefusal(error);
								if (accountingRejection) throw accountingRejection;
								throw error;
							});
						if (accountingRejection) throw accountingRejection;
						this.noteProviderRefusal(completion);
						if (providerAdmissionRefusalOf(completion))
							throw isolatedCompletionError(completion, "The provider refused the summary request.");
						usage.assertHealthy();
						const reply = completion.messages?.at(-1);
						const assistant = reply?.role === "assistant" ? reply : undefined;
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
								const delayMs = computeRetryDelayMs(DEFAULT_RETRY_POLICY, attempt, {
									retryAfterMs: failure.retryAfterMs,
								});
								harnessLog.warn("memory", "a summary request failed and will be retried", () => ({
									attempt,
									failure: failure.reason,
									delayMs,
									model: summaryModel.id,
								}));
								await sleepAbortable(delayMs, signal, this.timers);
							} else {
								this.refuseSubstitution(pinned, nextSummary);
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
				} finally {
					if (reservedToken !== undefined) this.settleAccounting(accountingKey, reservedToken, false);
					usage.release();
				}
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
