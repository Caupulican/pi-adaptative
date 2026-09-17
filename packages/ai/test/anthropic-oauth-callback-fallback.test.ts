import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginAnthropic } from "../src/utils/oauth/anthropic.ts";

const binding = vi.hoisted(() => ({ code: "EADDRINUSE" }));
vi.mock("node:http", () => ({
	createServer: () => {
		let onError: ((error: Error) => void) | undefined;
		return {
			on: (_event: string, listener: (error: Error) => void) => {
				onError = listener;
			},
			listen: () => queueMicrotask(() => onError?.(Object.assign(new Error("bind failed"), { code: binding.code }))),
			close: vi.fn(),
		};
	},
}));

const manualRedirect = "https://platform.claude.com/oauth/code/callback";

beforeEach(() => {
	binding.code = "EADDRINUSE";
});
afterEach(() => vi.unstubAllGlobals());

describe("Claude OAuth when the callback listener cannot bind", () => {
	it.each(["EADDRINUSE", "EACCES"])("uses the native hosted manual redirect after %s", async (code) => {
		binding.code = code;
		let authorization: URL;
		const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			expect(body.redirect_uri).toBe(manualRedirect);
			expect(body.state).toBe(authorization.searchParams.get("state"));
			expect(body.code).toBe("manual-code");
			expect(body.code_verifier).not.toBe(body.state);
			const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier));
			expect(Buffer.from(digest).toString("base64url")).toBe(authorization.searchParams.get("code_challenge"));
			return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const prompt = vi.fn(async () => "unused");
		await expect(
			loginAnthropic({
				onAuth: ({ url }) => {
					authorization = new URL(url);
					expect(authorization.searchParams.get("redirect_uri")).toBe(manualRedirect);
				},
				onPrompt: prompt,
				onManualCodeInput: async () => `manual-code#${authorization.searchParams.get("state")}`,
			}),
		).resolves.toMatchObject({ access: "access", refresh: "refresh" });
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(prompt).not.toHaveBeenCalled();
	});

	it("uses the ordinary prompt when there is no parallel manual-input callback", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const prompt = vi.fn(async () => "manual-code");
		await expect(loginAnthropic({ onAuth: () => {}, onPrompt: prompt })).resolves.toMatchObject({ access: "access" });
		expect(prompt).toHaveBeenCalledExactlyOnceWith({
			message: "Paste the authorization code or full redirect URL:",
			placeholder: manualRedirect,
		});
	});

	it("rejects stale manual state before any token exchange", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			loginAnthropic({ onAuth: () => {}, onPrompt: async () => "manual-code#stale-state" }),
		).rejects.toThrow("OAuth state mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("cancels hosted manual input and ignores a late code", async () => {
		const controller = new AbortController();
		const input = Promise.withResolvers<string>();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const result = loginAnthropic({
			onAuth: () => {},
			onPrompt: () => {
				controller.abort(new Error("cancelled manual login"));
				return input.promise;
			},
			signal: controller.signal,
		});
		await expect(result).rejects.toThrow("cancelled manual login");
		input.resolve("late-code");
		await Promise.resolve();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not hide unexpected listener errors behind manual fallback", async () => {
		binding.code = "EIO";
		const onAuth = vi.fn();
		const onPrompt = vi.fn();
		await expect(loginAnthropic({ onAuth, onPrompt })).rejects.toThrow("bind failed");
		expect(onAuth).not.toHaveBeenCalled();
		expect(onPrompt).not.toHaveBeenCalled();
	});
});
