/**
 * Command Code sign-in. It is a browser handoff, not a token grant: the sign-in page posts a Command Code API key to a
 * callback on this machine, and a state token made for this login ties that post to it. The key does not expire and
 * nothing is refreshed.
 *
 * The callback takes the page's form post (then sends the browser to a landing page of its own) and the older JSON
 * post, answers only the sign-in page across origins, and listens on the loopback address unless
 * `PI_OAUTH_CALLBACK_HOST` names another. There is no redirect URL to paste: where the browser cannot reach this
 * machine, the account's key is set as `COMMAND_CODE_API_KEY` instead.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const SIGN_IN_URL = "https://commandcode.ai/studio/auth/cli";
/** The page that posts the key: the only origin the callback answers across origins. */
const SIGN_IN_ORIGIN = "https://commandcode.ai";
const CALLBACK_PATH = "/callback";
const LANDING_PATH = "/callback/complete";
/** The sign-in page posts to a loopback port in this range, tried in order. */
const FIRST_PORT = 5959;
const PORT_TRIES = 10;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** How long a taken key waits for the browser to load the landing page before the login completes without it. */
const LANDING_GRACE_MS = 10_000;
const MAX_CALLBACK_BYTES = 10_000;

/** What the sign-in page posts: the key and whose it is. */
interface CommandCodeHandoff {
	readonly apiKey: string;
	readonly userId: string;
	readonly userName: string;
	readonly keyName: string;
}

function sameToken(given: string | null | undefined, expected: string): boolean {
	if (typeof given !== "string") return false;
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

function sendHtml(response: ServerResponse, status: number, html: string, done?: () => void): void {
	response.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		connection: "close",
	});
	response.end(html, done);
}

function sendJson(response: ServerResponse, status: number, body: { success: boolean; error?: string }): void {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
	response.end(JSON.stringify(body));
}

