import { afterEach, describe, expect, it, vi } from "vitest";
import { loginGitHubCopilot, refreshGitHubCopilotToken } from "../src/utils/oauth/github-copilot.ts";

type Phase = "device" | "poll" | "credential" | "policy";

function phase(input: RequestInfo | URL): Phase {
	const path = new URL(String(input)).pathname;
	if (path.endsWith("/login/device/code")) return "device";
	if (path.endsWith("/login/oauth/access_token")) return "poll";
	if (path.endsWith("/copilot_internal/v2/token")) return "credential";
	if (path.startsWith("/models/") && path.endsWith("/policy")) return "policy";
	throw new Error("Unexpected upstream request in offline Copilot fixture");
}

function response(selected: Phase): Response {
	if (selected === "device")
		return Response.json({
			device_code: "synthetic-device",
			user_code: "A1-B2",
			verification_uri: "https://github.com/login/device",
			interval: 0,
			expires_in: 600,
		});
	if (selected === "poll") return Response.json({ access_token: "synthetic-github-token" });
	if (selected === "credential")
		return Response.json({
			token: "tid=synthetic;proxy-ep=proxy.individual.githubcopilot.com",
			expires_at: 9999999999,
		});
	return new Response(null, { status: 204 });
}

function observe<T>(promise: Promise<T>) {
	const state: { settled: boolean; error?: unknown; value?: T } = { settled: false };
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
	for (let index = 0; index < 30; index++) await Promise.resolve();
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("fresh Copilot device login cancellation", () => {
	it.each(["device", "poll", "credential", "policy"] as const)(
		"cancels a stalled %s request without starting another step",
		async (held) => {
			const cancellation = new AbortController();
			const releases: (() => void)[] = [];
			const calls: Phase[] = [];
			const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
				const selected = phase(input);
				calls.push(selected);
				if (selected !== held) return Promise.resolve(response(selected));
				return new Promise<Response>((resolve, reject) => {
					releases.push(() => resolve(response(selected)));
					init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
				});
			});
			vi.stubGlobal("fetch", fetch);
			const login = observe(
				loginGitHubCopilot({ signal: cancellation.signal, onPrompt: async () => "", onDeviceCode: () => {} }),
			);
			try {
				await vi.waitFor(() => expect(calls).toContain(held));
				const atCancellation = calls.length;
				cancellation.abort(new Error("Owner cancelled Copilot sign-in"));
				await flush();
				expect(login.state.settled).toBe(true);
				expect(login.state.error).toBeDefined();
				expect(login.state.value).toBeUndefined();
				expect(calls).toHaveLength(atCancellation);
			} finally {
				for (const release of releases) release();
				await login.done;
			}
		},
	);

	it.each(["device", "poll", "credential", "policy"] as const)(
		"bounds a stalled %s request at the fresh-login request deadline",
		async (held) => {
			const timeout = new AbortController();
			vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
			const releases: (() => void)[] = [];
			const calls: Phase[] = [];
			const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
				const selected = phase(input);
				calls.push(selected);
				if (selected !== held) return Promise.resolve(response(selected));
				return new Promise<Response>((resolve, reject) => {
					releases.push(() => resolve(response(selected)));
					init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
				});
			});
			vi.stubGlobal("fetch", fetch);
			const login = observe(loginGitHubCopilot({ onPrompt: async () => "", onDeviceCode: () => {} }));
			try {
				await vi.waitFor(() => expect(calls).toContain(held));
				timeout.abort(new DOMException("Synthetic OAuth request deadline", "TimeoutError"));
				await flush();
				expect(login.state.settled).toBe(true);
				if (held !== "policy") expect(login.state.error).toBeDefined();
				expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
			} finally {
				for (const release of releases) release();
				await login.done;
			}
		},
	);

	it("cancels an SDK domain prompt without another prompt or device request", async () => {
		const cancellation = new AbortController();
		let release!: (value: string) => void;
		const prompt = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = resolve;
				}),
		);
		const fetch = vi.fn(() => Promise.reject(new Error("Unexpected upstream request")));
		vi.stubGlobal("fetch", fetch);
		const login = observe(
			loginGitHubCopilot({ signal: cancellation.signal, onPrompt: prompt, onDeviceCode: () => {} }),
		);
		try {
			cancellation.abort(new Error("Owner cancelled the domain prompt"));
			await flush();
			expect(login.state.settled).toBe(true);
			expect(login.state.error).toBeDefined();
			expect(prompt).toHaveBeenCalledOnce();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			release("");
			await login.done;
		}
	});

	it("keeps the ordinary fresh-login grant and model-policy requests", async () => {
		const calls: { phase: Phase; init?: RequestInit }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const selected = phase(input);
				calls.push({ phase: selected, init });
				return response(selected);
			}),
		);
		const value = await loginGitHubCopilot({ onPrompt: async () => "", onDeviceCode: () => {} });
		expect(value).toMatchObject({
			refresh: "synthetic-github-token",
			access: "tid=synthetic;proxy-ep=proxy.individual.githubcopilot.com",
		});
		expect(calls.slice(0, 3).map((call) => call.phase)).toEqual(["device", "poll", "credential"]);
		expect(calls.filter((call) => call.phase === "policy").length).toBeGreaterThan(0);
		expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true);
	});

	it("preserves the public standalone token-refresh request when no cancellation signal was supplied", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response("credential"));
		vi.stubGlobal("fetch", fetch);
		await expect(refreshGitHubCopilotToken("synthetic-github-token")).resolves.toMatchObject({
			refresh: "synthetic-github-token",
		});
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]).toHaveLength(2);
		expect(fetch.mock.calls[0]![1]?.signal).toBeUndefined();
	});
});
