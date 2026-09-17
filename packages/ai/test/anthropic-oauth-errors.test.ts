import { afterEach, describe, expect, it, vi } from "vitest";
import { loginAnthropic, refreshAnthropicToken } from "../src/utils/oauth/anthropic.ts";

// These cases exercise token responses, not socket binding. Keep the fixed callback
// port available to the adjacent tests that verify actual HTTP callbacks.
vi.mock("node:http", () => ({
	createServer: () => ({
		on: vi.fn(),
		listen: (_port: number, _host: string, ready: () => void) => queueMicrotask(ready),
		close: vi.fn(),
	}),
}));

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Anthropic public token-error boundary", () => {
	it.each(["login", "refresh"])("keeps %s diagnostics independent of untrusted token response text", async (entry) => {
		for (const fault of ["http", "syntax", "parser", "transport", "cleanup"] as const) {
			const marker = `private-provider-payload-${entry}-${fault}`;
			const injected = new Error(marker);
			injected.cause = injected;
			const fetchMock = vi.fn(async () => {
				if (fault === "transport") throw injected;
				if (fault === "cleanup") {
					return new Response(
						new ReadableStream({
							cancel() {
								throw injected;
							},
						}),
						{ status: 403 },
					);
				}
				if (fault === "http")
					return Response.json({ error: "invalid_grant", error_description: marker }, { status: 400 });
				if (fault === "syntax") return new Response(`{"access_token":"${marker}",`, { status: 200 });
				const response = Response.json({ access_token: marker });
				vi.spyOn(response, "json").mockRejectedValue(injected);
				return response;
			});
			vi.stubGlobal("fetch", fetchMock);
			const operation =
				entry === "login"
					? loginAnthropic({
							onAuth: () => {},
							onPrompt: async () => "",
							onManualCodeInput: async () => "fixture-code",
						})
					: refreshAnthropicToken("fixture-refresh", { scopes: ["user:inference"] });
			const error: unknown = await operation.catch((failure: unknown) => failure);
			expect(error).toBeInstanceOf(Error);
			if (!(error instanceof Error)) throw new Error("Expected rejected token request");
			expect(error.message).not.toContain(marker);
			expect(error.stack).not.toContain(marker);
			expect(error.cause).toBeUndefined();
			expect(error).not.toBeInstanceOf(RangeError);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			if (fault === "http" || fault === "cleanup")
				expect(error.message).toContain(`HTTP ${fault === "http" ? 400 : 403}`);
			else expect(error.message).toContain(fault === "transport" ? "transport failed" : "invalid JSON");
		}
	});
});
