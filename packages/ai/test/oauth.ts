/**
 * Test helper for resolving API keys from ~/.pi/agent/auth.json
 *
 * Supports both API key and OAuth credentials.
 * OAuth tokens are automatically refreshed if expired and saved back to auth.json.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import type { KnownProvider } from "../src/types.ts";
import { getOAuthApiKey } from "../src/utils/oauth/index.ts";
import type { OAuthCredentials, OAuthProvider } from "../src/utils/oauth/types.ts";

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

/**
 * Live tests make real, paid provider calls. They are opt-in only: without
 * PI_LIVE_TESTS=1, credential-reading helpers below return undefined so every
 * gated test skips instead of silently calling out (including from the
 * pre-commit hook, which runs any staged test file).
 */
export function liveTestsEnabled(): boolean {
	return process.env.PI_LIVE_TESTS === "1";
}

type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

type OAuthCredentialEntry = {
	type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredentialEntry;

type AuthStorage = Record<string, AuthCredential>;

function loadAuthStorage(): AuthStorage {
	if (!existsSync(AUTH_PATH)) {
		return {};
	}
	try {
		const content = readFileSync(AUTH_PATH, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function saveAuthStorage(storage: AuthStorage): void {
	const configDir = dirname(AUTH_PATH);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(AUTH_PATH, JSON.stringify(storage, null, 2), "utf-8");
	chmodSync(AUTH_PATH, 0o600);
}

/**
 * Resolve API key for a provider from ~/.pi/agent/auth.json
 *
 * For API key credentials, returns the key directly.
 * For OAuth credentials, returns the access token (refreshing if expired and saving back).
 *
 */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	if (!liveTestsEnabled()) return undefined;

	const storage = loadAuthStorage();
	const entry = storage[provider];

	if (!entry) return undefined;

	if (entry.type === "api_key") {
		return entry.key;
	}

	if (entry.type === "oauth") {
		// Build OAuthCredentials record for getOAuthApiKey
		const oauthCredentials: Record<string, OAuthCredentials> = {};
		for (const [key, value] of Object.entries(storage)) {
			if (value.type === "oauth") {
				const { type: _, ...creds } = value;
				oauthCredentials[key] = creds;
			}
		}

		let result: { newCredentials: OAuthCredentials; apiKey: string } | null = null;
		try {
			result = await getOAuthApiKey(provider as OAuthProvider, oauthCredentials);
		} catch (e) {
			console.log(JSON.stringify(e));
		}
		if (!result) return undefined;

		// Save refreshed credentials back to auth.json
		storage[provider] = { type: "oauth", ...result.newCredentials };
		saveAuthStorage(storage);

		return result.apiKey;
	}

	return undefined;
}

/**
 * Resolve a provider API key from known environment variables (e.g. OPENAI_API_KEY),
 * for e2e tests that decide whether to run based on a configured provider key.
 * Gated by PI_LIVE_TESTS=1 like resolveApiKey above, so a real key sitting in the
 * shell environment never triggers a live call by itself.
 */
export function liveEnvApiKey(provider: KnownProvider): string | undefined;
export function liveEnvApiKey(provider: string): string | undefined;
export function liveEnvApiKey(provider: string): string | undefined {
	if (!liveTestsEnabled()) return undefined;
	return getEnvApiKey(provider);
}

/**
 * Read a raw environment variable, gated by PI_LIVE_TESTS=1 like the helpers above.
 * For credential shapes `liveEnvApiKey` can't express as a single provider lookup:
 * a specific env var among several a provider accepts (e.g. distinguishing an
 * Anthropic OAuth-token test from an Anthropic API-key test), or a non-key
 * credential such as an endpoint URL, region, account id, or deployment name.
 */
export function liveEnvVar(name: string): string | undefined {
	return liveTestsEnabled() ? process.env[name] : undefined;
}