/** The body of a callback post, or undefined when it is past the size bound. */
function readBody(request: IncomingMessage): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size <= MAX_CALLBACK_BYTES) chunks.push(chunk);
		});
		request.on("end", () => resolve(size > MAX_CALLBACK_BYTES ? undefined : Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

/** The fields of a callback post, from a form or from JSON; undefined when the body is neither. */
function readFields(contentType: string, body: string): ((name: string) => string | null) | undefined {
	if (contentType === "application/x-www-form-urlencoded") {
		const form = new URLSearchParams(body);
		return (name) => form.get(name);
	}
	if (contentType !== "application/json") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	return (name) => (typeof record[name] === "string" ? (record[name] as string) : null);
}

/** Binds the first free loopback port of the range the sign-in page posts to. */
async function listen(server: Server, host: string): Promise<number> {
	for (let attempt = 0; attempt < PORT_TRIES; attempt++) {
		const port = FIRST_PORT + attempt;
		const bound = await new Promise<boolean>((resolve, reject) => {
			const onError = (error: NodeJS.ErrnoException) => {
				if (error.code === "EADDRINUSE") resolve(false);
				else reject(error);
			};
			server.once("error", onError);
			server.listen(port, host, () => {
				server.removeListener("error", onError);
				resolve(true);
			});
		});
		if (bound) return port;
	}
	throw new Error(
		`No free port for the Command Code sign-in callback (${FIRST_PORT} to ${FIRST_PORT + PORT_TRIES - 1})`,
	);
}

function toCredentials(handoff: CommandCodeHandoff): OAuthCredentials {
	return {
		access: handoff.apiKey,
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
		userId: handoff.userId,
		userName: handoff.userName,
		keyName: handoff.keyName,
	};
}

export async function loginCommandCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const signal = callbacks.signal;
	if (signal?.aborted) throw new Error("Login cancelled");
	const host = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
	const state = randomBytes(32).toString("base64url");
	let settle: (result: { handoff: CommandCodeHandoff } | { error: Error }) => void = () => {};
	const outcome = new Promise<CommandCodeHandoff>((resolve, reject) => {
		settle = (result) => ("handoff" in result ? resolve(result.handoff) : reject(result.error));
	});
	/** A key taken from the form post, held until the browser loads the landing page or the grace passes. */
	let taken: CommandCodeHandoff | undefined;
	let grace: ReturnType<typeof setTimeout> | undefined;

	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", `http://${host}`);
			if (request.headers.origin === SIGN_IN_ORIGIN) {
				response.setHeader("access-control-allow-origin", SIGN_IN_ORIGIN);
				response.setHeader("access-control-allow-methods", "POST, OPTIONS");
				response.setHeader("access-control-allow-headers", "Content-Type");
			}
			if (request.method === "OPTIONS") {
				if (request.headers["access-control-request-private-network"] === "true")
					response.setHeader("access-control-allow-private-network", "true");
				response.writeHead(204);
				response.end();
				return;
			}
			if (request.method === "GET" && url.pathname === LANDING_PATH) {
				if (!sameToken(url.searchParams.get("state"), state) || !taken) {
					sendHtml(
						response,
						404,
						oauthErrorHtml("This page completes a sign-in that is in progress. Start again."),
					);
					return;
				}
				const handoff = taken;
				taken = undefined;
				sendHtml(response, 200, oauthSuccessHtml("Signed in to Command Code. You may now close this page."), () =>
					settle({ handoff }),
				);
				return;
			}
			if (request.method !== "POST" || url.pathname !== CALLBACK_PATH) {
				sendJson(response, 404, { success: false, error: "Not found" });
				return;
			}
			const contentType = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
			const body = await readBody(request);
			const field = body === undefined ? undefined : readFields(contentType, body);
			if (!field) {
				sendJson(response, body === undefined ? 413 : 415, { success: false, error: "Unreadable callback" });
				return;
			}
			if (!sameToken(field("state"), state)) {
				sendJson(response, 403, { success: false, error: "Invalid state token" });
				return;
			}
			const denied = field("error");
			if (denied) {
				const why = field("error_description") ?? denied;
				sendHtml(response, 200, oauthErrorHtml("Command Code sign-in was not completed.", why), () =>
					settle({ error: new Error(`Command Code sign-in failed: ${why}`) }),
				);
				return;
			}
			const apiKey = field("apiKey");
			const userId = field("userId");
			const userName = field("userName");
			const keyName = field("keyName");
			if (!apiKey || !userId || !userName || !keyName) {
				sendJson(response, 400, { success: false, error: "Missing required fields" });
				return;
			}
			const handoff: CommandCodeHandoff = { apiKey, userId, userName, keyName };
			if (contentType === "application/json") {
				response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
				response.end(JSON.stringify({ success: true }), () => settle({ handoff }));
				return;
			}
			// The form post is the browser itself: it is sent on to the landing page, which completes the login.
			taken = handoff;
			grace = setTimeout(() => {
				if (taken === handoff) settle({ handoff });
			}, LANDING_GRACE_MS);
			grace.unref();
			response.writeHead(303, {
				location: `${LANDING_PATH}?state=${encodeURIComponent(state)}`,
				"cache-control": "no-store",
				"content-length": "0",
			});
			response.end();
		})().catch((error: unknown) => {
			if (!response.headersSent) sendJson(response, 500, { success: false, error: "Request error" });
			settle({ error: error instanceof Error ? error : new Error(String(error)) });
		});
	});

	const port = await listen(server, host);
	const timeout = setTimeout(() => settle({ error: new Error("Command Code sign-in timed out") }), LOGIN_TIMEOUT_MS);
	const onAbort = () => settle({ error: new Error("Login cancelled") });
	signal?.addEventListener("abort", onAbort, { once: true });
	server.on("error", (error) => settle({ error }));
	try {
		const url = new URL(SIGN_IN_URL);
		url.search = new URLSearchParams({
			callback: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
			state,
			mode: "redirect",
		}).toString();
		callbacks.onProgress?.(`Listening for the Command Code sign-in on 127.0.0.1:${port}`);
		callbacks.onAuth({ url: url.toString(), instructions: "Complete sign-in in your browser." });
		return toCredentials(await outcome);
	} finally {
		clearTimeout(timeout);
		if (grace) clearTimeout(grace);
		signal?.removeEventListener("abort", onAbort);
		server.closeIdleConnections?.();
		server.close();
	}
}

export const commandCodeOAuthProvider: OAuthProviderInterface = {
	id: "command-code",
	name: "Command Code",
	isSubscription: true,
	loginLabel: "Sign in with Command Code",
	login: loginCommandCode,
	// The key does not expire: there is nothing to refresh.
	refreshToken: async (credentials) => credentials,
	getApiKey: (credentials) => credentials.access,
};
