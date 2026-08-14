/** Kimi Code subscription OAuth device flow. */

import { retryProviderRequest } from "../provider-retry.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const REQUEST_TIMEOUT_MS = 30_000;

type DeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	intervalSeconds: number;
	expiresInSeconds: number;
};

type JsonObject = Record<string, unknown>;

function getOAuthHost(): string {
	const override = process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST;
	return (override || DEFAULT_OAUTH_HOST).replace(/\/+$/, "");
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]);
}

async function readJson(response: Response): Promise<JsonObject | null> {
	try {
		const value = (await response.json()) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
	} catch {
		return null;
	}
}

function trustedHttpUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.href;
	} catch {
		return null;
	}
}

async function startDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorization> {
	const response = await fetch(`${getOAuthHost()}/api/oauth/device_authorization`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({ client_id: CLIENT_ID }),
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Kimi Code device authorization failed with status ${response.status}${text ? `: ${text}` : ""}`);
	}

	const json = await readJson(response);
	const deviceCode = json?.device_code;
	const userCode = json?.user_code;
	const verificationUri = trustedHttpUrl(json?.verification_uri);
	const verificationUriComplete = trustedHttpUrl(json?.verification_uri_complete);
	if (typeof deviceCode !== "string" || typeof userCode !== "string" || !verificationUri || !verificationUriComplete) {
		throw new Error(`Invalid Kimi Code device authorization response: ${JSON.stringify(json)}`);
	}

	const interval = json?.interval;
	const expiresIn = json?.expires_in;
	return {
		deviceCode,
		userCode,
		verificationUri,
		verificationUriComplete,
		intervalSeconds:
			typeof interval === "number" && Number.isFinite(interval) && interval > 0
				? interval
				: DEFAULT_POLL_INTERVAL_SECONDS,
		expiresInSeconds:
			typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
				? expiresIn
				: DEVICE_CODE_TIMEOUT_SECONDS,
	};
}

function parseTokenResponse(json: JsonObject | null, operation: string): OAuthCredentials {
	const access = json?.access_token;
	const refresh = json?.refresh_token;
	const expiresIn = json?.expires_in;
	if (
		typeof access !== "string" ||
		!access ||
		typeof refresh !== "string" ||
		!refresh ||
		typeof expiresIn !== "number" ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		throw new Error(`Kimi Code token ${operation} response missing fields: ${JSON.stringify(json)}`);
	}
	return { access, refresh, expires: Date.now() + expiresIn * 1000 };
}

async function pollForToken(device: DeviceAuthorization, signal?: AbortSignal): Promise<OAuthCredentials> {
	return pollOAuthDeviceCodeFlow<OAuthCredentials>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal,
		poll: async () => {
			const response = await fetch(`${getOAuthHost()}/api/oauth/token`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					device_code: device.deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				signal: requestSignal(signal),
			});
			const json = await readJson(response);
			if (response.ok) {
				try {
					return { status: "complete", value: parseTokenResponse(json, "poll") };
				} catch (error) {
					return { status: "failed", message: error instanceof Error ? error.message : String(error) };
				}
			}

			const error = json?.error;
			if (error === "authorization_pending") return { status: "pending" };
			if (error === "slow_down") return { status: "slow_down" };
			if (error === "expired_token") {
				return { status: "failed", message: "Kimi Code device authorization expired. Please restart login." };
			}
			if (error === "access_denied") return { status: "failed", message: "Kimi Code login was denied." };
			const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : "";
			return {
				status: "failed",
				message: `Kimi Code device token request failed (status ${response.status})${typeof error === "string" ? `: ${error}${description}` : ""}`,
			};
		},
	});
}

function providerHttpError(message: string, response: Response): Error {
	return Object.assign(new Error(message), { status: response.status, headers: response.headers });
}

async function refreshKimiToken(refreshToken: string): Promise<OAuthCredentials> {
	return retryProviderRequest(
		async () => {
			const response = await fetch(`${getOAuthHost()}/api/oauth/token`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					grant_type: "refresh_token",
					refresh_token: refreshToken,
				}),
				signal: requestSignal(),
			});
			const json = await readJson(response);
			if (response.ok) return parseTokenResponse(json, "refresh");

			const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : "";
			const message = `Kimi Code token refresh failed with status ${response.status}${description}`;
			if (response.status === 401 || response.status === 403 || json?.error === "invalid_grant") {
				throw new Error(message);
			}
			throw providerHttpError(message, response);
		},
		{ maxRetries: 3 },
	);
}

export async function loginKimiCoding(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const device = await startDeviceAuthorization(callbacks.signal);
	callbacks.onDeviceCode({
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	return pollForToken(device, callbacks.signal);
}

export const kimiCodingOAuthProvider: OAuthProviderInterface = {
	id: "kimi-coding",
	name: "Kimi Code (subscription)",
	isSubscription: true,
	loginLabel: "Sign in with Kimi Code",
	login: loginKimiCoding,
	refreshToken: (credentials) => refreshKimiToken(credentials.refresh),
	getApiKey: (credentials) => credentials.access,
};
