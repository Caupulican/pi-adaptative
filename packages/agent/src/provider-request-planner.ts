import { materializeProviderRequest, startMaterializedProviderStream, streamSimple } from "@caupulican/pi-ai/stream";
import type { Context, Message } from "@caupulican/pi-ai/types";
import { applyProviderRequestImageBudget } from "./provider-request-image-budget.ts";
import { projectToolsForProvider } from "./provider-tool-projection.ts";
import { sanitizeToolFailureContext } from "./tool-failure-memory.ts";
import type {
	AgentContext,
	AgentContextPlan,
	AgentLoopConfig,
	AgentMessage,
	AgentRequestId,
	RequestPreflightContext,
	RequestPreflightResult,
	StreamFn,
} from "./types.ts";
import { uuidv7 } from "./uuid.ts";

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
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<AgentContextPlan> {
	if (config.planContext) return await config.planContext({ messages, attempt }, signal);
	return {
		messages: config.transformContext ? await config.transformContext(messages, signal) : messages,
	};
}

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
		const sanitized = sanitizeToolFailureContext(sourceContext.messages, sourceContext.systemPrompt);
		const plan = await buildContextPlan(sanitized.messages, admissionAttempt, config, signal);
		let keepPlan = false;
		try {
			signal?.throwIfAborted();
			if (plan.isCurrent?.() === false) {
				stalePlanCount = nextStalePlanCount(stalePlanCount);
				continue;
			}

			const transientMessages = plan.transientMessages ?? [];
			const compactableMessages = await config.convertToLlm(plan.messages);
			const providerTransients = transientMessages.length > 0 ? await config.convertToLlm(transientMessages) : [];
			// The failure ledger rides last, never in the system prompt: its content changes as
			// failures appear, accumulate, and clear, and in the system prompt each of those events
			// re-prefills the entire conversation (see sanitizeToolFailureContext). Last position also
			// gives a MUST protocol end-of-context salience.
			const llmMessages: Message[] = [...compactableMessages, ...providerTransients];
			if (sanitized.ledger) {
				llmMessages.push({
					role: "user",
					content: [{ type: "text", text: sanitized.ledger }],
					timestamp: Date.now(),
				});
			}
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
