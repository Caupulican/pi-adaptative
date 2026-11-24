import type { ToolSchemaDisclosureDecision } from "@caupulican/pi-ai";
import {
	countHistoryWork,
	historyWorkFallback,
	inheritHistoryWork,
	registerProviderMessagePrefix,
} from "@caupulican/pi-ai/history-work";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import {
	dispatchGuardedProviderRequest,
	materializeProviderRequest,
	ProviderResponseAccountScope,
	startMaterializedProviderStream,
	streamSimple,
} from "@caupulican/pi-ai/stream";
import type { Api, AssistantMessage, Context, Message, Model } from "@caupulican/pi-ai/types";
import { closingProviderHistory, preservesClosingInstruction, toolFreeRequestContext } from "./closing-request.ts";
import { harnessLog } from "./harness-log.ts";
import type {
	AgentContext,
	AgentContextPlan,
	AgentContextPlanPayload,
	AgentContextPlanRequest,
	AgentContextWire,
	AgentLoopConfig,
	ProviderRequestPrefixState,
	RequestPreflightContext,
	RequestPreflightResult,
	ResolvedProviderRequestAuth,
	SentPrefixDisturbanceInfo,
	StreamFn,
} from "./loop-config.ts";
import {
	capturePublishedMessagePrefix,
	isImmutableHistoryMessage,
	messageContentRevision,
	messageHistoryVersion,
	messageSourceOf,
	serializedMessagesEqual,
	unchangedMessagePrefix,
} from "./message-revision.ts";
import { captureProviderMessageConverter } from "./messages.ts";
import { recordPrefixFoldWork } from "./prefix-fold.ts";
import {
	convertProviderWireRows,
	projectProviderMessages,
	providerMessageProjectionScope,
} from "./provider-message-projection.ts";
import { estimateProviderRequestTokens, markImageFreeProviderMessages } from "./provider-request-estimator.ts";
import { applyProviderRequestImageBudget, imageFreeProviderPrefix } from "./provider-request-image-budget.ts";
import { projectToolsForProvider } from "./provider-tool-projection.ts";
import { sealSystemPrompt } from "./sealed-directives.ts";
import {
	renderToolFailureLedger,
	renderToolFailureLedgerPointerHeader,
	toolFailureLedgerDigest,
	toolFailureLedgerDigestOfRecord,
} from "./tool-failure-ledger-record.ts";
import {
	createToolFailureContextMemory,
	sanitizeToolFailureContext,
	TOOL_FAILURE_LEDGER_CLEARED_TEXT,
	TOOL_FAILURE_LEDGER_TRANSIENT_KIND,
	type ToolFailureMemoryRecord,
} from "./tool-failure-memory.ts";
import { logTransientRecordDecisions } from "./transient-record-decision.ts";
import {
	adaptHostTransients,
	commitTransientRecords,
	reconcileTransientRecords,
	type TransientRecordSlot,
} from "./transient-records.ts";
import type { AgentMessage, AgentRequestId } from "./types.ts";
import { uuidv7 } from "./uuid.ts";
import {
	VERIFICATION_OBLIGATION_TRANSIENT_KIND,
	VERIFICATION_OBLIGATIONS_CLEARED_TEXT,
	VERIFICATION_OBLIGATIONS_HEADER,
} from "./verification-obligations.ts";

/**
 * Fallback store for BOTH "already sent" high-water marks (see {@link ProviderRequestPrefixState}
 * for why there are two, and never one). Keyed by the loop config that owns the run.
 * Duplicate-erasure in `sanitizeToolFailureContext` shifts every byte after the call it removes,
 * and providers prefill against the longest byte-identical prefix, so erasing something already
 * sent invalidates the whole conversation from that point. Recording the high-water mark confines
 * dedup to history the provider has never seen.
 *
 * This WeakMap is ONLY the fallback for callers with no run identity (direct one-shot calls such as
 * `startAgentProviderRequest`, and tests that call this module directly): a single request has no
 * prior sent prefix, so an absent entry correctly defaults to 0 for both marks - a one-shot caller
 * has no notion of "session" distinct from "run" to begin with. The agent loop instead threads a
 * shared {@link ProviderRequestPrefixState} through `config.providerRequestPrefixState`, which
 * survives every `{...config}` clone the loop performs across a run - see that field's doc comment
 * for why the WeakMap alone cannot, and for the session/run distinction `Agent` manages on top of it.
 */
const sentPrefixFallback = new WeakMap<
	AgentLoopConfig,
	{ sentPrefixCount: number; sanitizerSentPrefixCount: number }
>();

function readFallbackEntry(config: AgentLoopConfig): { sentPrefixCount: number; sanitizerSentPrefixCount: number } {
	return sentPrefixFallback.get(config) ?? { sentPrefixCount: 0, sanitizerSentPrefixCount: 0 };
}

/** Read the RUN-scoped pack-freeze mark (see {@link ProviderRequestPrefixState}). */
function readSentPrefixCount(config: AgentLoopConfig): number {
	return config.providerRequestPrefixState?.sentPrefixCount ?? readFallbackEntry(config).sentPrefixCount;
}

/** Write the RUN-scoped pack-freeze mark (see {@link ProviderRequestPrefixState}). */
function writeSentPrefixCount(config: AgentLoopConfig, count: number): void {
	const state: ProviderRequestPrefixState | undefined = config.providerRequestPrefixState;
	if (state) {
		state.sentPrefixCount = count;
		return;
	}
	sentPrefixFallback.set(config, { ...readFallbackEntry(config), sentPrefixCount: count });
}

/** Read the SESSION-scoped sanitizer mark (see {@link ProviderRequestPrefixState}). */
function readSanitizerSentPrefixCount(config: AgentLoopConfig): number {
	return (
		config.providerRequestPrefixState?.sanitizerSentPrefixCount ?? readFallbackEntry(config).sanitizerSentPrefixCount
	);
}

/** Write the SESSION-scoped sanitizer mark (see {@link ProviderRequestPrefixState}). */
function writeSanitizerSentPrefixCount(config: AgentLoopConfig, count: number): void {
	const state: ProviderRequestPrefixState | undefined = config.providerRequestPrefixState;
	if (state) {
		state.sanitizerSentPrefixCount = count;
		return;
	}
	sentPrefixFallback.set(config, { ...readFallbackEntry(config), sanitizerSentPrefixCount: count });
}

function sharedMessagePrefix(
	previous: readonly AgentMessage[],
	next: readonly AgentMessage[],
	limit: number,
	proven = 0,
): number {
	if (previous === next) return limit;
	let shared = proven;
	while (shared < limit && previous[shared] === next[shared]) shared++;
	return shared;
}

