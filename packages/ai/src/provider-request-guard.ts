import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./providers/cloudflare.ts";
import { getOpenAICodexAccountId } from "./providers/openai-codex-auth.ts";
import {
	type AzureRouteOptions,
	DEFAULT_AZURE_API_VERSION,
	resolveAzureConfig,
	resolveDeploymentName,
	resolveOpenAIResponsesBaseUrl,
} from "./providers/openai-endpoints.ts";
import { createAssistantMessage, terminateAssistantStreamWithError } from "./providers/provider-runtime.ts";
import type { Api, AssistantMessage, Model, ProviderResponseTicket, StreamOptions } from "./types.ts";
import { AssistantMessageEventStream } from "./utils/event-stream.ts";
import { shortHash } from "./utils/hash.ts";

export interface ProviderResponseAccount {
	readonly provider: string;
	readonly model: string;
	readonly accountKey: string;
}

type ReceiptStore = WeakMap<AssistantMessage, { account: ProviderResponseAccount; diagnostic: string } | null>;
const responseAccounts: ReceiptStore = new WeakMap();
const responseRoutes = new WeakMap<ProviderResponseAccount, Pick<Model<Api>, "api" | "baseUrl">>();
const invocation = Symbol("provider response account scope");
const invocationReceipts = new WeakMap<ProviderResponseAccountScope, ReceiptStore>();
type ScopedOptions = StreamOptions & { [invocation]?: ProviderResponseAccountScope };

export function isScopedProviderAccountKey(provider: string, key: string | undefined): key is string {
	return (
		provider.length > 0 &&
		typeof key === "string" &&
		key.startsWith(`${provider}#`) &&
		key.slice(provider.length + 1).trim().length > 0
	);
}

const identityHeader =
	/(?:^|[-_])(?:auth(?:orization)?|api[-_]?key|token|cookie|account[-_]?id|organization|project(?:[-_]?id)?)$/i;

