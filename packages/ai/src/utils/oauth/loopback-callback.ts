/** Owns the one-shot OAuth loopback listener shared by browser-based providers. */

import type { ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";

export interface OAuthLoopbackAuthorization {
	code: string;
	state: string;
}

export interface OAuthLoopbackCallback {
	redirectUri: string;
	waitForAuthorization(): Promise<OAuthLoopbackAuthorization>;
	finish(success: boolean): void;
}

interface AuthorizationDenied {
	pageMessage: string;
	pageDetail?: string;
	errorMessage: string;
}

export interface OAuthLoopbackOptions {
	expectedState: string;
	listenHost: string;
	redirectHost: string;
	callbackPath: string;
	environmentError: string;
	stateMismatchMessage: string;
	invalidCallbackMessage: string;
	completedMessage: string;
	incompleteMessage: string;
	serverClosedMessage: string;
	missingPortMessage: string;
	acceptEmptyAuthorizationError?: boolean;
	authorizationDenied(error: string, description?: string): AuthorizationDenied;
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };

export async function startOAuthLoopbackCallback(options: OAuthLoopbackOptions): Promise<OAuthLoopbackCallback> {
	if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
		throw new Error(options.environmentError);
	}
	const { createServer } = await import("node:http");
	let settle!: (value: OAuthLoopbackAuthorization | Error) => void;
	const received = new Promise<OAuthLoopbackAuthorization | Error>((resolve) => {
		settle = resolve;
	});
	let claimed = false;
	let closed = false;
	let pending: ServerResponse | undefined;
	const server = createServer((request, response) => {
		let url: URL;
		try {
			url = new URL(request.url ?? "", `http://${options.redirectHost}`);
		} catch {
			response.writeHead(400).end();
			return;
		}
		if (request.method !== "GET" || url.pathname !== options.callbackPath) {
			response.writeHead(404).end();
			return;
		}
		const params = url.searchParams;
		if (params.getAll("state").length !== 1 || params.get("state") !== options.expectedState) {
			response.writeHead(400, HTML_HEADERS).end(oauthErrorHtml(options.stateMismatchMessage));
			return;
		}
		if (claimed || closed) {
			response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Sign-in is already finishing.");
			return;
		}
		const oauthError = params.get("error");
		if (
			(oauthError || (options.acceptEmptyAuthorizationError && params.has("error"))) &&
			params.getAll("error").length === 1 &&
			!params.has("code")
		) {
			claimed = true;
			const denied = options.authorizationDenied(oauthError ?? "", params.get("error_description") ?? undefined);
			response.writeHead(400, HTML_HEADERS).end(oauthErrorHtml(denied.pageMessage, denied.pageDetail));
			settle(new Error(denied.errorMessage));
			return;
		}
		const code = params.get("code");
		const state = params.get("state");
		if (!code || !state || params.getAll("code").length !== 1 || params.has("error")) {
			response.writeHead(400, HTML_HEADERS).end(oauthErrorHtml(options.invalidCallbackMessage));
			return;
		}
		claimed = true;
		pending = response;
		settle({ code, state });
	});

	return new Promise((resolve, reject) => {
		const fail = (error: Error): void => {
			settle(error);
			reject(error);
		};
		server.on("error", fail);
		server.on("close", () => settle(new Error(options.serverClosedMessage)));
		server.listen(0, options.listenHost, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				fail(new Error(options.missingPortMessage));
				return;
			}
			resolve({
				redirectUri: `http://${options.redirectHost}:${address.port}${options.callbackPath}`,
				waitForAuthorization: async () => {
					const result = await received;
					if (result instanceof Error) throw result;
					return result;
				},
				finish: (success) => {
					if (closed) return;
					closed = true;
					if (pending && !pending.destroyed) {
						const page = success
							? oauthSuccessHtml(options.completedMessage)
							: oauthErrorHtml(options.incompleteMessage);
						pending.writeHead(success ? 200 : 400, HTML_HEADERS).end(page);
					}
					pending = undefined;
					server.close();
				},
			});
		});
	});
}
