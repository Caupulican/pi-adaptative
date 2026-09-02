import { materializeProviderRequest, startMaterializedProviderStream, streamSimple } from "@caupulican/pi-ai/stream";
import type { Context, Message } from "@caupulican/pi-ai/types";
import { applyProviderRequestImageBudget } from "./provider-request-image-budget.ts";
import { projectToolsForProvider } from "./provider-tool-projection.ts";
import {
	sanitizeToolFailureContext,
	TOOL_FAILURE_LEDGER_CLEARED_TEXT,
	TOOL_FAILURE_LEDGER_TRANSIENT_KIND,
} from "./tool-failure-memory.ts";
import { adaptHostTransients, commitTransientRecords, reconcileTransientRecords } from "./transient-records.ts";
import type {
	AgentContext,
	AgentContextPlan,
	AgentLoopConfig,
	AgentMessage,
	AgentRequestId,
	ProviderRequestPrefixState,
	RequestPreflightContext,
	RequestPreflightResult,
	SentPrefixDisturbanceInfo,
	StreamFn,
} from "./types.ts";
import { uuidv7 } from "./uuid.ts";
import {
	VERIFICATION_OBLIGATION_TRANSIENT_KIND,
	VERIFICATION_OBLIGATIONS_CLEARED_TEXT,
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
}): Promise<number | undefined> {
	if (!options.requestPreflight) return options.maxTokens;
	const preflight = await options.requestPreflight(
		{ model: options.model, context: options.context, maxTokens: options.maxTokens },
		options.signal,
	);
	return narrowRequestMaxTokens(options.maxTokens, preflight?.maxTokens, options.model.maxTokens, "requestPreflight");
}

export interface StartedAgentProviderRequest {
	requestId: AgentRequestId;
	stream: Awaited<ReturnType<StreamFn>>;
}