function hasConflictingIdentityHeader(model: Model<Api>, options: StreamOptions, scope: string): boolean {
	const matches = (name: string, value: string): boolean => {
		if (!identityHeader.test(name)) return true;
		if (!options.apiKey || typeof value !== "string") return false;
		if (name.toLowerCase() === "chatgpt-account-id") return value === scope.slice(model.provider.length + 1);
		return value === options.apiKey || value.replace(/^bearer\s+/i, "") === options.apiKey;
	};
	for (const headers of [model.headers, options.headers, options.credentialHeaders]) {
		if (headers && Object.entries(headers).some(([name, value]) => !matches(name, value))) return true;
	}
	if (typeof process === "undefined") return false;
	const openAISdk =
		model.api === "openai-completions" || model.api === "openai-responses" || model.api === "azure-openai-responses";
	if (openAISdk && (process.env.OPENAI_ORG_ID || process.env.OPENAI_PROJECT_ID)) return true;
	const ambient =
		model.api === "anthropic-messages"
			? process.env.ANTHROPIC_CUSTOM_HEADERS
			: openAISdk
				? process.env.OPENAI_CUSTOM_HEADERS
				: undefined;
	return !!ambient?.split("\n").some((line) => {
		const colon = line.indexOf(":");
		return colon >= 0 && !matches(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	});
}

function payloadModel(payload: unknown): unknown {
	return payload && typeof payload === "object" && "model" in payload ? payload.model : undefined;
}

function responseBaseUrl(model: Model<Api>, options: StreamOptions): string | undefined {
	if (typeof model.baseUrl !== "string" || !model.baseUrl.trim()) return undefined;
	try {
		if (model.api === "azure-openai-responses") {
			const azure = options as AzureRouteOptions;
			const route = resolveAzureConfig(model, azure);
			return route.apiVersion === DEFAULT_AZURE_API_VERSION && resolveDeploymentName(model, azure) === model.id
				? route.baseUrl
				: undefined;
		}
		if (model.api === "openai-responses") return resolveOpenAIResponsesBaseUrl(model);
		if (
			(model.api === "openai-completions" && isCloudflareProvider(model.provider)) ||
			(model.api === "anthropic-messages" && model.provider === "cloudflare-ai-gateway")
		)
			return resolveCloudflareBaseUrl(model);
		return model.baseUrl.includes("{") ? undefined : model.baseUrl;
	} catch {
		return undefined;
	}
}

function matchesResponseRoute(account: ProviderResponseAccount, api: Api, baseUrl: string | undefined): boolean {
	const route = responseRoutes.get(account);
	return route !== undefined && route.api === api && route.baseUrl === baseUrl;
}

export function sameProviderResponseRoute(left: ProviderResponseAccount, right: ProviderResponseAccount): boolean {
	const route = responseRoutes.get(right);
	return route !== undefined && matchesResponseRoute(left, route.api, route.baseUrl);
}

export function providerResponseAccountFor(
	model: Model<Api>,
	options: StreamOptions | undefined,
): ProviderResponseAccount | undefined {
	const key = options?.providerAccountKey;
	if (!options || !isScopedProviderAccountKey(model.provider, key)) return undefined;
	if (typeof model.api !== "string" || !model.api.trim()) return undefined;
	if (model.api === "bedrock-converse-stream") return undefined;
	if ("client" in options && options.client != null) return undefined;
	const identity = key.slice(model.provider.length + 1);
	if ((options.apiKey && identity.includes(options.apiKey)) || hasConflictingIdentityHeader(model, options, key))
		return undefined;
	if (
		model.api === "openai-codex-responses" &&
		(!options.apiKey || getOpenAICodexAccountId(options.apiKey) !== identity)
	)
		return undefined;
	const baseUrl = responseBaseUrl(model, options);
	if (!baseUrl) return undefined;
	const account = Object.freeze({ provider: model.provider, model: model.id, accountKey: key });
	responseRoutes.set(account, { api: model.api, baseUrl });
	return account;
}

function matchesDispatchedModel(message: AssistantMessage, account: ProviderResponseAccount): boolean {
	return message.stopReason === "error" && message.provider === account.provider && message.model === account.model;
}

function recordProviderResponseAccount(
	store: ReceiptStore,
	message: AssistantMessage,
	account: ProviderResponseAccount,
): void {
	if (!matchesDispatchedModel(message, account) || !message.errorMessage) return;
	const diagnostic = shortHash(message.errorMessage);
	const previous = store.get(message);
	const ambiguous =
		previous !== undefined &&
		(previous === null ||
			previous.account.accountKey !== account.accountKey ||
			previous.diagnostic !== diagnostic ||
			!sameProviderResponseRoute(previous.account, account));
	store.set(message, ambiguous ? null : { account, diagnostic });
}

function verifiedAccount(store: ReceiptStore, message: AssistantMessage): ProviderResponseAccount | undefined {
	const receipt = store.get(message);
	if (!receipt || !matchesDispatchedModel(message, receipt.account) || !message.errorMessage) return undefined;
	return receipt.diagnostic === shortHash(message.errorMessage) ? receipt.account : undefined;
}

export function getProviderResponseAccount(message: AssistantMessage): ProviderResponseAccount | undefined {
	return verifiedAccount(responseAccounts, message);
}

export class ProviderResponseAccountScope {
	constructor() {
		invocationReceipts.set(this, new WeakMap());
	}

	bind<TOptions extends StreamOptions>(options: TOptions): TOptions {
		return { ...options, [invocation]: this };
	}

	project(source: AssistantMessage, final?: AssistantMessage): AssistantMessage {
		const account = verifiedAccount(invocationReceipts.get(this)!, source);
		const target = final ?? source;
		const projected = responseAccounts.has(target) || (!final && account) ? { ...target } : target;
		if (account && projected.errorMessage === source.errorMessage) {
			recordProviderResponseAccount(responseAccounts, projected, account);
		}
		return projected;
	}
}

function watchIdentityHooks(
	options: StreamOptions,
	model: Model<Api>,
	account: ProviderResponseAccount,
): () => boolean {
	let valid = true;
	const { onPayload, onAuthRejection, onResponse, apiKey } = options;
	const observe = async <T>(operation: () => T | Promise<T>): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			valid = false;
			throw error;
		}
	};
	if (onPayload) {
		options.onPayload = (payload, effectiveModel) =>
			observe(async () => {
				const original = payloadModel(payload);
				const replacement = await onPayload(payload, effectiveModel);
				const selected = replacement === undefined ? payload : replacement;
				if (original !== account.model || payloadModel(selected) !== original) valid = false;
				return replacement;
			});
	}
	if (onAuthRejection) {
		const codexAccount =
			model.api === "openai-codex-responses" ? account.accountKey.slice(model.provider.length + 1) : undefined;
		options.onAuthRejection = (event) =>
			observe(async () => {
				const recovered = await onAuthRejection(event);
				if (
					recovered &&
					recovered !== apiKey &&
					(!codexAccount || codexAccount !== getOpenAICodexAccountId(recovered))
				)
					valid = false;
				return recovered;
			});
	}
	if (onResponse)
		options.onResponse = (response, effectiveModel) => observe(() => onResponse(response, effectiveModel));
	return () => valid;
}

