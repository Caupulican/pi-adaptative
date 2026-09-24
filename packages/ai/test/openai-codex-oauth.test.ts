import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loginOpenAICodexDeviceCode,
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "../src/utils/oauth/openai-codex.ts";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function createIdToken(): string {
	return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {} })).toString("base64url")}.signature`;
}

function createAccessToken(accountId: string, exp?: number): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
			},
			...(exp === undefined ? {} : { exp }),
		}),
	).toString("base64");
	return `${header}.${payload}.signature`;
}

function deviceAuthPendingResponse(): Response {
	return jsonResponse(
		{
			error: {
				message: "Device authorization is pending. Please try again.",
				type: "invalid_request_error",
				param: null,
				code: "deviceauth_authorization_pending",
			},
		},
		403,
	);
}

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("logs in with the OpenAI Codex device code flow", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-05-20T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessToken = createAccessToken("account-123");
		const deviceInfos: Array<{
			userCode: string;
			verificationUri: string;
			instructions?: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}> = [];
		const pollTimes: number[] = [];
		const pollResponses = [
			deviceAuthPendingResponse(),
			jsonResponse({
				authorization_code: "oauth-code",
				code_challenge: "device-code-challenge",
				code_verifier: "device-code-verifier",
			}),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
				return jsonResponse({
					device_auth_id: "device-auth-id",
					user_code: "ABCD-1234",
					interval: "5",
				});
			}

			if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
				pollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(JSON.parse(String(init?.body))).toEqual({
					device_auth_id: "device-auth-id",
					user_code: "ABCD-1234",
				});
				const response = pollResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra device auth poll");
				}
				return response;
			}

			if (url === "https://auth.openai.com/oauth/token") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
				expect(params.get("code")).toBe("oauth-code");
				expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
				expect(params.get("code_verifier")).toBe("device-code-verifier");
				return jsonResponse({
					access_token: accessToken,
					refresh_token: "refresh-token",
					id_token: createIdToken(),
					expires_in: 3600,
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const credentialsPromise = loginOpenAICodexDeviceCode({
			onDeviceCode: (info) => deviceInfos.push(info),
		});

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(deviceInfos).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://auth.openai.com/codex/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
		expect(pollTimes).toEqual([startTime.getTime()]);

		await vi.advanceTimersByTimeAsync(4999);
		expect(pollTimes).toEqual([startTime.getTime()]);

		await vi.advanceTimersByTimeAsync(1);
		await expect(credentialsPromise).resolves.toMatchObject({
			access: accessToken,
			refresh: "refresh-token",
			expires: startTime.getTime() + 5000 + 3600 * 1000 - 5 * 60 * 1000,
			accountId: "account-123",
		});
		expect(pollTimes).toEqual([startTime.getTime(), startTime.getTime() + 5000]);
	});

	it("offers browser login first and uses the selected OpenAI Codex device code flow", async () => {
		const accessToken = createAccessToken("account-456");
		const selectPrompts: Array<{
			message: string;
			options: Array<{ id: string; label: string }>;
		}> = [];
		const deviceInfos: Array<{
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}> = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "WXYZ-7890",
						interval: "5",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					return jsonResponse({
						authorization_code: "oauth-code",
						code_challenge: "device-code-challenge",
						code_verifier: "device-code-verifier",
					});
				}
				if (url === "https://auth.openai.com/oauth/token") {
					return jsonResponse({
						access_token: accessToken,
						refresh_token: "refresh-token",
						id_token: createIdToken(),
						expires_in: 3600,
					});
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		await expect(
			openaiCodexOAuthProvider.login({
				onAuth: () => {
					throw new Error("Browser login should not start");
				},
				onDeviceCode: (info) => deviceInfos.push(info),
				onPrompt: async () => {
					throw new Error("Prompt should not be used");
				},
				onSelect: async (prompt) => {
					selectPrompts.push(prompt);
					return "device_code";
				},
			}),
		).resolves.toMatchObject({
			access: accessToken,
			refresh: "refresh-token",
			accountId: "account-456",
		});

		expect(selectPrompts).toEqual([
			{
				message: "Select OpenAI Codex login method:",
				options: [
					{ id: "browser", label: "Browser login (default)" },
					{ id: "device_code", label: "Device code login (headless)" },
				],
			},
		]);
		expect(deviceInfos).toEqual([
			{
				userCode: "WXYZ-7890",
				verificationUri: "https://auth.openai.com/codex/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
	});

	it("cancels when OpenAI Codex login method selection is cancelled", async () => {
		await expect(
			openaiCodexOAuthProvider.login({
				onAuth: () => {},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onSelect: async () => undefined,
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("cancels the OpenAI Codex device code flow while waiting", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const pollTimes: number[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "5",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					return deviceAuthPendingResponse();
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginOpenAICodexDeviceCode({
			onDeviceCode: () => {},
			signal: controller.signal,
		});
		const rejectionPromise = credentialsPromise.then(
			() => new Error("Expected login to fail"),
			(error: unknown) => error,
		);

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(pollTimes).toHaveLength(1);

		controller.abort();
		const rejection = await rejectionPromise;
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe("Login cancelled");
	});

	it("times out the OpenAI Codex device code flow after 15 minutes", async () => {
		vi.useFakeTimers();
		const pollTimes: number[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "60",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					return deviceAuthPendingResponse();
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginOpenAICodexDeviceCode({
			onDeviceCode: () => {},
		});
		const rejectionPromise = credentialsPromise.then(
			() => new Error("Expected login to fail"),
			(error: unknown) => error,
		);

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(pollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
		const rejection = await rejectionPromise;
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe("Device flow timed out");
	});

	it("treats OpenAI Codex device auth 403 and 404 responses as pending", async () => {
		vi.useFakeTimers();
		const accessToken = createAccessToken("account-403-404");
		const pollTimes: number[] = [];
		const pollResponses = [
			jsonResponse({ error: "access_denied", error_description: "denied" }, 403),
			new Response("not ready", { status: 404, headers: { "Content-Type": "text/plain" } }),
			jsonResponse({
				authorization_code: "oauth-code",
				code_challenge: "device-code-challenge",
				code_verifier: "device-code-verifier",
			}),
		];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "1",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					const response = pollResponses.shift();
					if (!response) {
						throw new Error("Unexpected extra device auth poll");
					}
					return response;
				}
				if (url === "https://auth.openai.com/oauth/token") {
					return jsonResponse({
						access_token: accessToken,
						refresh_token: "refresh-token",
						id_token: createIdToken(),
						expires_in: 3600,
					});
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginOpenAICodexDeviceCode({
			onDeviceCode: () => {},
		});

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);

		await expect(credentialsPromise).resolves.toMatchObject({
			access: accessToken,
			refresh: "refresh-token",
			accountId: "account-403-404",
		});
		expect(pollTimes).toHaveLength(3);
	});

	it("keeps OpenAI Codex device auth failures structural, without response bodies or secrets", async () => {
		const secret = "zq9-device-secret-7f3a";
		const run = async (usercode: () => Response, token: () => Response) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: unknown): Promise<Response> => {
					const url = getUrl(input);
					if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") return usercode();
					if (url === "https://auth.openai.com/api/accounts/deviceauth/token") return token();
					throw new Error(`Unexpected fetch URL: ${url}`);
				}),
			);
			return loginOpenAICodexDeviceCode({ onDeviceCode: () => {} }).then(
				() => {
					throw new Error("expected the login to fail");
				},
				(error: unknown) => (error as Error).message,
			);
		};
		const validCode = () => jsonResponse({ device_auth_id: secret, user_code: `${secret}-code`, interval: "0" });
		const messages = [
			await run(validCode, () => jsonResponse({ error: "server_error", error_description: secret }, 500)),
			await run(validCode, () => jsonResponse({ error: `bad ${secret}` }, 500)),
			await run(validCode, () => jsonResponse({ authorization_code: secret })),
			await run(validCode, () => new Response(`not json ${secret}`, { status: 200 })),
			await run(() => new Response(`upstream said ${secret}`, { status: 500 }), validCode),
			await run(() => jsonResponse({ device_auth_id: secret, interval: 5 }), validCode),
			await run(() => new Response(`{"device_auth_id":"${secret}"`, { status: 200 }), validCode),
		];
		expect(messages).toEqual([
			"OpenAI Codex device auth failed with status 500 (server_error)",
			"OpenAI Codex device auth failed with status 500",
			"Invalid OpenAI Codex device auth token response: missing code_verifier",
			"OpenAI Codex device auth token response was not valid JSON",
			"OpenAI Codex device code request failed with status 500",
			"Invalid OpenAI Codex device code response: missing or invalid user_code",
			"OpenAI Codex device code response was not valid JSON",
		]);
		for (const message of messages) expect(message).not.toContain(secret);
	});

	it("applies the early-refresh buffer to refreshed OpenAI Codex tokens", async () => {
		const now = new Date("2026-07-06T12:00:00.000Z");
		vi.setSystemTime(now);
		const accessToken = createAccessToken("account-refresh");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					access_token: accessToken,
					refresh_token: "new-refresh-token",
					expires_in: 3600,
				}),
			),
		);

		await expect(refreshOpenAICodexToken("old-refresh-token")).resolves.toMatchObject({
			access: accessToken,
			refresh: "new-refresh-token",
			expires: now.getTime() + 3600 * 1000 - 5 * 60 * 1000,
		});
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					JSON.stringify({
						error: {
							message: "Could not validate your token. Please try signing in again.",
							type: "invalid_request_error",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(refreshOpenAICodexToken("invalid-refresh-token")).rejects.toThrow(
			"OpenAI Codex token refresh failed (HTTP 401)",
		);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("never puts a submitted or returned token in a refresh error", async () => {
		const accessToken = createAccessToken("account-leak");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> =>
					new Response(`{"error":"invalid_grant","refresh_token":"echoed-refresh-token"} echoed-refresh-token`, {
						status: 400,
					}),
			),
		);
		const echoed = await refreshOpenAICodexToken("echoed-refresh-token").catch((error: Error) => error.message);
		expect(echoed).toBe("OpenAI Codex token refresh failed (HTTP 400)");

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: accessToken, refresh_token: "returned-refresh-token" })),
		);
		const missing = await refreshOpenAICodexToken("old-refresh-token").catch((error: Error) => error.message);
		expect(missing).toBe(
			"OpenAI Codex token refresh response missing fields: expires_in (the token has no exp claim)",
		);
	});

	it("refreshes as the Codex CLI does: a JSON grant, the token's own expiry, and the current refresh token kept", async () => {
		const exp = Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000);
		const accessToken = createAccessToken("account-json", exp);
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
			expect(JSON.parse(String(init?.body))).toEqual({
				client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
				grant_type: "refresh_token",
				refresh_token: "current-refresh-token",
			});
			// No refresh_token and no expires_in: the reference client needs neither.
			return jsonResponse({ access_token: accessToken });
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(refreshOpenAICodexToken("current-refresh-token")).resolves.toMatchObject({
			access: accessToken,
			refresh: "current-refresh-token",
			expires: exp * 1000 - 5 * 60 * 1000,
		});
	});
});