/**
 * A replan (compaction) hands back a DIFFERENT history: only the leading messages it shares with the
 * previous history by reference are still bytes the provider has seen. Lower both marks to that shared
 * prefix, and drop the sanitizer's erasure memory when the cut reaches below its mark (its fold state
 * indexes messages that no longer exist). Without this the monotone mark write after acceptance kept the
 * pre-compaction count, so the whole compacted history read as already sent: context GC could not pack
 * it and the sanitizer could not dedup it until the history regrew past the old length.
 */
function lowerPrefixMarksToSharedPrefix(
	config: AgentLoopConfig,
	previous: readonly AgentMessage[],
	next: readonly AgentMessage[],
): void {
	const limit = Math.min(
		previous.length,
		next.length,
		Math.max(readSentPrefixCount(config), readSanitizerSentPrefixCount(config)),
	);
	const shared = sharedMessagePrefix(previous, next, limit);
	if (readSentPrefixCount(config) > shared) writeSentPrefixCount(config, shared);
	if (readSanitizerSentPrefixCount(config) > shared) {
		writeSanitizerSentPrefixCount(config, shared);
		const state = config.providerRequestPrefixState;
		if (state) state.sanitizerMemory = createToolFailureContextMemory();
	}
}

/** The disclosure last logged per session prefix state: a decision is logged when it changes, not per request. */
const loggedToolSchemaDisclosures = new WeakMap<object, string>();

/** One `tools` line for an accepted request whose tool-schema disclosure differs from the last one logged. */
function logToolSchemaDisclosure(
	key: object,
	model: Model<Api>,
	decision: ToolSchemaDisclosureDecision | undefined,
): void {
	if (!decision || !harnessLog.enabled("info", "tools")) return;
	const { plan, activatedToolNames } = decision;
	const fields = {
		mode: plan.mode,
		residentCount: plan.eagerToolNames.size,
		deferredCount: plan.deferredToolNames.size,
		activatedCount: activatedToolNames.length,
		residentSchemaTokens: plan.metrics.estimatedEagerSchemaTokens,
		deferredSchemaTokens: plan.metrics.estimatedDeferredSchemaTokens,
		deferred: [...plan.deferredToolNames],
		activated: [...activatedToolNames],
	};
	const fingerprint = JSON.stringify(fields);
	if (loggedToolSchemaDisclosures.get(key) === fingerprint) return;
	loggedToolSchemaDisclosures.set(key, fingerprint);
	harnessLog.info("tools", "tool schema disclosure", { model: `${model.provider}/${model.id}`, ...fields });
}

const MAX_STALE_PROVIDER_REQUEST_PLANS = 3;
const MAX_PROVIDER_REQUEST_REPLANS = 2;

/** Compose request-local host instructions without representing them as conversation history. */
export function composeRequestSystemPrompt(
	base: string | undefined,
	transient: string | undefined,
): string | undefined {
	if (!transient) return base;
	return base ? `${base}\n\n${transient}` : transient;
}

function nextStalePlanCount(count: number): number {
	const next = count + 1;
	if (next >= MAX_STALE_PROVIDER_REQUEST_PLANS) {
		throw new Error(`Provider request plan stayed stale after ${MAX_STALE_PROVIDER_REQUEST_PLANS} attempts`);
	}
	return next;
}

/**
 * Narrow an owner-selected output cap by one more requested ceiling and the model's own limit,
 * validating each supplied value is a positive safe integer. Exported so hosts computing their own
 * ceiling (e.g. a goal's remaining token budget) can route it through the SAME validated narrowing
 * this module applies just before transport, instead of hand-rolling an unvalidated min-merge that
 * only fails loudly here, several layers away from where the degenerate value was actually computed.
 */
export function narrowRequestMaxTokens(
	ownerMaxTokens: number | undefined,
	requestedMaxTokens: number | undefined,
	modelMaxTokens: number,
	label: string,
): number | undefined {
	if (ownerMaxTokens !== undefined && (!Number.isSafeInteger(ownerMaxTokens) || ownerMaxTokens <= 0)) {
		throw new TypeError("request maxTokens must be a positive safe integer");
	}
	if (requestedMaxTokens === undefined) return ownerMaxTokens;
	if (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens <= 0) {
		throw new TypeError(`${label}.maxTokens must be a positive safe integer`);
	}
	const ceilings = [requestedMaxTokens];
	if (ownerMaxTokens !== undefined) ceilings.push(ownerMaxTokens);
	if (Number.isSafeInteger(modelMaxTokens) && modelMaxTokens > 0) ceilings.push(modelMaxTokens);
	return Math.min(...ceilings);
}

/** Apply one request-local preflight without mutating persistent loop configuration. */
export async function resolveRequestPreflightMaxTokens(options: {
	requestPreflight?: (
		context: RequestPreflightContext,
		signal?: AbortSignal,
	) => RequestPreflightResult | undefined | Promise<RequestPreflightResult | undefined>;
	model: RequestPreflightContext["model"];
	context: RequestPreflightContext["context"];
	maxTokens?: number;
	signal?: AbortSignal;
}): Promise<{ maxTokens: number | undefined; discardUndispatched?: () => void }> {
	if (!options.requestPreflight) return { maxTokens: options.maxTokens };
	const preflight = await options.requestPreflight(
		{ model: options.model, context: options.context, maxTokens: options.maxTokens },
		options.signal,
	);
	try {
		return {
			maxTokens: narrowRequestMaxTokens(
				options.maxTokens,
				preflight?.maxTokens,
				options.model.maxTokens,
				"requestPreflight",
			),
			...(preflight?.discardUndispatched ? { discardUndispatched: preflight.discardUndispatched } : {}),
		};
	} catch (error) {
		preflight?.discardUndispatched?.();
		throw error;
	}
}

/**
 * Resolve one request's complete auth projection once. Exported for the one isolated request-context
 * path that deliberately bypasses normal context planning but must share these ownership rules.
 */
