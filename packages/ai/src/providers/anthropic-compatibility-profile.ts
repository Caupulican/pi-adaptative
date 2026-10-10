import { ANTHROPIC_CLIENT_CONFIG } from "./anthropic-client-config.generated.ts";

export interface AnthropicClientIdentity {
	readonly version: string;
	readonly messagesUserAgent: string;
	readonly usageUserAgent: string;
}

export interface AnthropicOAuthProtocol {
	readonly clientId: string;
	readonly authorizeUrl: string;
	readonly tokenUrl: string;
	readonly manualRedirectUri: string;
	readonly inferenceScopes: readonly string[];
}

export function createAnthropicClientIdentity(version: string): AnthropicClientIdentity {
	if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) throw new Error("Invalid Claude client version");
	return Object.freeze({
		version,
		messagesUserAgent: `claude-cli/${version} (external, cli)`,
		usageUserAgent: `claude-code/${version}`,
	});
}

export const ANTHROPIC_OAUTH_PROTOCOL: AnthropicOAuthProtocol = Object.freeze({
	clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
	authorizeUrl: "https://claude.com/cai/oauth/authorize",
	tokenUrl: "https://platform.claude.com/v1/oauth/token",
	manualRedirectUri: "https://platform.claude.com/oauth/code/callback",
	inferenceScopes: Object.freeze([
		"user:profile",
		"user:inference",
		"user:sessions:claude_code",
		"user:mcp_servers",
		"user:file_upload",
		"user:plugins",
	]),
});

/** Exact reviewed images: a reported version alone cannot admit changed login/refresh code. */
export const REVIEWED_CLAUDE_INSTALLATIONS = Object.freeze([
	Object.freeze({
		version: "2.1.293",
		sha256: "8968405e26db478af44eabc4635ab5ca557057b702a54460a59c13e1b253e978",
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
	}),
	Object.freeze({
		version: "2.1.296",
		sha256: "24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de",
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
	}),
]);

export const PACKAGED_ANTHROPIC_IDENTITY: AnthropicClientIdentity = Object.freeze({ ...ANTHROPIC_CLIENT_CONFIG });
