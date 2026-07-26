import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getOAuthProviders,
	kimiCodingOAuthProvider,
	loginOpenRouter,
	openRouterOAuthProvider,
	refreshXaiToken,
	xaiOAuthProvider,
} from "../src/utils/oauth/index.ts";
import type { OAuthDeviceCodeInfo, OAuthLoginCallbacks } from "../src/utils/oauth/types.ts";

const nativeFetch = globalThis.fetch;
const originalKimiOAuthHost = process.env.KIMI_CODE_OAUTH_HOST;

function callbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
	return {
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => "",
		onSelect: async () => undefined,
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	if (originalKimiOAuthHost === undefined) delete process.env.KIMI_CODE_OAUTH_HOST;
	else process.env.KIMI_CODE_OAUTH_HOST = originalKimiOAuthHost;
});

describe("subscription OAuth providers", () => {
	it("registers xAI, Kimi Code, and OpenRouter as built-in providers", () => {
		const ids = getOAuthProviders().map((provider) => provider.id);
		expect(ids).toEqual(expect.arrayContaining(["xai", "kimi-coding", "openrouter"]));
	});

	it("completes the xAI device flow and preserves an unrotated refresh token", async () => {
		let deviceCode: OAuthDeviceCodeInfo | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/device/code")) {
				return Response.json({
					device_code: "device",
					user_code: "ABCD-EFGH",
					verification_uri: "https://auth.x.ai/activate",
					interval: 1,
					expires_in: 600,
				});
			}
			const body = new URLSearchParams(String(init?.body));
			if (body.get("grant_type") === "refresh_token") {
				return Response.json({ access_token: "access-2", expires_in: 3600 });
			}
			return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
		});

		const credentials = await xaiOAuthProvider.login(
			callbacks({
				onDeviceCode: (info) => {
					deviceCode = info;
				},
			}),
		);
		expect(deviceCode).toMatchObject({ userCode: "ABCD-EFGH", verificationUri: "https://auth.x.ai/activate" });
		expect(credentials).toMatchObject({ access: "access-1", refresh: "refresh-1" });
		expect(await refreshXaiToken("refresh-1")).toMatchObject({ access: "access-2", refresh: "refresh-1" });
	});

	it("completes the Kimi Code device flow", async () => {
		process.env.KIMI_CODE_OAUTH_HOST = "https://auth.kimi.test";
		let deviceCode: OAuthDeviceCodeInfo | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith("/device_authorization")) {
				return Response.json({
					device_code: "kimi-device",
					user_code: "KIMI-CODE",
					verification_uri: "https://auth.kimi.test/device",
					verification_uri_complete: "https://auth.kimi.test/device?code=KIMI-CODE",
					interval: 1,
					expires_in: 600,
				});
			}
			return Response.json({ access_token: "kimi-access", refresh_token: "kimi-refresh", expires_in: 3600 });
		});

		const credentials = await kimiCodingOAuthProvider.login(
			callbacks({
				onDeviceCode: (info) => {
					deviceCode = info;
				},
			}),
		);
		expect(deviceCode).toMatchObject({
			userCode: "KIMI-CODE",
			verificationUri: "https://auth.kimi.test/device?code=KIMI-CODE",
		});
		expect(credentials).toMatchObject({ access: "kimi-access", refresh: "kimi-refresh" });
		expect(kimiCodingOAuthProvider.getApiKey(credentials)).toBe("kimi-access");
	});

	it("exchanges an OpenRouter browser callback for a permanent API key", async () => {
		let callbackRequest: Promise<Response> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (url === "https://openrouter.ai/api/v1/auth/keys") {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				expect(body.code).toBe("authorization-code");
				expect(typeof body.code_verifier).toBe("string");
				return Response.json({ key: "sk-or-test" });
			}
			return nativeFetch(input, init);
		});

		const credentials = await loginOpenRouter(
			callbacks({
				onAuth: ({ url }) => {
					const callbackUrl = new URL(url).searchParams.get("callback_url");
					if (!callbackUrl) throw new Error("Missing OpenRouter callback URL");
					callbackRequest = nativeFetch(`${callbackUrl}?code=authorization-code`);
				},
			}),
		);
		await callbackRequest;
		expect(credentials).toEqual({ access: "sk-or-test", refresh: "", expires: Number.MAX_SAFE_INTEGER });
		expect(openRouterOAuthProvider.getApiKey(credentials)).toBe("sk-or-test");
	});
});
