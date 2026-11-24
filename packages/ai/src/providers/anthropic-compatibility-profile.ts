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
	readonly loginScopes: readonly string[];
}

export function createAnthropicClientIdentity(version: string): AnthropicClientIdentity {
	if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) throw new Error("Invalid Claude client version");
	return Object.freeze({
		version,
		messagesUserAgent: `claude-cli/${version} (external, cli)`,
		usageUserAgent: `claude-code/${version}`,
	});
}

const inferenceScopes = Object.freeze([
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
	"user:plugins",
]);

const priorOAuthProtocol: AnthropicOAuthProtocol = Object.freeze({
	clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
	authorizeUrl: "https://claude.com/cai/oauth/authorize",
	tokenUrl: "https://platform.claude.com/v1/oauth/token",
	manualRedirectUri: "https://platform.claude.com/oauth/code/callback",
	inferenceScopes,
	loginScopes: Object.freeze(["org:create_api_key", ...inferenceScopes]),
});

export const ANTHROPIC_OAUTH_PROTOCOL: AnthropicOAuthProtocol = Object.freeze({
	...priorOAuthProtocol,
	loginScopes: Object.freeze([...priorOAuthProtocol.loginScopes, "user:privacy_consents:write"]),
});

interface ReviewedClaudeInstallation {
	readonly version: string;
	readonly sha256: string;
	readonly oauth: AnthropicOAuthProtocol;
	/** Present when the review also covers request identity. */
	readonly identity?: AnthropicClientIdentity;
}

function reviewedInstallation(
	version: string,
	sha256: string,
	oauth: AnthropicOAuthProtocol,
): ReviewedClaudeInstallation {
	return Object.freeze({ version, sha256, oauth, identity: createAnthropicClientIdentity(version) });
}

/** Match the exact image and use only the capabilities covered by its review. */
export const REVIEWED_CLAUDE_INSTALLATIONS: readonly ReviewedClaudeInstallation[] = Object.freeze([
	reviewedInstallation(
		"2.1.293",
		"8968405e26db478af44eabc4635ab5ca557057b702a54460a59c13e1b253e978",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.296",
		"24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.299",
		"2d894a4b1bfaaa9aab72aeff7803e3c73bc2510f279a171f6b8f59f72d17d077",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.300",
		"674deba0bba9aee479f4503c438b49303b6fdd304b9a471b14977aaec5215453",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.305",
		"86cb722ab68348877dba7971e4d0c659919e05e6228c05e006e83da320e656ef",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.310",
		"b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.311",
		"86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.312",
		"4f4178ce41d83e23341ebfbaecdbcf8ea6bf7baea0690025abe49eeec3a5d01d",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.314",
		"4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.316",
		"fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.321",
		"426c33815ca6645a772f722fbff10dbf2cbdb124a8aeab733c1365dbf8bbf61f",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.322",
		"bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.323",
		"604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e",
		priorOAuthProtocol,
	),
	reviewedInstallation(
		"2.1.326",
		"b6b3647d981130dc44fc670846ae97b6cde531ffb667cf9c4d17cfcafb38cb37",
		ANTHROPIC_OAUTH_PROTOCOL,
	),
	Object.freeze({
		version: "2.1.328",
		sha256: "a982d38030b97e750848add2cbb2df6d9a70d5544a22ca9b216a349ba25865e8",
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
	}),
	Object.freeze({
		version: "2.1.329",
		sha256: "30e2724e2aecb1bf5dc9f3130901afb71c5fa229051c190a6d7ad9aff6378d6d",
		oauth: ANTHROPIC_OAUTH_PROTOCOL,
	}),
	reviewedInstallation(
		"2.1.331",
		"4c00839cf46beb2b38ec310105f2d538f7f9321fe46c636299b74bcab94626b1",
		ANTHROPIC_OAUTH_PROTOCOL,
	),
]);

export const PACKAGED_ANTHROPIC_IDENTITY: AnthropicClientIdentity = Object.freeze({ ...ANTHROPIC_CLIENT_CONFIG });
