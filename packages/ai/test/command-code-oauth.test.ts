/** Regression coverage for Command Code 1.93.2 browser handoff, legacy JSON, and manual-key competition. */

import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateCommandCodeApiKey } from "../src/providers/command-code-account.ts";
import { loginCommandCode } from "../src/utils/oauth/command-code.ts";
import { startCommandCodeCallback } from "../src/utils/oauth/command-code-callback.ts";
import type { OAuthAuthInfo, OAuthLoginCallbacks } from "../src/utils/oauth/types.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function callbacks(overrides: Partial<OAuthLoginCallbacks>): OAuthLoginCallbacks {
	return {
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => await new Promise<string>(() => {}),
		onSelect: async () => undefined,
		...overrides,
	};
}

function startLogin(overrides: Omit<Partial<OAuthLoginCallbacks>, "signal"> = {}) {
	const controller = new AbortController();
	const login = loginCommandCode(callbacks({ ...overrides, signal: controller.signal }));
	void login.catch(() => {});
	return { controller, login };
}

function callbackParts(info: OAuthAuthInfo): { callback: URL; state: string } {
	const signIn = new URL(info.url);
	const callback = new URL(signIn.searchParams.get("callback") ?? "");
	const state = signIn.searchParams.get("state") ?? "";
	return { callback, state };
}

function chunkedPost(url: URL, body: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		let responseStarted = false;
		const request = httpRequest(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Transfer-Encoding": "chunked",
				},
			},
			(response) => {
				responseStarted = true;
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
				});
			},
		);
		request.on("error", (error) => {
			if (!responseStarted) reject(error);
		});
		request.write(body.slice(0, 6_000));
		request.write(body.slice(6_000));
		request.end();
	});
}

