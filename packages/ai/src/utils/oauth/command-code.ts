/** Coordinates Command Code's browser handoff and concurrently validated manual API-key sign-in. */

import { randomBytes } from "node:crypto";
import {
	type CommandCodeApiKeyValidation,
	type CommandCodeUser,
	validateCommandCodeApiKey,
} from "../../providers/command-code-account.ts";
import { isRecord } from "../value-guards.ts";
import { awaitAuthorizationInput } from "./authorization-input.ts";
import {
	CommandCodeAccessDeniedError,
	type CommandCodeCallback,
	type CommandCodeHandoff,
	startCommandCodeCallback,
} from "./command-code-callback.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const SIGN_IN_URL = "https://commandcode.ai/studio/auth/cli";
const CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const INVALID_KEY_RESET_MS = 2_000;

interface CommandCodeAuthConfig {
	readonly apiKey: string;
	readonly userId: string;
	readonly userName: string;
	readonly keyName: string;
	readonly authenticatedAt: string;
}

function sanitizeApiKey(input: string): string {
	const escapeCharacter = String.fromCharCode(27);
	const withoutPasteMarkers = input
		.replaceAll(`${escapeCharacter}[200~`, "")
		.replaceAll(`${escapeCharacter}[201~`, "")
		.replaceAll("[200~", "")
		.replaceAll("[201~", "");
	return Array.from(withoutPasteMarkers)
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code > 31 && code !== 127;
		})
		.join("")
		.trim();
}

function userFromWhoami(whoami: unknown): CommandCodeUser | undefined {
	if (!isRecord(whoami) || !isRecord(whoami.user)) return undefined;
	const user = whoami.user;
	return {
		...(typeof user.id === "string" ? { id: user.id } : {}),
		...(typeof user.name === "string" ? { name: user.name } : {}),
		...(typeof user.userName === "string" ? { userName: user.userName } : {}),
	};
}

function manualConfig(
	apiKey: string,
	validation: Extract<CommandCodeApiKeyValidation, { valid: true }>,
): CommandCodeAuthConfig {
	const user = userFromWhoami(validation.whoami);
	return {
		apiKey,
		userId: user?.id || "manual-entry",
		userName: user?.userName || user?.name || "API Key",
		keyName: "cli-manual-entry",
		authenticatedAt: new Date().toISOString(),
	};
}

function browserConfig(handoff: CommandCodeHandoff): CommandCodeAuthConfig {
	return {
		apiKey: handoff.apiKey,
		userId: handoff.userId,
		userName: handoff.userName,
		keyName: handoff.keyName,
		authenticatedAt: new Date().toISOString(),
	};
}

function toCredentials(config: CommandCodeAuthConfig): OAuthCredentials {
	return {
		access: config.apiKey,
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
		userId: config.userId,
		userName: config.userName,
		keyName: config.keyName,
		authenticatedAt: config.authenticatedAt,
	};
}

function retryMessage(validation: Extract<CommandCodeApiKeyValidation, { valid: false }>): string {
	switch (validation.error) {
		case "invalid_key":
			return "Invalid API key. Please check and try again.";
		case "network_error":
			return "Could not reach server. Check your connection and try again.";
		case "server_error":
			return "Server error. Please try again later.";
	}
}

function waitForRetry(signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, INVALID_KEY_RESET_MS);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForManualConfig(
	callbacks: OAuthLoginCallbacks,
	signal: AbortSignal,
): Promise<CommandCodeAuthConfig> {
	while (true) {
		const entered = await awaitAuthorizationInput(
			() =>
				callbacks.onPrompt({
					message: "Paste your Command Code API key",
					placeholder: "API key",
				}),
			signal,
		);
		const apiKey = sanitizeApiKey(entered);
		if (!apiKey) continue;
		callbacks.onProgress?.("Validating API key...");
		const validation = await validateCommandCodeApiKey(apiKey, { signal });
		signal.throwIfAborted();
		if (validation.valid) return manualConfig(apiKey, validation);
		callbacks.onProgress?.(retryMessage(validation));
		await waitForRetry(signal);
	}
}

function signInUrl(port: number, state: string): string {
	const url = new URL(SIGN_IN_URL);
	url.search = new URLSearchParams({
		callback: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
		state,
		mode: "redirect",
	}).toString();
	return url.toString();
}

type BrowserResult = { kind: "success"; config: CommandCodeAuthConfig } | { kind: "manual-fallback" };

async function waitForBrowser(
	callback: CommandCodeCallback,
	callbacks: OAuthLoginCallbacks,
	signal: AbortSignal,
): Promise<BrowserResult> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const expired = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => reject(new Error("Browser authentication timed out")), LOGIN_TIMEOUT_MS);
		});
		const handoff = await awaitAuthorizationInput(() => Promise.race([callback.waitForHandoff, expired]), signal);
		signal.throwIfAborted();
		return { kind: "success", config: browserConfig(handoff) };
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof CommandCodeAccessDeniedError) throw error;
		callbacks.onProgress?.(
			error instanceof Error && error.message === "Browser authentication timed out"
				? "Browser auth timed out. Paste an API key below."
				: "Browser auth failed. Paste an API key below.",
		);
		await callback.close().catch(() => {});
		return { kind: "manual-fallback" };
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export async function loginCommandCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.signal?.throwIfAborted();
	const lifetime = new AbortController();
	const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, lifetime.signal]) : lifetime.signal;
	const state = randomBytes(32).toString("base64url");
	let callback: CommandCodeCallback | undefined;
	let manual: Promise<CommandCodeAuthConfig> | undefined;
	let credentials!: OAuthCredentials;
	try {
		credentials = await (async () => {
			try {
				callback = await startCommandCodeCallback(state, signal);
			} catch {
				signal.throwIfAborted();
				callbacks.onProgress?.("Could not start browser auth. Paste your API key below.");
				return toCredentials(await waitForManualConfig(callbacks, signal));
			}

			signal.throwIfAborted();
			const url = signInUrl(callback.port, state);
			callbacks.onProgress?.(`Listening for the Command Code sign-in on 127.0.0.1:${callback.port}`);
			try {
				callbacks.onAuth({
					url,
					instructions: "Complete sign-in in your browser, or paste a Command Code API key below.",
				});
			} catch {
				signal.throwIfAborted();
				await callback.close().catch(() => {});
				callbacks.onProgress?.("Could not open browser auth. Paste your API key below.");
				return toCredentials(await waitForManualConfig(callbacks, signal));
			}
			signal.throwIfAborted();

			manual = waitForManualConfig(callbacks, signal);
			void manual.catch(() => {});
			const first = await Promise.race([
				manual.then((config) => ({ kind: "manual" as const, config })),
				waitForBrowser(callback, callbacks, signal),
			]);
			signal.throwIfAborted();
			if (first.kind === "manual") return toCredentials(first.config);
			if (first.kind === "success") return toCredentials(first.config);
			return toCredentials(await manual);
		})();
	} finally {
		lifetime.abort(new Error("Command Code sign-in completed"));
		await callback?.close().catch(() => {});
	}
	callbacks.signal?.throwIfAborted();
	return credentials;
}

export const commandCodeOAuthProvider: OAuthProviderInterface = {
	id: "command-code",
	name: "Command Code",
	isSubscription: true,
	usesCallbackServer: true,
	loginLabel: "Sign in with Command Code",
	login: loginCommandCode,
	// The key does not expire: there is nothing to refresh.
	refreshToken: async (credentials) => credentials,
	getApiKey: (credentials) => credentials.access,
};
