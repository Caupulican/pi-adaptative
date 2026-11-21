import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENAI_CODEX_BROWSER_LOGIN_METHOD, openaiCodexOAuthProvider } from "../src/utils/oauth/openai-codex.ts";
import { loginOpenRouter } from "../src/utils/oauth/openrouter.ts";
import type { OAuthLoginCallbacks } from "../src/utils/oauth/types.ts";

type MockResponse = { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void };
type MockServer = {
	handler(request: { url: string; method?: string }, response: MockResponse): void;
	listening: boolean;
	listen(port: number, host: string, ready: () => void): MockServer;
	on(event: string, listener: (error: Error) => void): MockServer;
	once(event: string, listener: (error: Error) => void): MockServer;
	removeListener(event: string, listener: (error: Error) => void): MockServer;
	address(): { port: number };
	close(): void;
};

const http = vi.hoisted(() => ({ servers: [] as MockServer[] }));

vi.mock("node:http", () => ({
	createServer: (handler: MockServer["handler"]) => {
		const server: MockServer = {
			handler,
			listening: false,
			listen(_port, _host, ready) {
				this.listening = true;
				queueMicrotask(ready);
				return this;
			},
			on() {
				return this;
			},
			once() {
				return this;
			},
			removeListener() {
				return this;
			},
			address() {
				return { port: 45454 };
			},
			close() {
				this.listening = false;
			},
		};
		http.servers.push(server);
		return server;
	},
}));

