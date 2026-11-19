/** Owns the Claude loopback listener and the browser response held until token exchange finishes. */
import type { ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";

interface AnthropicCallback {
	redirectUri: string;
	waitForCode(): Promise<string>;
	finish(success: boolean): void;
}

const CALLBACK_PATH = "/callback";
const FAILED = "Anthropic authentication did not complete.";
const HTML = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };

export async function startAnthropicCallback(expectedState: string): Promise<AnthropicCallback> {
	if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
		throw new Error("Anthropic OAuth is only available in Node.js environments");
	}
	const { createServer } = await import("node:http");
	let settle!: (value: string | Error) => void;
	const received = new Promise<string | Error>((resolve) => {
		settle = resolve;
	});
	let claimed = false;
	let closed = false;
	let pending: ServerResponse | undefined;
	const server = createServer((request, response) => {
		let url: URL;
		try {
			url = new URL(request.url ?? "", "http://localhost");
		} catch {
			response.writeHead(400).end();
			return;
		}
		if (url.pathname !== CALLBACK_PATH || request.method !== "GET") {
			response.writeHead(404).end();
			return;
		}
		const params = url.searchParams;
		if (params.getAll("state").length !== 1 || params.get("state") !== expectedState) {
			response.writeHead(400, HTML).end(oauthErrorHtml("State mismatch."));
			return;
		}
		if (claimed || closed) {
			response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Sign-in is already finishing.");
			return;
		}
		if (params.has("error") && !params.has("code") && params.getAll("error").length === 1) {
			claimed = true;
			response.writeHead(400, HTML).end(oauthErrorHtml(FAILED));
			settle(new Error(FAILED));
			return;
		}
		const code = params.get("code");
		if (!code || params.getAll("code").length !== 1 || params.has("error")) {
			response.writeHead(400, HTML).end(oauthErrorHtml("Invalid authorization callback."));
			return;
		}
		claimed = true;
		pending = response;
		settle(code);
	});

	return new Promise((resolve, reject) => {
		const fail = (error: Error) => {
			settle(error);
			reject(error);
		};
		server.on("error", fail);
		server.on("close", () => fail(new Error("Anthropic OAuth callback server closed")));
		server.listen(0, process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				fail(new Error("Anthropic OAuth callback server has no TCP port"));
				return;
			}
			resolve({
				redirectUri: `http://localhost:${address.port}${CALLBACK_PATH}`,
				waitForCode: async () => {
					const result = await received;
					if (result instanceof Error) throw result;
					return result;
				},
				finish: (success) => {
					if (closed) return;
					closed = true;
					if (pending && !pending.destroyed) {
						const page = success
							? oauthSuccessHtml("Anthropic authentication completed. You can close this window.")
							: oauthErrorHtml(FAILED);
						pending.writeHead(success ? 200 : 400, HTML).end(page);
					}
					pending = undefined;
					server.close();
				},
			});
		});
	});
}
