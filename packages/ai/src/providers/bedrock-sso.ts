const ERROR_MESSAGE_LIMIT = 512;

function errorField(error: unknown, field: "name" | "message"): string | undefined {
	if (!error || typeof error !== "object" || !(field in error)) return undefined;
	const value = (error as Record<string, unknown>)[field];
	return typeof value === "string" ? value : undefined;
}

function errorIdentity(error: unknown): { name?: string; message: string } {
	const name = errorField(error, "name");
	const message = errorField(error, "message") ?? String(error);
	return { ...(name ? { name } : {}), message };
}

function boundIdentity(identity: { name?: string; message: string }): { name?: string; message: string } {
	return { ...identity, message: identity.message.slice(0, ERROR_MESSAGE_LIMIT) };
}

/** Return the bounded failure identity only when an error explicitly names the AWS SSO lane. */
export function getRecoverableBedrockSsoError(error: unknown): { name?: string; message: string } | undefined {
	let current: unknown = error;
	const seen = new Set<unknown>();
	for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth++) {
		seen.add(current);
		const identity = errorIdentity(current);
		if (identity.name === "UnauthorizedSSOTokenError") return boundIdentity(identity);
		const message = identity.message.toLowerCase();
		const identifiesSso =
			message.includes("sso session") ||
			message.includes("sso token") ||
			message.includes("aws sso login") ||
			message.includes("iam identity center");
		if (identifiesSso && /expired|invalid|refresh|login|required|unauthorized/.test(message)) {
			return boundIdentity(identity);
		}
		if (!current || typeof current !== "object" || !("cause" in current)) break;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}