const token = `fixture.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
const tokenResponse = () => Response.json({ access_token: token, refresh_token: "synthetic-refresh", id_token: token });

function callback(url: string, values: Record<string, string>) {
	const state = new URL(url).searchParams.get("state")!;
	const query = new URLSearchParams({ state, ...values });
	http.servers
		.at(-1)!
		.handler({ url: `/auth/callback?${query}` }, { statusCode: 0, setHeader: () => {}, end: () => {} });
}

function host(signal: AbortSignal): OAuthLoginCallbacks {
	return {
		signal,
		onAuth: vi.fn(),
		onDeviceCode: vi.fn(),
		onPrompt: vi.fn(async () => ""),
		onSelect: async () => OPENAI_CODEX_BROWSER_LOGIN_METHOD,
	};
}

function observe<T>(promise: Promise<T>) {
	const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
	const done = promise.then(
		(value) => {
			state.settled = true;
			state.value = value;
		},
		(error) => {
			state.settled = true;
			state.error = error;
		},
	);
	return { state, done };
}

async function flush() {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}

beforeEach(async () => {
	await import("node:crypto");
	await import("node:http");
	http.servers.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("Unexpected network request"))),
	);
});

afterEach(() => {
	for (const server of http.servers) server.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("OpenRouter callback-host cleanup", () => {
	beforeEach(() => vi.useFakeTimers());

	it.each(["onAuth", "onProgress"] as const)(
		"closes the listener and login alarm when %s throws",
		async (callbackName) => {
			const callbacks = host(new AbortController().signal);
			callbacks[callbackName] = () => {
				throw new Error("Host closed while publishing sign-in instructions");
			};
			await expect(loginOpenRouter(callbacks)).rejects.toThrow("Host closed");
			expect(http.servers).toHaveLength(1);
			expect(http.servers[0]!.listening).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("still closes a waiting login on owner cancellation", async () => {
		const cancellation = new AbortController();
		const callbacks = host(cancellation.signal);
		callbacks.onAuth = () => cancellation.abort(new Error("Owner cancelled"));
		await expect(loginOpenRouter(callbacks)).rejects.toThrow("cancelled");
		expect(http.servers[0]!.listening).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("completes the ordinary callback and key exchange without a lingering alarm", async () => {
		const callbacks = host(new AbortController().signal);
		callbacks.onAuth = (info) => {
			const callbackUrl = new URL(new URL(info.url).searchParams.get("callback_url")!);
			callbackUrl.searchParams.set("code", "synthetic-openrouter-code");
			http.servers[0]!.handler(
				{ method: "GET", url: callbackUrl.pathname + callbackUrl.search },
				{ statusCode: 0, setHeader: () => {}, end: () => {} },
			);
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ key: "synthetic-openrouter-key" })),
		);
		await expect(loginOpenRouter(callbacks)).resolves.toMatchObject({ access: "synthetic-openrouter-key" });
		expect(http.servers[0]!.listening).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(fetch).toHaveBeenCalledOnce();
	});
});

describe("fresh Codex browser login lifetime", () => {
	it("cancels an SDK method selection whose input callback is still pending", async () => {
		const cancellation = new AbortController();
		const callbacks = host(cancellation.signal);
		let release!: (value: string | undefined) => void;
		callbacks.onSelect = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		const login = observe(openaiCodexOAuthProvider.login(callbacks));
		try {
			cancellation.abort(new Error("Host cancelled method selection"));
			await flush();
			expect(login.state.settled).toBe(true);
			expect(login.state.error).toBeDefined();
			expect(http.servers).toHaveLength(0);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			release(undefined);
			await login.done;
		}
	});

	it("closes its callback listener when the host auth callback throws", async () => {
		const callbacks = host(new AbortController().signal);
		callbacks.onAuth = () => {
			throw new Error("Host closed while mounting login");
		};
		await expect(openaiCodexOAuthProvider.login(callbacks)).rejects.toThrow("Host closed");
		expect(http.servers).toHaveLength(1);
		expect(http.servers[0]!.listening).toBe(false);
	});

	it("cancels a callback-only SDK login without requiring a manual-input rejection", async () => {
		const cancellation = new AbortController();
		const callbacks = host(cancellation.signal);
		let url = "";
		callbacks.onAuth = (info) => {
			url = info.url;
		};
		const login = observe(openaiCodexOAuthProvider.login(callbacks));
		try {
			await vi.waitFor(() => expect(url).not.toBe(""));
			cancellation.abort(new Error("Host cancelled sign-in"));
			await flush();
			expect(login.state.settled).toBe(true);
			expect(login.state.error).toBeDefined();
			expect(http.servers[0]!.listening).toBe(false);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			if (!login.state.settled) callback(url, { error: "access_denied" });
			await login.done;
		}
	});

	it("rejects a token result that arrives after browser-login cancellation", async () => {
		const cancellation = new AbortController();
		const callbacks = host(cancellation.signal);
		callbacks.onAuth = (info) => callback(info.url, { code: "synthetic-code" });
		let release!: (response: Response) => void;
		const transport = vi.fn(
			(_input: RequestInfo | URL, _init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		);
		vi.stubGlobal("fetch", transport);
		const login = observe(openaiCodexOAuthProvider.login(callbacks));
		await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
		cancellation.abort(new Error("Host cancelled token exchange"));
		release(tokenResponse());
		await login.done;
		expect(login.state.error).toBeDefined();
		expect(login.state.value).toBeUndefined();
		expect(transport.mock.calls[0]![1]?.signal?.aborted).toBe(true);
		expect(http.servers[0]!.listening).toBe(false);
	});

	it("bounds a stalled browser token exchange using the shared OAuth request deadline", async () => {
		const timeout = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		const callbacks = host(new AbortController().signal);
		callbacks.onAuth = (info) => callback(info.url, { code: "synthetic-code" });
		let release!: (response: Response) => void;
		const transport = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((resolve, reject) => {
					release = resolve;
					init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
				}),
		);
		vi.stubGlobal("fetch", transport);
		const login = observe(openaiCodexOAuthProvider.login(callbacks));
		try {
			await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
			timeout.abort(new DOMException("Synthetic OAuth request timed out", "TimeoutError"));
			await flush();
			expect(login.state.settled).toBe(true);
			expect(login.state.error).toBeDefined();
			expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
			expect(http.servers[0]!.listening).toBe(false);
		} finally {
			release(tokenResponse());
			await login.done;
		}
	});

	it("returns current credentials and closes the listener on successful browser login", async () => {
		const callbacks = host(new AbortController().signal);
		callbacks.onAuth = (info) => callback(info.url, { code: "synthetic-code" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => tokenResponse()),
		);
		await expect(openaiCodexOAuthProvider.login(callbacks)).resolves.toMatchObject({
			accountId: "synthetic-account",
			access: token,
			refresh: "synthetic-refresh",
		});
		expect(http.servers[0]!.listening).toBe(false);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each([true, false])("preserves manual code/state validation with matching state %s", async (matching) => {
		const callbacks = host(new AbortController().signal);
		let state = "";
		callbacks.onAuth = (info) => {
			state = new URL(info.url).searchParams.get("state")!;
		};
		callbacks.onManualCodeInput = async () => `synthetic-manual-code#${matching ? state : "wrong-state"}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => tokenResponse()),
		);
		const login = openaiCodexOAuthProvider.login(callbacks);
		if (matching) {
			await expect(login).resolves.toMatchObject({ accountId: "synthetic-account" });
			expect(fetch).toHaveBeenCalledOnce();
		} else {
			await expect(login).rejects.toThrow("State mismatch");
			expect(fetch).not.toHaveBeenCalled();
		}
		expect(http.servers[0]!.listening).toBe(false);
	});

	it.each(["owner", "deadline"] as const)("ends a stalled token body on %s cancellation", async (cause) => {
		const cancellation = new AbortController();
		const timeout = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		const callbacks = host(cancellation.signal);
		callbacks.onAuth = (info) => callback(info.url, { code: "synthetic-code" });
		let writer!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				writer = controller;
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				init?.signal?.addEventListener("abort", () => writer.error(init.signal!.reason), { once: true });
				return new Response(body);
			}),
		);
		const login = observe(openaiCodexOAuthProvider.login(callbacks));
		try {
			await vi.waitFor(() => expect(body.locked).toBe(true));
			if (cause === "owner") cancellation.abort(new Error("Host closed while reading token body"));
			else timeout.abort(new DOMException("Token body deadline expired", "TimeoutError"));
			await flush();
			expect(login.state.settled).toBe(true);
			expect(login.state.error).toBeDefined();
			expect(body.locked).toBe(false);
			expect(http.servers[0]!.listening).toBe(false);
		} finally {
			if (!login.state.settled) {
				writer.enqueue(new TextEncoder().encode(await tokenResponse().text()));
				writer.close();
			}
			await login.done;
		}
	});
});