export async function resolveProviderRequestAuthOptions(
	config: Pick<
		AgentLoopConfig,
		| "model"
		| "apiKey"
		| "headers"
		| "credentialHeaders"
		| "providerRequestContext"
		| "providerAccountKey"
		| "getApiKey"
		| "resolveProviderRequestAuth"
		| "requestGuard"
	>,
): Promise<ResolvedProviderRequestAuth & { model: AgentLoopConfig["model"] }> {
	const resolved = config.resolveProviderRequestAuth
		? await config.resolveProviderRequestAuth(config.model)
		: undefined;
	const resolverOwnsAuth = resolved !== undefined;
	const apiKey = resolverOwnsAuth
		? resolved.apiKey
		: (config.getApiKey ? await config.getApiKey(config.model.provider, config.model) : undefined) || config.apiKey;
	const headers = resolved?.headers || config.headers ? { ...resolved?.headers, ...config.headers } : undefined;
	const credentialHeaders = resolverOwnsAuth ? resolved.credentialHeaders : config.credentialHeaders;
	const providerRequestContext = resolverOwnsAuth ? resolved.providerRequestContext : config.providerRequestContext;
	const providerAccountKey = resolverOwnsAuth ? resolved.providerAccountKey : config.providerAccountKey;
	const model = resolved?.model ?? config.model;
	if (model.provider !== config.model.provider || model.id !== config.model.id) {
		throw new Error("Request authentication cannot change the routed model identity");
	}
	const requestGuard =
		resolved?.requestGuard && config.requestGuard
			? (requestModel: typeof model, signal: AbortSignal | undefined): undefined => {
					resolved.requestGuard?.(requestModel, signal);
					config.requestGuard?.(requestModel, signal);
					return undefined;
				}
			: (resolved?.requestGuard ?? config.requestGuard);
	return {
		model,
		apiKey,
		headers,
		credentialHeaders,
		providerRequestContext,
		providerAccountKey,
		requestGuard,
	};
}

export interface StartedAgentProviderRequest {
	responseAccountScope: ProviderResponseAccountScope;
	activeFailureRecords: readonly ToolFailureMemoryRecord[];
	requestId: AgentRequestId;
	stream: Awaited<ReturnType<StreamFn>>;
	usesTextToolProtocol: boolean;
	responseMode?: "answer_only";
	observeAssistant?: (provider: AssistantMessage, final: AssistantMessage) => void;
}

/** A present post-commit predicate must synchronously prove currency; malformed hooks cannot authorize dispatch. */
export function isContextPlanDispatchCurrent(plan: Pick<AgentContextPlan, "isDispatchCurrent">): boolean {
	if (plan.isDispatchCurrent === undefined) return true;
	const current: unknown = plan.isDispatchCurrent();
	if (typeof current !== "boolean") void Promise.resolve(current).catch(() => undefined);
	return current === true;
}

/** Auth and host model preparation share one ordering for planned and direct requests. */
export async function resolveProviderRequestOptions(
	config: Parameters<typeof resolveProviderRequestAuthOptions>[0] &
		Pick<AgentLoopConfig, "prepareProviderRequest" | "reasoning">,
	signal?: AbortSignal,
) {
	const auth = await resolveProviderRequestAuthOptions(config);
	signal?.throwIfAborted();
	auth.requestGuard?.(auth.model, signal);
	const options = await config.prepareProviderRequest?.(auth.model, signal);
	signal?.throwIfAborted();
	auth.requestGuard?.(auth.model, signal);
	const reasoning = options?.reasoning ?? config.reasoning;
	return {
		...auth,
		...options,
		reasoning: reasoning === undefined ? undefined : resolveModelThinkingLevel(auth.model, reasoning, "off"),
	};
}

async function buildContextPlan(
	messages: AgentMessage[],
	requestOpening: AgentMessage | undefined,
	attempt: number,
	sentPrefixCount: number,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	wire: AgentContextWire,
	measureRequest: NonNullable<AgentContextPlanRequest["measureRequest"]>,
): Promise<AgentContextPlan> {
	if (config.planContext)
		return await config.planContext(
			{
				messages,
				sourceMessage: messageSourceOf,
				requestOpening,
				attempt,
				sentPrefixCount,
				model: config.model,
				wire,
				measureRequest,
			},
			signal,
		);
	return {
		messages: config.transformContext ? await config.transformContext(messages, signal) : messages,
	};
}

/**
 * Detect whether a host-owned `planContext`/`transformContext` result rewrote, reordered, or
 * removed a message at or below `sentPrefixCount` - see `AgentLoopConfig.onSentPrefixDisturbance`.
 *
 * Cost: a single reference comparison (`!==`) per already-sent message, O(sentPrefixCount) pointer
 * compares with no allocation - on a long transcript (thousands of messages) this is microseconds,
 * and it is skipped entirely when no host has registered the hook. Content comparison only runs for
 * a message whose reference already differs, so the common case (an untouched prefix, which keeps
 * its original references through a slice/spread-based transform) never pays for it.
 *
 * `input` is the plan's OWN input (`sanitized.messages`, what `sourceContext.messages` looks like
 * after tool-failure dedup); reordering is caught for free by comparing position-for-position - a
 * message moved to a different index shows up as a mismatch at both the position it left and the
 * position it now occupies (or, if it lands past `sentPrefixCount`, as a removal at the position it
 * left, which is exactly what happened: an already-sent message is no longer at an already-sent
 * position).
 */
function detectSentPrefixDisturbance(
	input: readonly AgentMessage[],
	output: readonly AgentMessage[],
	sentPrefixCount: number,
): SentPrefixDisturbanceInfo | undefined {
	if (input === output) return undefined;
	let disturbedCount = 0;
	let firstDisturbedIndex = -1;
	const limit = Math.min(sentPrefixCount, input.length);
	for (let index = 0; index < limit; index++) {
		const before = input[index];
		const after = output[index];
		if (before === after) continue;
		if (after !== undefined && serializedMessagesEqual(before, after)) continue;
		disturbedCount++;
		if (firstDisturbedIndex === -1) firstDisturbedIndex = index;
	}
	return disturbedCount > 0 ? { disturbedCount, firstDisturbedIndex, sentPrefixCount } : undefined;
}

/**
 * The envelope compaction cannot shrink: the protocol guard, the host's carried/frame head, live
 * request-only projections, and the newly appended transient tail. `historyWireCount` includes the
 * inserted live projections, while `headWireCount` ends immediately after them. Previously committed
 * transient records remain ordinary history between those two boundaries. On a halt request the
 * closing instruction is part of the mandatory tail. Both counts come from the same conversion
 * used for dispatch and measurement, rather than from source-message cardinality.
 */
function nonCompactableProviderContext(
	context: Context,
	historyWireCount: number,
	usesTextToolProtocol: boolean,
	headWireCount: number,
): Context {
	const protocolGuardCount = usesTextToolProtocol && context.messages.length > 0 ? 1 : 0;
	return {
		...context,
		messages: [
			...context.messages.slice(0, protocolGuardCount + Math.min(headWireCount, historyWireCount)),
			...context.messages.slice(protocolGuardCount + historyWireCount),
		],
	};
}

function sameToolSurface(left: AgentContext["tools"], right: AgentContext["tools"]): boolean {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((tool, index) => tool === right[index]);
}

