import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthLoginCallbacks } from "../src/utils/oauth/types.ts";
import { loginXai, refreshXaiToken } from "../src/utils/oauth/xai.ts";

afterEach(() => {
	vi.restoreAllMocks();
});
function callbacks(signal: AbortSignal): OAuthLoginCallbacks {
	return { signal, onAuth: vi.fn(), onPrompt: async () => "", onSelect: async () => undefined, onDeviceCode: vi.fn() };
}

describe("xAI OAuth input and cancellation boundaries", () => {
	it.each([
		{ access_token: " ", expires_in: 3600 },
		{ access_token: "access", refresh_token: "\t", expires_in: 3600 },
		{ access_token: "access", expires_in: 1e308 },
		{ access_token: "access", expires_in: 1.5 },
	])("rejects malformed credentials before persistence: %j", async (body) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
		await expect(refreshXaiToken("refresh")).rejects.toThrow();
	});
	it("clamps the refresh skew for short tokens and refuses credential redirects", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ access_token: "access", expires_in: 60 }));
		// The shared margin retains half of a short token's lifetime; immediate expiry caused refresh churn.
		expect(await refreshXaiToken("refresh")).toEqual({ access: "access", refresh: "refresh", expires: 1_030_000 });
		expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
		expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
			"x-grok-client-surface": "cli",
			"x-grok-client-version": "1.0.40",
		});
	});
	it("does not request or display a device code after pre-abort", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
		const cb = callbacks(controller.signal);
		await expect(loginXai(cb)).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
		expect(cb.onDeviceCode).not.toHaveBeenCalled();
	});
	it("does not publish device input when the response races cancellation", async () => {
		const controller = new AbortController();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			controller.abort();
			return Response.json({
				device_code: "device",
				user_code: "CODE",
				verification_uri: "https://auth.x.ai/activate",
				expires_in: 600,
			});
		});
		const cb = callbacks(controller.signal);
		await expect(loginXai(cb)).rejects.toThrow();
		expect(cb.onDeviceCode).not.toHaveBeenCalled();
	});
});
