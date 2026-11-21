import { getEnvAuthHeaders } from "@caupulican/pi-ai/env-api-keys";
import { modelsAreEqual } from "@caupulican/pi-ai/models";
import type { Api, Model, SimpleStreamOptions } from "@caupulican/pi-ai/types";

import type { ProviderRequestConfig } from "./models-config-schema.ts";
import { bindConfigValueInputs, resolveHeadersOrThrow } from "./resolve-config-value.ts";

export interface RequestAuth {
	canCacheAccountIdentity?: boolean;
	accountListingIncludes?: (target: Model<Api>) => boolean;
	/** Effective model resolved with this credential, before request preparation. */
	model?: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	credentialHeaders?: Record<string, string>;
	providerAccountKey?: string;
	requestGuard?: SimpleStreamOptions["requestGuard"];
}

export function bindRegistryRequestHeaders(
	model: Model<Api>,
	provider: ProviderRequestConfig | undefined,
	configured: Record<string, string> | undefined,
	apiKey: string | undefined,
	storedKey: string | undefined,
) {
	const providerHeaders = resolveHeadersOrThrow(provider?.headers, `provider "${model.provider}"`);
	const modelHeaders = resolveHeadersOrThrow(configured, `model "${model.provider}/${model.id}"`);
	const environment = getEnvAuthHeaders(model.provider);
	const headers = { ...environment, ...model.headers, ...providerHeaders, ...modelHeaders };
	if (provider?.authHeader) {
		if (!apiKey) throw new Error(`No API key found for "${model.provider}"`);
		headers.Authorization = `Bearer ${apiKey}`;
	}
	const configInputs = bindConfigValueInputs([
		storedKey,
		provider?.apiKey,
		...Object.values(provider?.headers ?? {}),
		...Object.values(configured ?? {}),
	]);
	return { environment, headers: Object.keys(headers).length ? headers : undefined, configInputs };
}

export function bindAccountRead(
	selected: Model<Api>,
	auth: RequestAuth | undefined,
	signal: AbortSignal,
	fetchImpl: typeof fetch = globalThis.fetch,
) {
	signal.throwIfAborted();
	if (!auth?.apiKey) return undefined;
	const model = auth.model ?? selected;
	if (!modelsAreEqual(model, selected)) throw new Error("Resolved credential belongs to a different model");
	const verify = () => {
		auth.requestGuard?.(model, signal);
		signal.throwIfAborted();
	};
	const guardedFetch: typeof fetch = (url, options) => {
		verify();
		return fetchImpl(url, options);
	};
	return { model, apiKey: auth.apiKey, credentialHeaders: auth.credentialHeaders, fetch: guardedFetch, verify };
}

/**
 * Materialize the complete request-auth projection once at a request boundary. The optional
 * account resolver stays lazy so callers that already resolved an account never consult mutable
 * credential storage again.
 */
export function materializeRequestAuth(
	auth: RequestAuth,
	resolveProviderAccountKey?: () => string | undefined,
): RequestAuth {
	const providerAccountKey = auth.providerAccountKey ?? resolveProviderAccountKey?.();
	return {
		...(auth.model !== undefined ? { model: auth.model } : {}),
		...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
		...(auth.headers !== undefined ? { headers: auth.headers } : {}),
		...(auth.credentialHeaders !== undefined ? { credentialHeaders: auth.credentialHeaders } : {}),
		...(providerAccountKey !== undefined ? { providerAccountKey } : {}),
		...(auth.requestGuard !== undefined ? { requestGuard: auth.requestGuard } : {}),
	};
}

const AUTHENTICATION_HEADER_NAMES = new Set(["authorization", "api-key", "x-api-key"]);

export function hasAuthenticationHeaders(headers: Record<string, string> | undefined): boolean {
	return Object.entries(headers ?? {}).some(
		([name, value]) => AUTHENTICATION_HEADER_NAMES.has(name.toLowerCase()) && value.trim().length > 0,
	);
}

export function hasUsableRequestAuth(auth: RequestAuth): boolean {
	return Boolean(auth.apiKey?.trim()) || hasAuthenticationHeaders(auth.headers);
}