function slowPost(url: URL): {
	request: ReturnType<typeof httpRequest>;
	response: Promise<{ status?: number; error?: Error }>;
	accepted: Promise<void>;
} {
	const outcome = deferred<{ status?: number; error?: Error }>();
	const accepted = deferred<void>();
	const request = httpRequest(
		url,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Expect: "100-continue",
				"Transfer-Encoding": "chunked",
			},
		},
		(response) => {
			response.resume();
			response.on("end", () => outcome.resolve({ status: response.statusCode }));
		},
	);
	request.once("continue", () => accepted.resolve());
	request.on("error", (error) => outcome.resolve({ error }));
	request.flushHeaders();
	return { request, response: outcome.promise, accepted: accepted.promise };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Command Code OAuth parity", () => {
	it("uses an ephemeral strict-loopback callback and preserves the native form/landing HTTP contract", async () => {
		const auth = deferred<OAuthAuthInfo>();
		const attempt = startLogin({ onAuth: auth.resolve });
		try {
			const info = await auth.promise;
			const { callback, state } = callbackParts(info);

			expect(callback.hostname).toBe("127.0.0.1");
			expect(Number(callback.port)).toBeGreaterThan(0);
			expect(callback.pathname).toBe("/callback");

			const preflight = await fetch(callback, {
				method: "OPTIONS",
				headers: {
					Origin: "https://not-command-code.example",
					"Access-Control-Request-Private-Network": "true",
				},
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
			expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
			expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");

			const callbackGet = await fetch(callback, { redirect: "manual" });
			expect(callbackGet.status).toBe(405);
			expect(callbackGet.headers.get("allow")).toBe("POST, OPTIONS");

			const malformed = await fetch(callback, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{",
			});
			expect(malformed.status).toBe(400);
			expect(await malformed.json()).toEqual({ success: false, error: "Invalid JSON" });

			const oversized = await fetch(callback, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "x".repeat(10_001),
			});
			expect(oversized.status).toBe(413);

			const form = new URLSearchParams({
				apiKey: "cc-browser-key",
				state,
				userId: "user-1",
				userName: "Ada",
				keyName: "browser-key",
			});
			const handoff = await fetch(callback, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: form,
				redirect: "manual",
			});
			expect(handoff.status).toBe(303);
			const landingLocation = handoff.headers.get("location");
			expect(landingLocation).toBe(`/callback/complete?state=${encodeURIComponent(state)}`);

			const wrongLanding = await fetch(new URL("/callback/complete?state=wrong", callback));
			expect(wrongLanding.status).toBe(403);
			const landing = await fetch(new URL(landingLocation ?? "", callback));
			expect(landing.status).toBe(200);

			await expect(attempt.login).resolves.toMatchObject({
				access: "cc-browser-key",
				refresh: "",
				expires: Number.MAX_SAFE_INTEGER,
				userId: "user-1",
				userName: "Ada",
				keyName: "browser-key",
				authenticatedAt: expect.any(String),
			});
		} finally {
			attempt.controller.abort(new Error("test cleanup"));
		}
	});

	it("retains the legacy JSON contract where metadata strings may be empty", async () => {
		const auth = deferred<OAuthAuthInfo>();
		const attempt = startLogin({ onAuth: auth.resolve });
		try {
			const { callback, state } = callbackParts(await auth.promise);
			const response = await fetch(callback, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ apiKey: "cc-legacy-key", state, userId: "", userName: "", keyName: "" }),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });
			await expect(attempt.login).resolves.toMatchObject({
				access: "cc-legacy-key",
				userId: "",
				userName: "",
				keyName: "",
			});
		} finally {
			attempt.controller.abort(new Error("test cleanup"));
		}
	});

	it("stops a chunked callback as soon as its streamed body exceeds 10,000 bytes", async () => {
		const auth = deferred<OAuthAuthInfo>();
		const attempt = startLogin({ onAuth: auth.resolve });
		try {
			const { callback } = callbackParts(await auth.promise);
			const response = await chunkedPost(callback, "x".repeat(10_001));
			expect(response.status).toBe(413);
			expect(JSON.parse(response.body)).toEqual({ success: false, error: "Payload too large" });
		} finally {
			attempt.controller.abort(new Error("test cleanup"));
			await expect(attempt.login).rejects.toThrow("test cleanup");
		}
	});

	it("does not let an accepted POST recreate handoff state after shutdown starts", async () => {
		const state = "closing-state";
		const callback = await startCommandCodeCallback(state);
		const requestUrl = new URL(`http://127.0.0.1:${callback.port}/callback`);
		const slow = slowPost(requestUrl);
		let handoffSettled = false;
		void callback.waitForHandoff.then(
			() => {
				handoffSettled = true;
			},
			() => {
				handoffSettled = true;
			},
		);
		try {
			await slow.accepted;
			const closing = callback.close();
			slow.request.end(`apiKey=late-browser-key&state=${state}&userId=late&userName=Late&keyName=late-key`);
			const response = await slow.response;
			expect(response).toEqual({ status: 503 });
			await closing;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(handoffSettled).toBe(false);
		} finally {
			slow.request.destroy();
			await callback.close().catch(() => {});
		}
	});

	it("sanitizes and validates manual keys while browser login remains pending", async () => {
		const realFetch = globalThis.fetch;
		const auth = deferred<OAuthAuthInfo>();
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ user: { id: "manual-user", userName: "Grace" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const attempt = startLogin({
			onAuth: auth.resolve,
			onPrompt: async () => "\u001b[200~  cc-manual-key  \u001b[201~",
		});
		try {
			const { callback } = callbackParts(await auth.promise);
			const credentials = await attempt.login;
			expect(fetchMock).toHaveBeenCalledOnce();
			const [url, init] = fetchMock.mock.calls[0] ?? [];
			expect(String(url)).toBe("https://api.commandcode.ai/alpha/whoami");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cc-manual-key");
			expect(credentials).toMatchObject({
				access: "cc-manual-key",
				userId: "manual-user",
				userName: "Grace",
				keyName: "cli-manual-entry",
				authenticatedAt: expect.any(String),
			});
			await expect(realFetch(callback)).rejects.toThrow();
		} finally {
			attempt.controller.abort(new Error("test cleanup"));
		}
	});

	it("lets browser success win while manual-key validation is in flight", async () => {
		const realFetch = globalThis.fetch;
		const auth = deferred<OAuthAuthInfo>();
		const validationStarted = deferred<void>();
		const validationCancelled = deferred<void>();
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
			const signal = init?.signal;
			validationStarted.resolve();
			return await new Promise<Response>((_resolve, reject) => {
				const cancel = () => {
					validationCancelled.resolve();
					reject(signal?.reason ?? new Error("manual validation cancelled"));
				};
				if (signal?.aborted) {
					cancel();
					return;
				}
				signal?.addEventListener("abort", cancel, { once: true });
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const attempt = startLogin({
			onAuth: auth.resolve,
			onPrompt: async () => "cc-manual-pending",
		});
		try {
			const { callback, state } = callbackParts(await auth.promise);
			await validationStarted.promise;
			const response = await realFetch(callback, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					apiKey: "cc-browser-winner",
					state,
					userId: "browser-user",
					userName: "Browser User",
					keyName: "browser-key",
				}),
			});
			expect(response.status).toBe(200);
			await expect(attempt.login).resolves.toMatchObject({
				access: "cc-browser-winner",
				userId: "browser-user",
				userName: "Browser User",
				keyName: "browser-key",
			});
			await validationCancelled.promise;
		} finally {
			attempt.controller.abort(new Error("test cleanup"));
		}
	});

	it("retains native manual-key validation classes for 401, other HTTP failures, network errors, and invalid JSON", async () => {
		const networkError = new Error("offline");
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("", { status: 401 }))
			.mockResolvedValueOnce(new Response("", { status: 403 }))
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce(new Response("not json", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(validateCommandCodeApiKey("cc-invalid")).resolves.toEqual({
			valid: false,
			error: "invalid_key",
			status: 401,
		});
		await expect(validateCommandCodeApiKey("cc-forbidden")).resolves.toEqual({
			valid: false,
			error: "server_error",
			status: 403,
		});
		await expect(validateCommandCodeApiKey("cc-offline")).resolves.toEqual({
			valid: false,
			error: "network_error",
			cause: networkError,
		});
		await expect(validateCommandCodeApiKey("cc-invalid-json")).resolves.toMatchObject({
			valid: false,
			error: "network_error",
			cause: expect.any(SyntaxError),
		});
	});

	it("turns the five-minute browser timeout into manual fallback", async () => {
		vi.useFakeTimers();
		const auth = deferred<OAuthAuthInfo>();
		const manual = deferred<string>();
		const progress: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockResolvedValue(
				new Response(JSON.stringify({ user: null }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
		const attempt = startLogin({
			onAuth: auth.resolve,
			onPrompt: async () => manual.promise,
			onProgress: (message) => progress.push(message),
		});
		try {
			await auth.promise;
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
			expect(progress).toContain("Browser auth timed out. Paste an API key below.");
			manual.resolve("cc-timeout-fallback");
			await expect(attempt.login).resolves.toMatchObject({ access: "cc-timeout-fallback" });
		} finally {
			attempt.controller.abort(new Error("test cleanup"));
		}
	});

	it("preserves cancellation while manual-key validation is in flight", async () => {
		const controller = new AbortController();
		const reason = new Error("cancel during validation");
		const validationStarted = deferred<void>();
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
			const signal = init?.signal;
			validationStarted.resolve();
			return await new Promise<Response>((_resolve, reject) => {
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const login = loginCommandCode(
			callbacks({
				signal: controller.signal,
				onPrompt: async () => "cc-cancelled-key",
			}),
		);
		const outcome = expect(login).rejects.toBe(reason);
		await validationStarted.promise;
		controller.abort(reason);
		await outcome;
	});

	it("falls back to manual validation for non-denial callback errors but terminates access_denied", async () => {
		const realFetch = globalThis.fetch;
		const manual = deferred<string>();
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ user: null }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const genericAuth = deferred<OAuthAuthInfo>();
		const genericAttempt = startLogin({ onAuth: genericAuth.resolve, onPrompt: async () => manual.promise });
		const deniedAuth = deferred<OAuthAuthInfo>();
		const deniedAttempt = startLogin({ onAuth: deniedAuth.resolve });
		try {
			const generic = callbackParts(await genericAuth.promise);
			const genericError = await realFetch(generic.callback, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ error: "", state: generic.state }),
			});
			expect(genericError.status).toBe(200);
			manual.resolve("cc-after-browser-error");
			await expect(genericAttempt.login).resolves.toMatchObject({ access: "cc-after-browser-error" });

			const denied = callbackParts(await deniedAuth.promise);
			const deniedOutcome = expect(deniedAttempt.login).rejects.toThrow("Authorization was denied by the user");
			const deniedResponse = await realFetch(denied.callback, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ error: "access_denied", state: denied.state }),
			});
			expect(deniedResponse.status).toBe(200);
			await deniedOutcome;
		} finally {
			genericAttempt.controller.abort(new Error("test cleanup"));
			deniedAttempt.controller.abort(new Error("test cleanup"));
		}
	});

	it("preserves caller cancellation after the callback has bound", async () => {
		const controller = new AbortController();
		const reason = new Error("owner cancelled Command Code login");
		const login = loginCommandCode(
			callbacks({
				signal: controller.signal,
				onAuth: () => controller.abort(reason),
			}),
		);
		await expect(login).rejects.toBe(reason);
	});
});
