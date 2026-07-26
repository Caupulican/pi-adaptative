export interface RequestAuth {
	apiKey?: string;
	headers?: Record<string, string>;
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