function validateReplannedSourceContext(previous: AgentContext, next: AgentContext): void {
	if (previous.systemPrompt !== next.systemPrompt || !sameToolSurface(previous.tools, next.tools)) {
		throw new TypeError("Provider request admission may replan durable messages only");
	}
}

/** Preserve the loop-owned messages array so shallow response-context projections observe compaction. */
function adoptReplannedMessages(
	target: AgentContext,
	accepted: AgentContext,
	privateSnapshot: boolean,
	provenPrefix: number,
): void {
	if (target.messages === accepted.messages) return;
	const messages = privateSnapshot ? accepted.messages : accepted.messages.slice();
	// A transient commit normally appends records. Preserve its unchanged history version;
	// compaction and other replacements still discard everything after their shared prefix.
	const limit = Math.min(target.messages.length, messages.length);
	const shared = sharedMessagePrefix(target.messages, messages, limit, provenPrefix);
	countHistoryWork(target.messages, "oldRowsRead", Math.min(shared + 1, limit) - provenPrefix);
	target.messages.length = shared;
	for (let index = shared; index < messages.length; index++) target.messages.push(messages[index]!);
}

/** Eager disclosure never iterates the activation history. Deferred disclosure reads it in transcript order. */
function* toolActivationHistory(messages: AgentMessage[]): Iterable<Message> {
	for (const message of messages) {
		if (message.role === "assistant" || message.role === "toolResult") yield message;
	}
}

