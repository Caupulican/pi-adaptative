import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginOpenAICodex } from "../src/utils/oauth/openai-codex.ts";

function accessToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({
			exp: Math.floor(Date.now() / 1000) + 3600,
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
		"utf8",
	).toString("base64url");
	return `header.${payload}.signature`;
}

function callback(query: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: 1455, path: `/auth/callback?${query}`, method: "GET" }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		req.on("error", reject);
		req.end();
	});
}

async function startLogin() {
	await new Promise((resolve) => setTimeout(resolve, 20));
	let authUrl = "";
	const exchange = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					access_token: accessToken("acct-browser"),
					refresh_token: "refresh",
					id_token: `header.${Buffer.from("{}").toString("base64url")}.signature`,
					expires_in: 3600,
				}),
			),
	);
	vi.stubGlobal("fetch", exchange);
	const login = loginOpenAICodex({
		onAuth: (info) => {
			authUrl = info.url;
		},
		onPrompt: async () => {
			throw new Error("no manual input in this test");
		},
	});
	login.catch(() => {});
	await vi.waitFor(() => expect(authUrl).not.toBe(""));
	const url = new URL(authUrl);
	return { login, exchange, state: url.searchParams.get("state") ?? "", url };
}

describe("OpenAI Codex browser callback", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("accepts the life-sciences state suffix only on the exact expected state", async () => {
		const { login, exchange, state } = await startLogin();
		expect(await callback(`state=other.onboarding_entrypoint%3Dlife_sciences&code=bad`)).toBe(400);
		expect(exchange).not.toHaveBeenCalled();
		expect(await callback(`state=${state}.onboarding_entrypoint%3Dlife_sciences&code=good`)).toBe(200);
		await expect(login).resolves.toMatchObject({ accountId: "acct-browser" });
		const init = (exchange.mock.calls[0] as unknown as [unknown, RequestInit] | undefined)?.[1];
		const body = String(init?.body);
		expect(body).toContain("code=good");
	});

	it("ends the login on a provider error for the expected state, and ignores one for another state", async () => {
		const { login, exchange, state } = await startLogin();
		expect(await callback("state=forged&error=access_denied")).toBe(400);
		expect(
			await callback(
				`state=${state}&error=access_denied&error_description=${encodeURIComponent("User denied\u001b[31m")}`,
			),
		).toBe(400);
		await expect(login).rejects.toThrow("OpenAI sign-in failed: access_denied (User denied [31m)");
		expect(exchange).not.toHaveBeenCalled();
	});

	it("requests the Codex CLI's authorization parameters, connector scopes included", async () => {
		const { login, state, url } = await startLogin();
		expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
		expect(url.searchParams.get("scope")).toBe(
			"openid profile email offline_access api.connectors.read api.connectors.invoke",
		);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
		expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
		await callback(`state=${state}&code=done`);
		await login;
	});
});
