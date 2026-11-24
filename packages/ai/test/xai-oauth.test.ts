import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollOAuthDeviceCodeFlow } from "../src/utils/oauth/device-code.ts";
import type { OAuthLoginCallbacks } from "../src/utils/oauth/types.ts";
import { loginXai, refreshXaiToken } from "../src/utils/oauth/xai.ts";
import { verifyXaiIdToken } from "../src/utils/oauth/xai-oidc.ts";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

function encodedJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function signedIdToken(privateKey: CryptoKey, claims: Record<string, unknown>): Promise<string> {
	const header = encodedJson({ alg: "RS256", kid: "fixture-key", typ: "JWT" });
	const payload = encodedJson(claims);
	const signature = await crypto.subtle.sign(
		{ name: "RSASSA-PKCS1-v1_5" },
		privateKey,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
}

async function runBrowserLogin(
	deviceFallback = false,
	identity: { issuer: string; clientId: string } = {
		issuer: "https://auth.x.ai",
		clientId: XAI_CLIENT_ID,
	},
): Promise<{
	credentials: Awaited<ReturnType<typeof loginXai>>;
	authorizationUrl: URL;
	fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
	onProgress: ReturnType<typeof vi.fn>;
}> {
	const keyPair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
	Object.assign(publicJwk, { alg: "RS256", kid: "fixture-key", use: "sig" });
	const issuerBase = identity.issuer.replace(/\/+$/, "");
	let authorizationUrl: URL | undefined;
	const fetchMock = vi.fn<typeof fetch>(async (input) => {
		const url = String(input);
		if (deviceFallback && url === `${issuerBase}/oauth2/device/code`) {
			return new Response(null, { status: 404 });
		}
		if (url === `${issuerBase}/.well-known/openid-configuration`) {
			return Response.json({
				issuer: identity.issuer,
				authorization_endpoint: `${issuerBase}/authorize`,
				token_endpoint: `${issuerBase}/oauth2/token`,
				jwks_uri: `${issuerBase}/.well-known/jwks.json`,
				id_token_signing_alg_values_supported: ["RS256"],
			});
		}
		if (url === `${issuerBase}/oauth2/token`) {
			if (!authorizationUrl) throw new Error("authorization URL was not published");
			const token = await signedIdToken(keyPair.privateKey, {
				iss: identity.issuer,
				aud: identity.clientId,
				nonce: authorizationUrl.searchParams.get("nonce"),
				sub: "fixture-user",
				email: "fixture@example.test",
				exp: Math.floor(Date.now() / 1000) + 3600,
			});
			return Response.json({
				access_token: "browser-access",
				refresh_token: "browser-refresh",
				expires_in: 3600,
				id_token: token,
			});
		}
		if (url === `${issuerBase}/.well-known/jwks.json`) return Response.json({ keys: [publicJwk] });
		throw new Error(`Unexpected xAI OAuth request: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	if (deviceFallback) vi.stubEnv("GROK_LOGIN_DEVICE_FLOW", "1");
	const onProgress = vi.fn();
	const callbacks = {
		onAuth: (info) => {
			authorizationUrl = new URL(info.url);
		},
		onDeviceCode: vi.fn(),
		onPrompt: async () => "",
		onProgress,
		onManualCodeInput: async () => {
			if (!authorizationUrl) throw new Error("authorization URL was not published");
			const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
			callback.searchParams.set("code", "fixture-code");
			callback.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
			return callback.toString();
		},
		onSelect: async () => undefined,
	} satisfies OAuthLoginCallbacks;
	const credentials = await loginXai(callbacks);
	if (!authorizationUrl) throw new Error("authorization URL was not published");
	return { credentials, authorizationUrl, fetchMock, onProgress };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("bounded xAI OAuth transport", () => {
	it("keeps native protocol identity and refresh credentials", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ access_token: "access", expires_in: 3600 }));
		vi.stubGlobal("fetch", fetchMock);
		const credentials = await refreshXaiToken("refresh");
		expect(credentials.access).toBe("access");
		expect(credentials.refresh).toBe("refresh");
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://auth.x.ai/oauth2/token");
		expect(String(init?.body)).toContain("client_id=b1a00492-073a-47ea-816f-4c329264a828");
		expect(init?.redirect).toBe("error");
	});

	it.each([200, 400])("cancels oversized HTTP %s bodies and releases the reader", async (status) => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(64 * 1024 + 1));
			},
			cancel() {
				cancelled = true;
			},
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status })));
		await expect(refreshXaiToken("refresh")).rejects.toThrow("64 KiB");
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
	});

	it("retains a body timeout instead of reclassifying it as invalid JSON", async () => {
		const timeout = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const error = new DOMException("OAuth body timed out", "TimeoutError");
				timeout.abort(error);
				controller.error(error);
			},
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
		await expect(refreshXaiToken("refresh")).rejects.toMatchObject({ name: "TimeoutError" });
		expect(body.locked).toBe(false);
	});

	it("reports malformed JSON with its HTTP status", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{", { status: 400 })));
		await expect(refreshXaiToken("refresh")).rejects.toThrow("invalid JSON (HTTP 400)");
	});

	it("uses the native 30-day lifetime and five-minute early refresh when expiry is omitted", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ access_token: "access" })));
		await expect(refreshXaiToken("refresh")).resolves.toMatchObject({
			expires: Date.now() + (30 * 24 * 60 * 60 - 5 * 60) * 1000,
		});
	});

	it.each(["invalid_grant", "invalid_client"])(
		"classifies %s as a permanent refresh rejection independent of HTTP status",
		async (error) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error }, { status: 503 })));
			await expect(refreshXaiToken("refresh")).rejects.toMatchObject({
				name: "OAuthRefreshRejectedError",
				providerId: "xai",
				reason: "rejected",
			});
		},
	);

	it("preserves the caller's cancellation reason", async () => {
		const controller = new AbortController();
		const reason = new Error("refresh lease lost");
		controller.abort(reason);
		await expect(refreshXaiToken("refresh", { signal: controller.signal })).rejects.toBe(reason);
	});

	it("refreshes a stored session without consulting unrelated interactive overrides", async () => {
		vi.stubEnv("GROK_OAUTH2_SCOPES", "not a valid scope list");
		vi.stubEnv("GROK_OAUTH2_REFERRER", "");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ access_token: "access", expires_in: 3600 })));
		await expect(
			refreshXaiToken("refresh", {
				previous: {
					access: "old-access",
					refresh: "refresh",
					expires: 0,
					authMethod: "device",
					issuer: "https://auth.x.ai",
					clientId: XAI_CLIENT_ID,
				},
			}),
		).resolves.toMatchObject({ access: "access", authMethod: "device" });
	});

	it("forwards independently stored principal fields during refresh", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ access_token: "access", expires_in: 3600 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			refreshXaiToken("refresh", {
				previous: {
					access: "old-access",
					refresh: "refresh",
					expires: 0,
					authMethod: "device",
					issuer: "https://auth.x.ai",
					clientId: XAI_CLIENT_ID,
					principalType: "",
					principalId: "team-123",
				},
			}),
		).resolves.toMatchObject({ principalType: "", principalId: "team-123" });
		const body = new URLSearchParams(String(fetchMock.mock.calls[0]![1]?.body));
		expect(body.get("principal_type")).toBe("");
		expect(body.get("principal_id")).toBe("team-123");
	});
});

describe("Grok browser OIDC login", () => {
	it("uses the native consumer scope profile and validates the returned ID token", async () => {
		const result = await runBrowserLogin();
		expect(result.credentials).toMatchObject({
			access: "browser-access",
			refresh: "browser-refresh",
			authMethod: "oidc",
			issuer: "https://auth.x.ai",
			clientId: XAI_CLIENT_ID,
			userId: "fixture-user",
			email: "fixture@example.test",
		});
		expect(result.authorizationUrl.hostname).toBe("auth.x.ai");
		expect(result.authorizationUrl.searchParams.get("response_type")).toBe("code");
		expect(result.authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(result.authorizationUrl.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		expect(result.authorizationUrl.searchParams.get("scope")?.split(" ")).toEqual([
			"openid",
			"profile",
			"email",
			"offline_access",
			"grok-cli:access",
			"api:access",
			"conversations:read",
			"conversations:write",
			"workspaces:read",
			"workspaces:write",
		]);
		const tokenCall = result.fetchMock.mock.calls.find(([url]) => String(url) === "https://auth.x.ai/oauth2/token");
		expect(String(tokenCall?.[1]?.body)).toContain("grant_type=authorization_code");
		expect(new Headers(tokenCall?.[1]?.headers).has("x-grok-client-version")).toBe(false);
		expect(new Headers(tokenCall?.[1]?.headers).has("x-grok-client-surface")).toBe(false);
	});

	it("falls back from a device authorization 404 to browser OIDC", async () => {
		const result = await runBrowserLogin(true);
		expect(result.credentials).toMatchObject({ authMethod: "oidc", access: "browser-access" });
		expect(result.fetchMock.mock.calls[0]?.[0]).toBe("https://auth.x.ai/oauth2/device/code");
		expect(result.onProgress).toHaveBeenCalledWith(expect.stringContaining("using browser sign-in"));
	});

	it("uses the five-scope customer profile only when OIDC issuer and client ID are both configured", async () => {
		const identity = { issuer: "https://customer.example/", clientId: "customer-client" };
		vi.stubEnv("GROK_OIDC_ISSUER", identity.issuer);
		vi.stubEnv("GROK_OIDC_CLIENT_ID", identity.clientId);
		const result = await runBrowserLogin(false, identity);
		expect(result.credentials).toMatchObject({ issuer: identity.issuer, clientId: identity.clientId });
		expect(result.authorizationUrl.searchParams.get("scope")?.split(" ")).toEqual([
			"openid",
			"profile",
			"email",
			"offline_access",
			"api:access",
		]);
	});

	it("appends OAuth2 principal and referrer fields to the browser authorization URL", async () => {
		vi.stubEnv("GROK_OAUTH2_ISSUER", "https://auth.x.ai");
		vi.stubEnv("GROK_OAUTH2_CLIENT_ID", XAI_CLIENT_ID);
		vi.stubEnv("GROK_OAUTH2_PRINCIPAL_TYPE", "Team");
		vi.stubEnv("GROK_OAUTH2_PRINCIPAL_ID", "team-123");
		vi.stubEnv("GROK_OAUTH2_REFERRER", "custom-referrer");
		const result = await runBrowserLogin();
		expect(result.authorizationUrl.searchParams.get("principal_type")).toBe("Team");
		expect(result.authorizationUrl.searchParams.get("principal_id")).toBe("team-123");
		expect(result.authorizationUrl.searchParams.get("referrer")).toBe("custom-referrer");
		expect(result.authorizationUrl.searchParams.get("scope")).toContain("team:read");
	});

	it("retains trimmed empty entries in configured comma-delimited scopes", async () => {
		const identity = { issuer: "https://customer.example", clientId: "customer-client" };
		vi.stubEnv("GROK_OIDC_ISSUER", identity.issuer);
		vi.stubEnv("GROK_OIDC_CLIENT_ID", identity.clientId);
		vi.stubEnv("GROK_OIDC_SCOPES", ", api:access, ");
		const result = await runBrowserLogin(false, identity);
		expect(result.authorizationUrl.searchParams.get("scope")).toBe(" api:access ");
	});

	it("ignores an incomplete customer OIDC identity", async () => {
		vi.stubEnv("GROK_OIDC_ISSUER", "https://incomplete.example");
		const result = await runBrowserLogin();
		expect(result.credentials).toMatchObject({ issuer: "https://auth.x.ai", clientId: XAI_CLIENT_ID });
	});

	it("preserves cancellation that arrives during ID-token crypto", async () => {
		const keyPair = await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		);
		const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
		Object.assign(publicJwk, { alg: "RS256", kid: "fixture-key", use: "sig" });
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ keys: [publicJwk] })));
		const controller = new AbortController();
		const reason = new Error("login lease lost");
		vi.spyOn(crypto.subtle, "verify").mockImplementation(async () => {
			controller.abort(reason);
			return true;
		});
		await expect(
			verifyXaiIdToken({
				token: `${encodedJson({ alg: "RS256", kid: "fixture-key" })}.${encodedJson({
					iss: "https://auth.x.ai",
					aud: XAI_CLIENT_ID,
					nonce: "nonce",
					exp: Math.floor(Date.now() / 1000) + 3600,
				})}.signature`,
				discovery: {
					issuer: "https://auth.x.ai",
					authorizationEndpoint: "https://auth.x.ai/authorize",
					tokenEndpoint: "https://auth.x.ai/oauth2/token",
					jwksUri: "https://auth.x.ai/.well-known/jwks.json",
					idTokenAlgorithms: ["RS256"],
				},
				clientId: XAI_CLIENT_ID,
				nonce: "nonce",
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
	});
});

describe("Grok device login", () => {
	beforeEach(() => {
		vi.stubEnv("GROK_LOGIN_DEVICE_FLOW", "1");
	});

	const device = {
		user_code: "Ab9-C",
		device_code: "device",
		verification_uri: "https://example.org/device",
		expires_in: 120,
		interval: 2,
	};
	const callbacks = () => ({
		onAuth: vi.fn(),
		onDeviceCode: vi.fn(),
		onPrompt: vi.fn(),
		onSelect: vi.fn(),
	});

	it.each(["bad\n", "\x1b[31m", "A_B", "９"])(
		"rejects malformed user codes before displaying the link",
		async (code) => {
			const host = callbacks();
			const fetchMock = vi.fn().mockResolvedValue(Response.json({ ...device, user_code: code }));
			vi.stubGlobal("fetch", fetchMock);
			await expect(loginXai(host)).rejects.toThrow("user_code");
			expect(host.onDeviceCode).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it("adds five seconds on each slow_down and retains the delay through pending responses", async () => {
		vi.useFakeTimers();
		const host = callbacks();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json(device))
			.mockResolvedValueOnce(Response.json({ error: "slow_down", interval: 1 }, { status: 400 }))
			.mockResolvedValueOnce(Response.json({ error: "slow_down", interval: 50 }, { status: 400 }))
			.mockResolvedValueOnce(Response.json({ error: "authorization_pending" }, { status: 400 }))
			.mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
		vi.stubGlobal("fetch", fetchMock);
		const login = loginXai(host);
		await vi.advanceTimersByTimeAsync(0);
		expect(host.onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: device.user_code }));
		for (const [index, delay] of [2_000, 7_000, 12_000, 12_000].entries()) {
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(fetchMock).toHaveBeenCalledTimes(index + 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(fetchMock).toHaveBeenCalledTimes(index + 2);
		}
		await expect(login).resolves.toMatchObject({ access: "access" });
		const requestBody = String(fetchMock.mock.calls[0]![1]?.body);
		expect(requestBody).toContain("openid");
		expect(requestBody).toContain("email");
		expect(requestBody).not.toContain("team%3Aread");
	});

	it("uses Team scopes only for exact Team while keeping the device form to its native three fields", async () => {
		vi.useFakeTimers();
		vi.stubEnv("GROK_OAUTH2_ISSUER", "https://auth.x.ai");
		vi.stubEnv("GROK_OAUTH2_CLIENT_ID", XAI_CLIENT_ID);
		vi.stubEnv("GROK_OAUTH2_PRINCIPAL_TYPE", "Team");
		vi.stubEnv("GROK_OAUTH2_PRINCIPAL_ID", "team-123");
		vi.stubEnv("GROK_OAUTH2_REFERRER", "custom-referrer");
		const host = callbacks();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json(device))
			.mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
		vi.stubGlobal("fetch", fetchMock);
		const login = loginXai(host);
		await vi.advanceTimersByTimeAsync(2_000);
		await expect(login).resolves.toMatchObject({
			principalType: "Team",
			principalId: "team-123",
		});
		const body = new URLSearchParams(String(fetchMock.mock.calls[0]![1]?.body));
		expect(body.get("scope")?.split(" ")).toEqual([
			"profile",
			"offline_access",
			"grok-cli:access",
			"api:access",
			"team:read",
			"conversations:read",
			"conversations:write",
			"workspaces:read",
			"workspaces:write",
		]);
		expect(body.get("principal_type")).toBeNull();
		expect(body.get("principal_id")).toBeNull();
		expect([...body.keys()]).toEqual(["client_id", "scope", "referrer"]);
		expect(body.get("referrer")).toBe("grok-build");
	});

	it("treats every nonempty GROK_LOCAL_AUTH value except exact zero as enabled", async () => {
		vi.stubEnv("GROK_LOCAL_AUTH", "false");
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ...device, user_code: "bad\n" }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(loginXai(callbacks())).rejects.toThrow("user_code");
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:22255/oauth2/device/code");
	});

	it("sleeps a long interval in timer-sized chunks without an early poll", async () => {
		vi.useFakeTimers();
		const poll = vi.fn(async () => ({ status: "complete" as const, value: "done" }));
		const totalMs = 2_147_484_000;
		const login = pollOAuthDeviceCodeFlow({
			intervalSeconds: totalMs / 1000,
			waitBeforeFirstPoll: true,
			poll,
		});
		await vi.advanceTimersByTimeAsync(totalMs - 1);
		expect(poll).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await expect(login).resolves.toBe("done");
	});

	it("drops a successful poll if the caller cancelled during the request", async () => {
		const controller = new AbortController();
		const login = pollOAuthDeviceCodeFlow({
			signal: controller.signal,
			poll: async () => {
				controller.abort();
				return { status: "complete", value: "stale" };
			},
		});
		await expect(login).rejects.toThrow("Login cancelled");
	});
});