describe("fresh Codex device polling lifetime", () => {
	it("rejects a late device token body after owner cancellation even if the transport delivers it", async () => {
		const cancellation = new AbortController();
		const callbacks = host(cancellation.signal);
		callbacks.onSelect = async () => "device_code";
		let writer!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				writer = controller;
			},
		});
		const transport = vi.fn((input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/usercode"))
				return Promise.resolve(
					Response.json({ device_auth_id: "synthetic-device", user_code: "A1-B2", interval: 0 }),
				);
			if (url.endsWith("deviceauth/token"))
				return Promise.resolve(
					Response.json({ authorization_code: "synthetic-code", code_verifier: "synthetic-verifier" }),
				);
			return Promise.resolve(new Response(body));
		});
		vi.stubGlobal("fetch", transport);
		const login = observe(openaiCodexOAuthProvider.login(callbacks));
		await vi.waitFor(() => expect(body.locked).toBe(true));
		cancellation.abort(new Error("Owner cancelled while the final token body was pending"));
		writer.enqueue(new TextEncoder().encode(await tokenResponse().text()));
		writer.close();
		await login.done;
		expect(login.state.error).toBeDefined();
		expect(login.state.value).toBeUndefined();
		expect(transport).toHaveBeenCalledTimes(3);
		expect(body.locked).toBe(false);
	});

	it.each(["owner", "deadline"] as const)(
		"ends a stalled poll on %s cancellation without another request",
		async (cause) => {
			const cancellation = new AbortController();
			const timeout = new AbortController();
			vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
			const callbacks = host(cancellation.signal);
			callbacks.onSelect = async () => "device_code";
			let release!: (response: Response) => void;
			const transport = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/usercode"))
					return Promise.resolve(
						Response.json({ device_auth_id: "synthetic-device", user_code: "A1-B2", interval: 0 }),
					);
				if (url.endsWith("deviceauth/token"))
					return new Promise<Response>((resolve, reject) => {
						release = resolve;
						init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
					});
				return Promise.resolve(tokenResponse());
			});
			vi.stubGlobal("fetch", transport);
			const login = observe(openaiCodexOAuthProvider.login(callbacks));
			try {
				await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
				if (cause === "owner") cancellation.abort(new Error("Owner cancelled the pending poll"));
				else timeout.abort(new DOMException("OAuth poll request expired", "TimeoutError"));
				await flush();
				expect(login.state.settled).toBe(true);
				expect(login.state.error).toBeDefined();
				expect(login.state.value).toBeUndefined();
				expect(transport).toHaveBeenCalledTimes(2);
				expect(http.servers).toHaveLength(0);
				if (cause === "deadline") expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
			} finally {
				release(Response.json({ authorization_code: "synthetic-code", code_verifier: "synthetic-verifier" }));
				await login.done;
			}
		},
	);
});
