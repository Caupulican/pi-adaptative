import type { OAuthProviderInterface } from "@caupulican/pi-ai/oauth";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@caupulican/pi-ai/types";
import type { AuthStatus, AuthStorage } from "./auth-storage.ts";
import type { ModelOverride, ProviderRequestConfig } from "./models-config-schema.ts";
import type { RequestAuth } from "./request-auth.ts";

export type ResolvedRequestAuth =
	| ({ ok: true; providerAccountKey: string } & RequestAuth)
	| {
			ok: false;
			error: string;
	  };

/**
 * Input type for registerProvider API.
 */
export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	/** OAuth provider for /login support */
	oauth?: Omit<OAuthProviderInterface, "id">;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		defaultThinkingLevel?: Model<Api>["defaultThinkingLevel"];
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow?: number;
		textToolCallProtocol?: boolean;
		maxTokens?: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
	modelOverrides?: Record<string, ModelOverride>;
}

export interface ModelRegistryReloadSnapshot {
	models: Model<Api>[];
	providerRequestConfigs: Map<string, ProviderRequestConfig>;
	modelRequestHeaders: Map<string, Record<string, string>>;
	registeredProviders: Map<string, ProviderConfigInput>;
	providerModelScopes: Map<string, Set<string>>;
	loadError: string | undefined;
}

/**
 * The model registry as the extension API and other contracts see it: every public member of
 * `ModelRegistry`, which implements it, so the contract cannot drift from the class.
 */
export interface ModelRegistryContract {
	readonly authStorage: AuthStorage;
	refresh(): void;
	getError(): string | undefined;
	getAll(): Model<Api>[];
	getKnownCredentialValues(): string[];
	getAvailable(): Model<Api>[];
	setProviderModelScope(provider: string, modelIds: Iterable<string> | undefined): void;
	getProviderModelScope(provider: string): string[] | undefined;
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
	getAuthenticatedProviders(): string[];
	canUseResolvedRequestAuth(
		model: Model<Api>,
		auth: ResolvedRequestAuth,
	): auth is Extract<ResolvedRequestAuth, { ok: true }>;
	getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth>;
	recoverRejectedOAuthApiKey(providerId: string, rejectedApiKey: string): Promise<string | undefined>;
	getProviderAuthStatus(provider: string): AuthStatus;
	getProviderDisplayName(provider: string): string;
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
	isUsingOAuth(model: Model<Api>): boolean;
	isUsingSubscription(model: Model<Api>): boolean;
	registerProvider(providerName: string, config: ProviderConfigInput): void;
	createReloadSnapshot(): ModelRegistryReloadSnapshot;
	restoreReloadSnapshot(snapshot: ModelRegistryReloadSnapshot): void;
	unregisterProvider(providerName: string): void;
	unregisterProviders(providerNames: Iterable<string>): void;
}