async function buildContextPlan(
	messages: AgentMessage[],
	attempt: number,
	sentPrefixCount: number,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<AgentContextPlan> {
	if (config.planContext) return await config.planContext({ messages, attempt, sentPrefixCount }, signal);
	return {
		messages: config.transformContext ? await config.transformContext(messages, signal) : messages,
	};
}

/**
 * Content fallback for the one case reference comparison alone cannot resolve: a host that
 * reconstructs an equivalent message at the same position (new object, identical content) is not a
 * real disturbance - nothing the provider would see actually changed. Only called for a message
 * whose reference already differs, never for the untouched common case. `AgentMessage` is plain
 * JSON-serializable data throughout this codebase (it round-trips through the session log), so
 * `JSON.stringify` equality is a direct, adequate proxy for "would this serialize to the same
 * bytes"; an incomparable pair (this should not happen for real message shapes) is treated as
 * disturbed rather than silently ignored, since a false positive here is inert noise on an optional
 * callback while a false negative would hide a real defect.
 */
function messageContentEqual(a: AgentMessage, b: AgentMessage): boolean {
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
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
	let disturbedCount = 0;
	let firstDisturbedIndex = -1;
	const limit = Math.min(sentPrefixCount, input.length);
	for (let index = 0; index < limit; index++) {
		const before = input[index];
		const after = output[index];
		if (before === after) continue;
		if (after !== undefined && messageContentEqual(before, after)) continue;
		disturbedCount++;
		if (firstDisturbedIndex === -1) firstDisturbedIndex = index;
	}
	return disturbedCount > 0 ? { disturbedCount, firstDisturbedIndex, sentPrefixCount } : undefined;
}

/**
 * The portion of a materialized request NOT eligible for the same compaction/GC treatment as the
 * rest - the (usually empty) new-or-changed transient records this specific turn is committing, plus
 * the protocol guard message, plus any host transient `adaptHostTransients` could not durably
 * identify (see `transient-records.ts`). Slicing at `compactableMessageCount` (== `plan.messages`
 * converted, i.e. everything durable) is correct rather than approximate: append-on-change means a
 * PREVIOUSLY-recorded transient is now an ordinary durable message like any other (it flows through
 * `sanitizeToolFailureContext`/`buildContextPlan` untouched, since `analyzeToolFailureContext` never
 * inspects a `role: "custom"` message), so it is already inside `compactableMessageCount` - only a
 * record newly minted THIS call, appended after `compactableMessages` was computed, is not. This
 * boundary was reasoned through explicitly for the append-on-change design, not left as the
 * pre-existing number and adjusted until tests passed - see the caller for the full argument.
 */
function nonCompactableProviderContext(
	context: Context,
	compactableMessageCount: number,
	usesTextToolProtocol: boolean,
): Context {
	const protocolGuardCount = usesTextToolProtocol && context.messages.length > 0 ? 1 : 0;
	return {
		...context,
		messages: [
			...context.messages.slice(0, protocolGuardCount),
			...context.messages.slice(protocolGuardCount + compactableMessageCount),
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
function adoptReplannedMessages(target: AgentContext, accepted: AgentContext): void {
	if (target.messages === accepted.messages) return;
	const messages = accepted.messages.slice();
	target.messages.length = 0;
	for (const message of messages) target.messages.push(message);
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
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn?: StreamFn,
): Promise<StartedAgentProviderRequest> {
	let sourceContext = initialContext;
	let admissionAttempt = 0;
	let stalePlanCount = 0;
	while (true) {
		signal?.throwIfAborted();
		// TWO DELIBERATELY DIFFERENT marks (see ProviderRequestPrefixState in types.ts - do not merge
		// these back into one value; that recreates either the cache defect or the unbounded-context
		// defect the split exists to keep apart):
		// - sanitizerSentPrefixCount (SESSION-scoped) confines the sanitizer's dedup-erasure below.
		// - sentPrefixCount (RUN-scoped) feeds `planContext`'s AgentContextPlanRequest.sentPrefixCount
		//   and the disturbance detector below - both validate a host's packing against exactly this
		//   value, so it must keep its own, separate, per-prompt-resetting lifetime.
		// Both computed once per loop iteration and clamped: compaction can shorten the transcript,
		// and each mark indexes into `sourceContext.messages`, whose entries are otherwise only ever
		// appended - recomputed fresh on every iteration, so a replan that hands back a shorter
		// `sourceContext` (compaction) is reflected immediately and a stale/larger-than-history value
		// can never reach the sanitizer or `planContext`.
		const sanitizerSentPrefixCount = Math.min(readSanitizerSentPrefixCount(config), sourceContext.messages.length);
		const sentPrefixCount = Math.min(readSentPrefixCount(config), sourceContext.messages.length);
		const sanitized = sanitizeToolFailureContext(
			sourceContext.messages,
			sourceContext.systemPrompt,
			sanitizerSentPrefixCount,
			config.providerRequestPrefixState?.sanitizerMemory,
			config.toolFailureProtocolProse ?? "full",
		);
		const plan = await buildContextPlan(sanitized.messages, admissionAttempt, sentPrefixCount, config, signal);
		// Checked on every admission attempt, including one later discarded as stale, so a host sees
		// the full extent of what its own planContext/transformContext did - not just what survived
		// into an accepted request. Gated on the hook being registered: skipped entirely otherwise.
		if (config.onSentPrefixDisturbance) {
			const disturbance = detectSentPrefixDisturbance(sanitized.messages, plan.messages, sentPrefixCount);
			if (disturbance) config.onSentPrefixDisturbance(disturbance);
		}
		let keepPlan = false;
		try {
			signal?.throwIfAborted();
			if (plan.isCurrent?.() === false) {
				stalePlanCount = nextStalePlanCount(stalePlanCount);
				continue;
			}

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
			const hostTransients = adaptHostTransients(plan.transientMessages ?? []);
			// Precedence order matters here (see TransientRecordSlot.trailing's doc comment): host
			// transients are informational and carry no `trailing` flag, so their position among
			// themselves is irrelevant; obligation then ledger are the MUST-protocol pair, in the same
			// order the pre-append-on-change design pushed them, so the ledger - not the obligation -
			// reclaims the literal last position whenever both are active.
			const pendingTransientRecords = reconcileTransientRecords(sourceContext.messages, [
				...hostTransients.slots,
				{
					kind: VERIFICATION_OBLIGATION_TRANSIENT_KIND,
					content: sourceContext.trailingInstruction,
					clearedText: VERIFICATION_OBLIGATIONS_CLEARED_TEXT,
					trailing: true,
				},
				{
					kind: TOOL_FAILURE_LEDGER_TRANSIENT_KIND,
					content: sanitized.ledger,
					clearedText: TOOL_FAILURE_LEDGER_CLEARED_TEXT,
					trailing: true,
				},
			]);
			const compactableMessages = await config.convertToLlm(plan.messages);
			// `pendingTransientRecords` (this turn's new-or-changed-or-displaced durable records - empty
			// for informational slots most turns, but see the trailing-pair note above for why it is NOT
			// typically empty overall) plus `hostTransients.passThrough` (any host transient this module
			// has no safe durable identity for, appended fresh every request exactly as before this
			// mechanism existed - see `adaptHostTransients`) are the ONLY things ever appended fresh here, so
			// `nonCompactableProviderContext` below still slices correctly at `compactableMessages.length`
			// without adjustment: everything durable, old transients included, is already inside
			// `compactableMessages`, and everything after it is genuinely this request's own new,
			// not-yet-committed tail. See that function's doc comment for the full boundary argument.
			const newTransientMessages = [...pendingTransientRecords, ...hostTransients.passThrough];
			const newTransientWireMessages =
				newTransientMessages.length > 0 ? await config.convertToLlm(newTransientMessages) : [];
			const llmMessages: Message[] = [...compactableMessages, ...newTransientWireMessages];
			signal?.throwIfAborted();

			const sourceProviderContext: Context = {
				systemPrompt: composeRequestSystemPrompt(sanitized.systemPrompt, plan.transientSystemPrompt),
				messages: llmMessages,
				tools: projectToolsForProvider(sourceContext.tools),
			};
			const protocolMaterialized = materializeProviderRequest(sourceProviderContext, config);
			const budgeted = applyProviderRequestImageBudget(protocolMaterialized.context, config.model);
			const materialized =
				budgeted.context === protocolMaterialized.context
					? protocolMaterialized
					: { ...protocolMaterialized, context: budgeted.context };
			const nonCompactableContext = nonCompactableProviderContext(
				materialized.context,
				compactableMessages.length,
				materialized.usesTextToolProtocol,
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
				sourceContext = admission.context;
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
			requestMaxTokens = await resolveRequestPreflightMaxTokens({
				requestPreflight: config.requestPreflight,
				model: config.model,
				context: materialized.context,
				maxTokens: requestMaxTokens,
				signal,
			});
			signal?.throwIfAborted();

			const resolvedApiKey =
				(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
			signal?.throwIfAborted();
			const requestReasoning = config.resolveRequestReasoning
				? config.resolveRequestReasoning(config.reasoning, {
						model: config.model,
						context: materialized.context,
						maxTokens: requestMaxTokens,
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
			sourceContext = await commitTransientRecords(
				sourceContext,
				pendingTransientRecords,
				config.onTransientRecordsCommitted,
			);
			// Everything in this accepted request is now bytes the provider has seen; later turns may
			// no longer rewrite them. Monotone, so a shorter replanned history never lowers either
			// mark. Both marks are updated identically here - they diverge only in WHEN they get reset
			// (see ProviderRequestPrefixState in types.ts), not in how they grow within a run/session.
			writeSentPrefixCount(config, Math.max(readSentPrefixCount(config), sourceContext.messages.length));
			writeSanitizerSentPrefixCount(
				config,
				Math.max(readSanitizerSentPrefixCount(config), sourceContext.messages.length),
			);
			plan.commit?.();
			adoptReplannedMessages(initialContext, sourceContext);
			keepPlan = true;
			await config.onProviderRequestSnapshot?.(
				{
					model: config.model,
					context: materialized.context,
					nonCompactableContext,
					sourceContext,
					maxTokens: requestMaxTokens,
					requestId,
					reasoning: requestReasoning,
					attempt: admissionAttempt,
				},
				signal,
			);
			signal?.throwIfAborted();
			const stream = (await startMaterializedProviderStream(
				config.model,
				materialized,
				{
					...config,
					apiKey: resolvedApiKey,
					maxTokens: requestMaxTokens,
					reasoning: requestReasoning,
					signal,
				},
				(providerContext, providerOptions) => streamFunction(config.model, providerContext, providerOptions),
			)) as Awaited<ReturnType<StreamFn>>;
			return { requestId, stream };
		} finally {
			if (!keepPlan) plan.discard?.();
		}
	}
}
