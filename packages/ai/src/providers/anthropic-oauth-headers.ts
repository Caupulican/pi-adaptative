/**
 * The Claude Code OAuth message-request headers: the identity a subscription request announces to Anthropic, plus the
 * Claude Code session header when the session id is one the harness may send.
 */

/** A session id is sent only when it is 1-200 printable, non-space ASCII characters. */
function isValidOAuthSessionId(sessionId: unknown): sessionId is string {
	return (
		typeof sessionId === "string" &&
		sessionId.length >= 1 &&
		sessionId.length <= 200 &&
		/^[\x21-\x7e]+$/.test(sessionId)
	);
}

export function buildAnthropicOAuthHeaders(
	betaFeatures: readonly string[],
	userAgent: string,
	sessionId?: string,
): Record<string, string> {
	const headers: Record<string, string> = {
		accept: "application/json",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
		"user-agent": userAgent,
		"x-app": "cli",
	};

	if (isValidOAuthSessionId(sessionId)) {
		headers["X-Claude-Code-Session-Id"] = sessionId;
	}

	return headers;
}