/**
 * Consume a request-local guard at the last harness-owned handoff. The callback never reaches a
 * provider, and there is no await between its decision and dispatch. Middleware may delegate attribution.
 */
export function dispatchGuardedProviderRequest<
	TOptions extends StreamOptions,
	TResult extends AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
>(
	model: Model<Api>,
	options: TOptions | undefined,
	dispatch: (options: TOptions | undefined) => TResult,
	handoff: "provider" | "middleware" = "provider",
): TResult | AssistantMessageEventStream {
	const account = handoff === "provider" ? providerResponseAccountFor(model, options) : undefined;
	const token = (options as ScopedOptions | undefined)?.[invocation];
	const scope = token && invocationReceipts.get(token);
	const consumeScope = handoff === "provider" && token !== undefined;
	if (!options || (!account && !consumeScope && !options.requestGuard && !options.providerResponseObserver))
		return dispatch(options);
	const guard = options.requestGuard;
	const observer = options.providerResponseObserver;
	const trackHooks = account && (options.onPayload || options.onAuthRejection || options.onResponse);
	const providerOptions = guard || observer || consumeScope || trackHooks ? { ...options } : options;
	if (providerOptions !== options) {
		delete providerOptions.requestGuard;
		delete providerOptions.providerResponseObserver;
		if (consumeScope) delete (providerOptions as ScopedOptions)[invocation];
	}
	const hooksMatch = trackHooks && account ? watchIdentityHooks(providerOptions, model, account) : undefined;
	let ticket: ProviderResponseTicket | undefined;
	try {
		options?.signal?.throwIfAborted();
		const returned: unknown = guard?.(model, options?.signal);
		if (returned !== undefined) {
			// A JavaScript caller may bypass the synchronous type contract. Observe its rejection,
			// but never wait for it or allow the provider request to start.
			void Promise.resolve(returned).catch(() => undefined);
			throw new TypeError("Provider request guards must return undefined synchronously.");
		}
		options?.signal?.throwIfAborted();
		ticket = observer?.begin(model, options.signal);
	} catch (error) {
		const stream = new AssistantMessageEventStream();
		const output = createAssistantMessage(model);
		Object.defineProperty(output, "cause", { value: error, enumerable: false });
		terminateAssistantStreamWithError(stream, output, options?.signal, error, {
			formatError: (failure) => (failure instanceof Error ? failure.message : String(failure)),
		});
		return stream;
	}
	try {
		const result = dispatch(providerOptions);
		if (ticket || account) {
			const settlement = ticket;
			const observe = (stream: AssistantMessageEventStream): void => {
				// result() is independent of event iteration. A watchdog may abandon that iterator.
				void stream.result().then(
					(message) => {
						if (
							account &&
							hooksMatch?.() !== false &&
							matchesResponseRoute(account, model.api, responseBaseUrl(model, options))
						)
							recordProviderResponseAccount(scope ?? responseAccounts, message, account);
						settlement?.complete(message);
					},
					(error) => settlement?.failed(error),
				);
			};
			if (result instanceof Promise) void result.then(observe, (error) => settlement?.failed(error));
			else observe(result);
		}
		return result;
	} catch (error) {
		ticket?.failed(error);
		throw error;
	}
}