/** Materialize one candidate without admission, lifecycle callbacks or durable effects. */
async function materializeContextPlan(
	sourceContext: AgentContext,
	sanitized: ReturnType<typeof sanitizeToolFailureContext>,
	ledgerView: string | undefined,
	plan: AgentContextPlanPayload,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	history?: AgentContextPlan["providerHistory"],
) {
	// Append-on-change transients (turn-economics A1 extended - see transient-records.ts's
	// module doc for the full mechanism and why it exists: the old approach rebuilt and
	// re-appended every transient at the tail of every request, which the websocket delta cache
	// measurably could never see past turn 1 as a stable prefix - see the Task 10 diagnosis).
	//
	// `sanitized.messages` (and so `plan.messages`, absent a host planContext/transformContext
	// that reshapes it) already contains every PREVIOUSLY-recorded durable transient: once
	// committed below, a transient record is an ordinary durable message like any other -
	// `analyzeToolFailureContext` never touches a `role: "custom"` message (it only inspects
	// "assistant"/"toolResult"), so dedup/erasure can never rewrite or displace one. The only
	// work left here is deciding whether THIS turn's true content differs from the last
	// durably-recorded instance of each kind this package owns, plus every host-contributed kind
	// it can safely identify (see `adaptHostTransients`), OR - for the trailing (MUST-protocol)
	// pair below - whether the trailing group has been displaced from the literal tail by
	// ordinary turn growth since it was last written. Informational slots are typically
	// unchanged, so `pendingTransientRecords` is typically empty FOR THEM; the trailing pair is
	// not typically empty while active (measured: every turn, not just content-changing ones -
	// see `reconcileTransientRecords`'s doc comment in transient-records.ts for the numbers).
	history?.trackDependencies?.(plan.messages);
	if (plan.transientMessages) history?.trackDependencies?.(plan.transientMessages);
	const hostTransients = adaptHostTransients(plan.transientMessages ?? []);
	// Precedence order matters here (see TransientRecordSlot.trailing's doc comment): host
	// transients are informational and carry no `trailing` flag, so their position among
	// themselves is irrelevant; obligation then ledger are the MUST-protocol pair, in the same
	// order the pre-append-on-change design pushed them, so the ledger - not the obligation -
	// reclaims the literal last position whenever both are active.
	// A request whose tail is a host instruction (a halt report request) takes no trailing
	// record: anything appended after the instruction would dilute it.
	const trailingSlots: TransientRecordSlot[] = sourceContext.instructionTail
		? []
		: [
				{
					kind: VERIFICATION_OBLIGATION_TRANSIENT_KIND,
					content: sourceContext.trailingInstruction,
					clearedText: VERIFICATION_OBLIGATIONS_CLEARED_TEXT,
					header: VERIFICATION_OBLIGATIONS_HEADER,
					trailing: true,
				},
				{
					kind: TOOL_FAILURE_LEDGER_TRANSIENT_KIND,
					content: ledgerView,
					...(sanitized.ledger
						? {
								record: sanitized.ledger,
								header: renderToolFailureLedgerPointerHeader(sanitized.ledger),
								digest: toolFailureLedgerDigest(sanitized.ledger),
							}
						: {}),
					digestOfRecord: toolFailureLedgerDigestOfRecord,
					clearedText: TOOL_FAILURE_LEDGER_CLEARED_TEXT,
					trailing: true,
				},
			];
	// A projected plan reconciles against the messages its wire carries, not the whole durable history: a record
	// the projection no longer carries reads as absent and is appended again. The planned messages say whether the
	// last record of a kind is still on the wire in full; one packed or dropped since is sent again.
	const reconcileBase = plan.transientReconciliationBase ?? sourceContext.messages;
	const reconciliation = reconcileTransientRecords(
		reconcileBase,
		[...hostTransients.slots, ...trailingSlots],
		plan.messages,
	);
	const pendingTransientRecords = reconciliation.records;
	history?.trackDependencies?.(pendingTransientRecords);
	const nonCompactableHead = plan.nonCompactableHead ?? 0;
	if (!Number.isInteger(nonCompactableHead) || nonCompactableHead < 0 || nonCompactableHead > plan.messages.length) {
		throw new TypeError(
			`Context plan nonCompactableHead must be an integer from 0 to ${plan.messages.length}, got ${nonCompactableHead}.`,
		);
	}
	const providerHistory = closingProviderHistory(sourceContext, plan.messages, nonCompactableHead);
	const envelope = {
		systemPrompt: sealSystemPrompt(composeRequestSystemPrompt(sanitized.systemPrompt, plan.transientSystemPrompt)),
		tools: projectToolsForProvider(sourceContext.tools),
	};
	const converter = captureProviderMessageConverter(config.convertToLlm);
	const owner = config.providerMessageProjectionOwner;
	const work = sourceContext.messages;
	const scopeFor = (context: Pick<Context, "systemPrompt" | "tools">) =>
		providerMessageProjectionScope({
			model: config.model,
			account: config.providerAccountKey,
			context,
			policy: plan.compressionPolicy,
			blockImages: converter?.policy,
			conversation: config.conversationId ?? config.sessionId,
			protocol: config.textToolCallProtocol,
		});
	const scope = converter && owner ? scopeFor(envelope) : undefined;
	if (!converter) historyWorkFallback(work, "custom provider converter");
	if (converter && !scope) historyWorkFallback(work, "unscoped provider projection");
	const projected =
		converter && scope !== undefined
			? projectProviderMessages({ owner, work, scope, converter, ...providerHistory })
			: undefined;
	const compactableMessages = projected?.wire ?? (await config.convertToLlm(providerHistory.messages));
	if (!projected) countHistoryWork(work, "providerRowsConverted", providerHistory.messages.length);
	history?.trackDependencies?.(compactableMessages);
	// A custom bulk converter cannot opt in to the row-local projection.
	const headWireCount =
		projected?.headWire ??
		(providerHistory.head === 0
			? 0
			: (await config.convertToLlm(providerHistory.messages.slice(0, providerHistory.head))).length);
	const convertTail = (rows: AgentMessage[]) =>
		projected && converter ? convertProviderWireRows(rows, converter) : config.convertToLlm(rows);
	const requestOnlyWireMessages =
		hostTransients.requestOnly.length > 0 ? await convertTail(hostTransients.requestOnly) : [];
	// `pendingTransientRecords` (this turn's new-or-changed-or-displaced durable records - empty
	// for informational slots most turns, but see the trailing-pair note above for why it is NOT
	// typically empty overall) plus `hostTransients.passThrough` (any host transient this module
	// has no safe durable identity for, appended fresh every request exactly as before this
	// mechanism existed - see `adaptHostTransients`) form the new tail. Live request-only projections
	// are separate: they lead compactable history and contribute to both wire boundaries below.
	history?.trackDependencies?.(requestOnlyWireMessages);
	const newTransientMessages = [...pendingTransientRecords, ...hostTransients.passThrough];
	const newTransientWireMessages = newTransientMessages.length > 0 ? await convertTail(newTransientMessages) : [];
	// Live knowledge must remain replaceable and absent from durable history. Placing it after the
	// fixed host head, before growing history, also keeps an unchanged projection at the same wire
	// position on every tool-loop append. A real correction or withholding still replaces it now.
	history?.trackDependencies?.(newTransientWireMessages);
	const compactableWireCount = compactableMessages.length;
	const copyBorrowed =
		projected?.borrowed &&
		(sourceContext.instructionTail || requestOnlyWireMessages.length > 0 || newTransientWireMessages.length > 0);
	const llmMessages: Message[] = !projected || copyBorrowed ? compactableMessages.slice() : compactableMessages;
	countHistoryWork(work, "copiedRows", !projected || copyBorrowed ? compactableWireCount : 0);
	const instruction = sourceContext.instructionTail ? llmMessages.pop() : undefined;
	if (sourceContext.instructionTail && !preservesClosingInstruction(providerHistory.messages.at(-1)!, instruction)) {
		throw new Error("Provider message conversion did not preserve the closing instruction.");
	}
	const historyWireCount = compactableWireCount - Number(instruction !== undefined);
	const headHistoryWireCount = Math.min(headWireCount, historyWireCount);
	if (requestOnlyWireMessages.length > 0) {
		countHistoryWork(work, "copiedRows", Math.max(0, (projected?.reusedWire ?? 0) - headHistoryWireCount));
		llmMessages.splice(headHistoryWireCount, 0, ...requestOnlyWireMessages);
	}
	for (const message of newTransientWireMessages) llmMessages.push(message);
	if (instruction) llmMessages.push(instruction);
	signal?.throwIfAborted();

	const sourceProviderContext: Context = {
		// The one place every agent loop writes its provider request: the sealed directives are restored here if any layer above lost them.
		systemPrompt: envelope.systemPrompt,
		messages: llmMessages,
		tools: envelope.tools,
	};
	// Deferred-tool activation reads the whole transcript, not the planned view: a folded view drops the search or call
	// that activated a tool while still showing the model it used that tool (see `discloseToolSchemas`).
	const compactablePrefix = requestOnlyWireMessages.length === 0 ? historyWireCount : headHistoryWireCount;
	const rawRequestOnly = { start: headHistoryWireCount, count: requestOnlyWireMessages.length };
	const previousDisclosure = projected?.previousDisclosure;
	// A fold can conceal a rewritten search even when every planned row matches. Activation reuse
	// needs both the accepted planned prefix and the full durable prefix that fed the search index.
	const liveDurablePrefix =
		sourceContext.instructionTail && previousDisclosure
			? messageHistoryVersion(sourceContext.messages, previousDisclosure.durableLength)
			: undefined;
	const closingDisclosure =
		previousDisclosure &&
		liveDurablePrefix &&
		unchangedMessagePrefix(previousDisclosure.durableVersion, liveDurablePrefix) >=
			previousDisclosure.durableLength &&
		projected.reusedWire >= previousDisclosure.historyLength
			? {
					surface: previousDisclosure.surface,
					historyLength: previousDisclosure.historyLength,
					previousRequestOnly: previousDisclosure.requestOnly,
					requestOnly: rawRequestOnly,
				}
			: undefined;
	const protocolMaterialized = materializeProviderRequest(
		sourceProviderContext,
		config,
		config.model,
		toolActivationHistory(sourceContext.messages),
		closingDisclosure ?? (projected && !sourceContext.instructionTail ? "capture" : undefined),
	);
	// Raw immutable history and the currently approved knowledge note have separate lifetimes.
	const imageFreeHistoryLength =
		protocolMaterialized.context.messages === llmMessages && projected?.previousFinal
			? Math.min(projected.reusedWire, projected.previousFinal.imageFreeHistoryLength, historyWireCount)
			: closingDisclosure && previousDisclosure?.imageFree
				? Math.min(previousDisclosure.historyLength, historyWireCount)
				: 0;
	const knownImageFreePrefix = imageFreeProviderPrefix(
		imageFreeHistoryLength,
		headHistoryWireCount,
		requestOnlyWireMessages,
		protocolMaterialized.usesTextToolProtocol && protocolMaterialized.context.messages.length > 0,
	);
	const budgeted = applyProviderRequestImageBudget(
		protocolMaterialized.context,
		config.model,
		undefined,
		knownImageFreePrefix,
	);
	const durableVersion = protocolMaterialized.toolSurface && messageHistoryVersion(sourceContext.messages);
	const projectionDisclosure = durableVersion &&
		protocolMaterialized.toolSurface && {
			surface: protocolMaterialized.toolSurface,
			historyLength: historyWireCount,
			durableVersion,
			durableLength: sourceContext.messages.length,
			requestOnly: rawRequestOnly,
			imageFree:
				projected?.stableWire === true && !budgeted.outcome && budgeted.context === protocolMaterialized.context,
		};
	const materialized =
		budgeted.context === protocolMaterialized.context
			? protocolMaterialized
			: { ...protocolMaterialized, context: budgeted.context };
	inheritHistoryWork(work, materialized.context.messages);
	history?.trackDependencies?.(materialized.context.messages);
	const nonCompactableContext = nonCompactableProviderContext(
		materialized.context,
		historyWireCount + requestOnlyWireMessages.length,
		materialized.usesTextToolProtocol,
		headHistoryWireCount + requestOnlyWireMessages.length,
	);
	const requestOnlyMessageRange = {
		start:
			(materialized.usesTextToolProtocol && materialized.context.messages.length > 0 ? 1 : 0) + headHistoryWireCount,
		count: requestOnlyWireMessages.length,
	};
	const finalScope = scopeFor(materialized.context);
	const projectionFinal =
		projected?.stableWire &&
		materialized.context.messages === llmMessages &&
		finalScope !== undefined &&
		!budgeted.outcome &&
		requestOnlyWireMessages.every(isImmutableHistoryMessage) &&
		newTransientWireMessages.every(isImmutableHistoryMessage)
			? {
					messages: llmMessages,
					compactablePrefix,
					imageFreeHistoryLength: historyWireCount,
					scope: finalScope,
				}
			: undefined;
	return {
		materialized,
		nonCompactableContext,
		requestOnlyMessageRange,
		// Any freshly rendered informational records on a halt request are request-local.
		// Persisting them would place them behind the already-persisted closing instruction.
		pendingTransientRecords: sourceContext.instructionTail ? [] : pendingTransientRecords,
		transientDecisions: sourceContext.instructionTail ? [] : reconciliation.decisions,
		nativeHistory: !materialized.usesTextToolProtocol,
		transientTail: newTransientMessages,
		projected,
		projectionDisclosure,
		projectionFinal,
		blockImages: converter?.policy,
	};
}

