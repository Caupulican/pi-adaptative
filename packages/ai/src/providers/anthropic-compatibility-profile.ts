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
	Object.freeze({
		version: "2.1.299",
		sha256: "2d894a4b1bfaaa9aab72aeff7803e3c73bc2510f279a171f6b8f59f72d17d077",
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
	}),
	Object.freeze({
		version: "2.1.300",
		sha256: "674deba0bba9aee479f4503c438b49303b6fdd304b9a471b14977aaec5215453",
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
	}),
	Object.freeze({
		version: "2.1.305",
		sha256: "86cb722ab68348877dba7971e4d0c659919e05e6228c05e006e83da320e656ef",
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
	}),
	Object.freeze({
		version: "2.1.310",
		sha256: "b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56",
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
	}),
	Object.freeze({
		version: "2.1.311",
		sha256: "86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada",
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
	}),
	Object.freeze({
		version: "2.1.312",
		sha256: "4f4178ce41d83e23341ebfbaecdbcf8ea6bf7baea0690025abe49eeec3a5d01d",
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
	}),
	Object.freeze({
		version: "2.1.314",
		sha256: "4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594",
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
	}),
]);

export const PACKAGED_ANTHROPIC_IDENTITY: AnthropicClientIdentity = Object.freeze({ ...ANTHROPIC_CLIENT_CONFIG });
