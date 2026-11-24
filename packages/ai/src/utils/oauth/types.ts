import type { Api, Model } from "../../types.ts";

export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
};

export type OAuthProviderId = string;

/**
 * Non-secret provider state frozen with an OAuth credential at a request boundary.
 * Generic transports never serialize this value; the owning provider validates and consumes it.
 */
export type ProviderRequestContext = Readonly<Record<string, unknown>>;

/** @deprecated Use OAuthProviderId instead */
export type OAuthProvider = OAuthProviderId;

export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
};

export type OAuthAuthInfo = {
	url: string;
	/** Alternate sign-in link for a browser on another machine. */
	manualUrl?: string;
	instructions?: string;
};

export type OAuthDeviceCodeInfo = {
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
};

export type OAuthSelectOption = {
	id: string;
	label: string;
};

export type OAuthSelectPrompt = {
	message: string;
	options: OAuthSelectOption[];
};

export interface OAuthLoginCallbacks {
	onAuth: (info: OAuthAuthInfo) => void;
	onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	/** Show an interactive selector and return the selected option id, or undefined on cancel. */
	onSelect: (prompt: OAuthSelectPrompt) => Promise<string | undefined>;
	signal?: AbortSignal;
}

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;

	/** Whether access through this auth method is backed by a provider subscription. */
	readonly isSubscription?: boolean;

	/** Selector label for the OAuth login option, e.g. "Sign in with SuperGrok or X Premium". */
	readonly loginLabel?: string;

	/** Run the login flow, return credentials to persist */
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;

	/** Whether login uses a local callback server and supports manual code input. */
	usesCallbackServer?: boolean;

	/** Refresh expired credentials, return updated credentials to persist */
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;

	/**
	 * Optional account/catalog migration that does not rotate an otherwise valid access token.
	 * Providers use this for durable session state discovered after OAuth (for example an account project).
	 */
	updateCredentials?(credentials: OAuthCredentials): Promise<OAuthCredentials>;

	/** Whether an unexpired credential needs {@link updateCredentials}. */
	needsCredentialUpdate?(credentials: OAuthCredentials): boolean;

	/**
	 * Legacy credential-update hook. New providers should implement `needsCredentialUpdate` and
	 * `updateCredentials` so account/catalog migration cannot rotate a valid token.
	 */
	needsRefresh?(credentials: OAuthCredentials): boolean;

	/** Convert credentials to API key string for the provider */
	getApiKey(credentials: OAuthCredentials): string;

	getRequestHeaders?(credentials: OAuthCredentials): Record<string, string> | undefined;

	/** Project validated, non-secret provider state into one frozen request. */
	getRequestContext?(credentials: OAuthCredentials): ProviderRequestContext | undefined;

	/** Stable non-secret identity for account-scoped limits and in-flight work. */
	getAccountId?(credentials: OAuthCredentials): string | undefined;

	/** Optional: modify models for this provider (e.g., update baseUrl) */
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

/** @deprecated Use OAuthProviderInterface instead */
export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;
}
