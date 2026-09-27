export interface RequestAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	credentialHeaders?: Record<string, string>;
	providerAccountKey?: string;
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
		...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
		...(auth.headers !== undefined ? { headers: auth.headers } : {}),
		...(auth.credentialHeaders !== undefined ? { credentialHeaders: auth.credentialHeaders } : {}),
		...(providerAccountKey !== undefined ? { providerAccountKey } : {}),
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