function certifyProviderProjection(
	projected: ReturnType<typeof projectProviderMessages> | undefined,
	final: { readonly messages: Message[]; readonly compactablePrefix: number; readonly scope: string } | undefined,
): void {
	if (!projected || !final) return;
	Object.freeze(final.messages);
	markImageFreeProviderMessages(final.messages);
	const previous = projected.previousFinal;
	const compatible = previous?.scope === final.scope ? previous : undefined;
	registerProviderMessagePrefix(
		final.messages,
		compatible?.messages,
		compatible ? Math.min(projected.reusedWire, compatible.compactablePrefix, final.compactablePrefix) : 0,
	);
}

/**
 * Canonical two-phase provider boundary: plan replay-safe context, materialize once, admit the exact
 * payload, commit only the accepted plan, then send the admitted object unchanged.
 */
export async function startPlannedAgentProviderRequest(
	initialContext: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn?: StreamFn,
): Promise<Awaited<ReturnType<StreamFn>>> {
	const started = await startPlannedAgentProviderRequestWithId(initialContext, config, signal, streamFn);
	return started.stream;
}

/** Start one accepted request while retaining its opaque lifecycle identity for the agent loop. */
export async function startPlannedAgentProviderRequestWithId(
	initialContext: AgentContext,
	baseConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn?: StreamFn,
): Promise<StartedAgentProviderRequest> {
	// The prompt this request sends, projected now: the loop has taken in every message the request carries. The copy shares
	// the caller's messages array, so `adoptReplannedMessages` below still sees whether the accepted history moved.
	const projectSystemPrompt = baseConfig.projectSystemPrompt;
	let requestContext = projectSystemPrompt
		? { ...initialContext, systemPrompt: projectSystemPrompt(initialContext.systemPrompt) }
		: initialContext;
	if (requestContext.instructionTail === true) {
		const instruction = requestContext.messages.at(-1);
		if (instruction?.role !== "user")
			throw new Error("A closing provider request needs its durable user instruction.");
		requestContext = { ...requestContext, instructionTail: instruction };
	}
	let admissionAttempt = 0;
	let stalePlanCount = 0;
	const prefixState: ProviderRequestPrefixState =
		baseConfig.providerRequestPrefixState ?? readFallbackEntry(baseConfig);
	if (!baseConfig.providerRequestPrefixState) sentPrefixFallback.set(baseConfig, prefixState);
	while (true) {
		signal?.throwIfAborted();
		const responseMode = baseConfig.resolveResponseMode?.(requestContext);
		let sourceContext =
			responseMode === "answer_only"
				? toolFreeRequestContext(requestContext, "the admitted continuation requests an answer with tools withheld")
				: requestContext;
		const requestAuth = await resolveProviderRequestOptions(baseConfig, signal);
		signal?.throwIfAborted();
		const config = { ...baseConfig, ...requestAuth, providerRequestPrefixState: prefixState };
		requestAuth.requestGuard?.(config.model, signal);
		prefixState.reconcileRequestScope?.(config.model, requestAuth.providerAccountKey, sourceContext);
		// TWO DELIBERATELY DIFFERENT marks (see ProviderRequestPrefixState in types.ts - do not merge
		// these back into one value; that recreates either the cache defect or the unbounded-context
		// defect the split exists to keep apart):
		// - sanitizerSentPrefixCount (SESSION-scoped) confines the sanitizer's dedup-erasure below.
		// - sentPrefixCount (SESSION-scoped too since 2026-09-03, carried across prompts by `Agent`) feeds
		//   `planContext`'s AgentContextPlanRequest.sentPrefixCount and the disturbance detector below -
		//   both validate a host's packing against exactly this value. The two marks differ in what
		//   they confine (packing vs dedup-erasure), and both drop when history is replaced.
		// Both computed once per loop iteration and clamped: compaction can shorten the transcript,
		// and each mark indexes into `sourceContext.messages`, whose entries are otherwise only ever
		// appended - recomputed fresh on every iteration, so a replan that hands back a shorter
		// `sourceContext` (compaction) is reflected immediately and a stale/larger-than-history value
		// can never reach the sanitizer or `planContext`.
		const sanitizerSentPrefixCount = Math.min(readSanitizerSentPrefixCount(config), sourceContext.messages.length);
		const sentPrefixCount = Math.min(readSentPrefixCount(config), sourceContext.messages.length);
		let activeFailureRecords: readonly ToolFailureMemoryRecord[] = [];
		const sanitized = sanitizeToolFailureContext(
			sourceContext.messages,
			sourceContext.systemPrompt,
			sanitizerSentPrefixCount,
			config.providerRequestPrefixState?.sanitizerMemory,
			config.toolFailureProtocolProse ?? "full",
			(records) => {
				activeFailureRecords = records;
			},
		);
		inheritHistoryWork(sourceContext.messages, sanitized.messages);
		// The trailing records the request carries behind the plan; a request whose tail is a host instruction takes none.
		const ledgerView = sanitized.ledger ? renderToolFailureLedger(sanitized.ledger) : undefined;
		const trailingTexts = sourceContext.instructionTail
			? []
			: [sourceContext.trailingInstruction, ledgerView].filter((text): text is string => text !== undefined);
		const planningSource = sourceContext;
		const plan = await buildContextPlan(
			sanitized.messages,
			sourceContext.requestOpening,
			admissionAttempt,
			sentPrefixCount,
			config,
			signal,
			{ texts: trailingTexts },
			async (candidate) => {
				signal?.throwIfAborted();
				const { materialized, projected, projectionFinal } = await materializeContextPlan(
					planningSource,
					sanitized,
					ledgerView,
					candidate,
					config,
					signal,
				);
				certifyProviderProjection(projected, projectionFinal);
				return estimateProviderRequestTokens(materialized.context, config.model);
			},
		);
		// Checked on every admission attempt, including one later discarded as stale, so a host sees
		// the full extent of what its own planContext/transformContext did - not just what survived
		// into an accepted request. Gated on the hook being registered: skipped entirely otherwise.
		if (config.onSentPrefixDisturbance && !plan.transientReconciliationBase) {
			const disturbance = detectSentPrefixDisturbance(sanitized.messages, plan.messages, sentPrefixCount);
			if (disturbance) config.onSentPrefixDisturbance(disturbance);
		}
		let keepPlan = false;
		let discardPreflight: (() => void) | undefined;
		try {
			signal?.throwIfAborted();
			if (plan.isCurrent?.() === false) {
				stalePlanCount = nextStalePlanCount(stalePlanCount);
				continue;
			}

			const fresh = await materializeContextPlan(
				sourceContext,
				sanitized,
				ledgerView,
				plan,
				config,
				signal,
				plan.providerHistory,
			);
			const { nonCompactableContext, pendingTransientRecords, transientDecisions } = fresh;
			const historyCandidate = plan.providerHistory && {
				model: config.model,
				context: fresh.materialized.context,
				accountKey: requestAuth.providerAccountKey,
				requestOnly: fresh.requestOnlyMessageRange,
				transientTail: fresh.transientTail,
				compressionPolicy: plan.compressionPolicy,
				blockImages: fresh.blockImages,
				conversation: config.conversationId ?? config.sessionId,
				nativeHistory: fresh.nativeHistory,
				certifiedWire: fresh.projectionFinal !== undefined,
			};
			let continued = historyCandidate && plan.providerHistory?.offer(historyCandidate);
			if (continued && sourceContext.instructionTail) {
				const instruction = fresh.materialized.context.messages.at(-1);
				const tail = continued.messages.at(-1);
				if (!instruction || !preservesClosingInstruction(instruction, tail)) continued = undefined;
			}
			// A prior wire prefix is optional. Its size is checked before admission, which always receives
			// the very context transport will send. The fresh envelope remains the compactable floor.
			const materialized = continued
				? { ...fresh.materialized, context: { ...fresh.materialized.context, messages: continued.messages } }
				: fresh.materialized;

			const projectionFinal = continued ? undefined : fresh.projectionFinal;
			// A certified array is the transport's immutable request value. Callbacks receive this same value.
			certifyProviderProjection(fresh.projected, projectionFinal);
			inheritHistoryWork(initialContext.messages, materialized.context.messages);
			const acceptProjection = sourceContext.instructionTail
				? undefined
				: fresh.projected?.prepareAcceptance(
						projectionFinal,
						fresh.requestOnlyMessageRange.count,
						continued ? undefined : fresh.projectionDisclosure,
					);

			if (plan.isCurrent?.() === false) {
				stalePlanCount = nextStalePlanCount(stalePlanCount);
				continue;
			}
			const admission = await config.admitProviderRequest?.(
				{
					model: config.model,
					context: materialized.context,
					nonCompactableContext,
					sourceContext,
					maxTokens: config.maxTokens,
					attempt: admissionAttempt,
				},
				signal,
			);
			signal?.throwIfAborted();
			if (admission?.action === "replan") {
				validateReplannedSourceContext(sourceContext, admission.context);
				if (admissionAttempt >= MAX_PROVIDER_REQUEST_REPLANS) {
					throw new Error(`Provider request admission exceeded ${MAX_PROVIDER_REQUEST_REPLANS} replans`);
				}
				lowerPrefixMarksToSharedPrefix(config, sourceContext.messages, admission.context.messages);
				requestContext = { ...requestContext, messages: admission.context.messages };
				admissionAttempt++;
				stalePlanCount = 0;
				continue;
			}
			let requestMaxTokens = narrowRequestMaxTokens(
				config.maxTokens,
				admission?.maxTokens,
				config.model.maxTokens,
				"admitProviderRequest",
			);
			const preflight = await resolveRequestPreflightMaxTokens({
				requestPreflight: config.requestPreflight,
				model: config.model,
				context: materialized.context,
				maxTokens: requestMaxTokens,
				signal,
			});
			requestMaxTokens = preflight.maxTokens;
			discardPreflight = preflight.discardUndispatched;
			signal?.throwIfAborted();

			const conversation = config.conversationId ?? config.sessionId;
			const requestReasoning = config.resolveRequestReasoning
				? config.resolveRequestReasoning(config.reasoning, {
						model: config.model,
						context: materialized.context,
						maxTokens: requestMaxTokens,
						sourceMessages: plan.messages,
						...(conversation !== undefined ? { sessionId: conversation } : {}),
					})
				: config.reasoning;
			const streamFunction = streamFn ?? streamSimple;
			if (plan.isCurrent?.() === false || plan.prepareCommit?.() === false) {
				stalePlanCount = nextStalePlanCount(stalePlanCount);
				continue;
			}
			const requestId = uuidv7() as AgentRequestId;
			// Commit this turn's new-or-changed-or-displaced transient records (empty most turns for
			// informational kinds, but not while a trailing MUST-protocol kind is live - see
			// `reconcileTransientRecords`'s doc comment) into DURABLE history before the prefix marks
			// below capture `sourceContext.messages.length` - they were part of the wire payload just
			// built above, so they must count as sent, exactly like any other new content this turn.
			// `commitTransientRecords` (transient-records.ts) is the ONLY place this ever happens - it
			// folds into `sourceContext.messages` AND announces the commit via
			// `onTransientRecordsCommitted` in one call, so the two can never be pulled apart the way a
			// worker-conversation consistency check once caught (see AGENTS.md). It reassigns rather than
			// mutates in place and returns `sourceContext` unchanged BY REFERENCE on a no-op call:
			// `sourceContext` and `initialContext` are frequently the SAME array reference (no host
			// replan occurred this call), and `adoptReplannedMessages` below relies on reference
			// inequality to know a sync is needed - an in-place `.push` would make that check silently
			// see "nothing changed" even though it had, corrupting the very caller-owned array
			// `adoptReplannedMessages` exists to protect. See `nonCompactableProviderContext`'s doc
			// comment for why these records are safe to fold into durable history with no special
			// exemption from ordinary compaction/GC once the pack-freeze horizon moves past them.
			const beforeTransientCommit = sourceContext;
			const beforeTransientCount = sourceContext.messages.length;
			const transientAppendCurrent =
				pendingTransientRecords.length > 0 && sourceContext.messages === initialContext.messages
					? capturePublishedMessagePrefix(() => initialContext.messages, beforeTransientCount)
					: undefined;
			sourceContext = await commitTransientRecords(
				sourceContext,
				pendingTransientRecords,
				config.onTransientRecordsCommitted,
			);
			// Logged here, once per accepted request: a measured, stale or replanned candidate decided nothing.
			logTransientRecordDecisions(transientDecisions);
			logToolSchemaDisclosure(prefixState, config.model, materialized.toolDisclosure);
			// Under a projected plan (`transientReconciliationBase`) these marks still index the durable array: they
			// over-approximate what the wire carried and only freeze durable messages the wire never held.
			// Everything in this accepted request is now bytes the provider has seen; later turns may
			// no longer rewrite them. Monotone within one history; a replan that replaced history has
			// already lowered both marks to the shared prefix (`lowerPrefixMarksToSharedPrefix`). Both marks
			// are updated identically here - they diverge only in WHEN they get reset
			// (see ProviderRequestPrefixState in types.ts), not in how they grow within a run/session.
			writeSentPrefixCount(config, Math.max(readSentPrefixCount(config), sourceContext.messages.length));
			writeSanitizerSentPrefixCount(
				config,
				Math.max(readSanitizerSentPrefixCount(config), sourceContext.messages.length),
			);
			requestAuth.requestGuard?.(config.model, signal);
			plan.commit?.();
			if (historyCandidate) plan.providerHistory?.accept(historyCandidate, materialized.context.messages);
			recordPrefixFoldWork(sourceContext.messages.length, plan.messages.length);
			// A transient commit produced a private array. The loop keeps its own live array after adoption.
			const privateSnapshot = sourceContext !== beforeTransientCommit;
			adoptReplannedMessages(
				initialContext,
				sourceContext,
				privateSnapshot,
				transientAppendCurrent?.() ? beforeTransientCount : 0,
			);
			prefixState.acceptSource?.(initialContext.messages);
			keepPlan = true;
			if (config.onProviderRequestSnapshot && !privateSnapshot && !config.borrowProviderSnapshotSource) {
				countHistoryWork(initialContext.messages, "copiedRows", sourceContext.messages.length);
			}
			const lastSource = sourceContext.messages.at(-1);
			await config.onProviderRequestSnapshot?.(
				{
					model: config.model,
					context: materialized.context,
					nonCompactableContext,
					requestOnlyMessageRange: continued?.requestOnly ?? fresh.requestOnlyMessageRange,
					// The loop appends the provider reply to its live history after this callback.
					// Freeze the accepted source extent so cache-lane compaction can identify that reply as newer.
					sourceContext:
						privateSnapshot || config.borrowProviderSnapshotSource
							? sourceContext
							: { ...sourceContext, messages: sourceContext.messages.slice() },
					sourceBoundary: {
						count: sourceContext.messages.length,
						last: lastSource,
						lastRevision: lastSource ? messageContentRevision(lastSource) : undefined,
					},
					maxTokens: requestMaxTokens,
					requestId,
					providerAccountKey: requestAuth.providerAccountKey,
					reasoning: requestReasoning,
					attempt: admissionAttempt,
				},
				signal,
			);
			signal?.throwIfAborted();
			requestAuth.requestGuard?.(config.model, signal);
			const responseAccountScope = new ProviderResponseAccountScope();
			const stream = (await startMaterializedProviderStream(
				config.model,
				materialized,
				{
					...config,
					...responseAccountScope.bind(requestAuth),
					...(plan.isDispatchCurrent !== undefined || config.resolveResponseMode !== undefined
						? {
								requestGuard: (model: Model<Api>, dispatchSignal: AbortSignal | undefined): undefined => {
									requestAuth.requestGuard?.(model, dispatchSignal);
									if (config.resolveResponseMode?.(sourceContext) !== responseMode)
										throw new Error("Provider response policy changed before dispatch; retry the request.");
									if (!isContextPlanDispatchCurrent(plan))
										throw new Error("Provider request context changed before dispatch; retry the request.");
									return undefined;
								},
							}
						: {}),
					maxTokens: requestMaxTokens,
					reasoning: requestReasoning,
					signal,
				},
				(providerContext, providerOptions) =>
					plan.isDispatchCurrent !== undefined || config.resolveResponseMode !== undefined
						? dispatchGuardedProviderRequest(
								config.model,
								{ ...providerOptions, providerResponseObserver: undefined },
								// Later wrappers may await admission or redaction. They must retain the original guard
								// and observer to recheck freshness and begin accounting at their physical handoff.
								() => streamFunction(config.model, providerContext, providerOptions),
								"middleware",
							)
						: streamFunction(config.model, providerContext, providerOptions),
			)) as Awaited<ReturnType<StreamFn>>;
			if (acceptProjection || plan.acceptProviderHistory) {
				// A stream object can also represent a pre-dispatch guard/redaction refusal. Retain only
				// when this request has a provider result that can be used by the next turn.
				void stream
					.result()
					.then((message) => {
						if (message.stopReason !== "error" && message.stopReason !== "aborted" && !signal?.aborted) {
							acceptProjection?.();
							plan.acceptProviderHistory?.();
						}
					})
					.catch(() => undefined);
			}
			return {
				requestId,
				responseAccountScope,
				activeFailureRecords,
				stream,
				usesTextToolProtocol: materialized.usesTextToolProtocol,
				...(responseMode === "answer_only" ? { responseMode } : {}),
				observeAssistant: plan.providerHistory?.observeAssistant,
			};
		} finally {
			if (!keepPlan) {
				try {
					discardPreflight?.();
				} finally {
					plan.discard?.();
				}
			}
		}
	}
}
