/** Owns Command Code's browser POST handoff, legacy JSON callback, and completion landing page. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isRecord } from "../value-guards.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";

const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const LANDING_PATH = "/callback/complete";
const LANDING_GRACE_MS = 10_000;
const MAX_CALLBACK_BYTES = 10_000;
const SERVER_CLOSE_GRACE_MS = 1_000;
const CORS_ORIGINS = new Set(["http://localhost:3000", "https://staging.commandcode.ai", "https://commandcode.ai"]);
const FALLBACK_CORS_ORIGIN = "http://localhost:3000";

export interface CommandCodeHandoff {
	readonly apiKey: string;
	readonly state: string;
	readonly userId: string;
	readonly userName: string;
	readonly keyName: string;
}

export interface CommandCodeCallback {
	readonly port: number;
	readonly waitForHandoff: Promise<CommandCodeHandoff>;
	close(): Promise<void>;
}

export class CommandCodeAccessDeniedError extends Error {
	constructor(message = "Authorization was denied by the user") {
		super(message);
		this.name = "CommandCodeAccessDeniedError";
	}
}

function allowedCorsOrigin(origin: string | undefined): string {
	return origin && CORS_ORIGINS.has(origin) ? origin : FALLBACK_CORS_ORIGIN;
}

function sendHtml(response: ServerResponse, status: number, html: string, done?: () => void): void {
	response.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		Connection: "close",
	});
	response.end(html, done);
}

function sendJson(response: ServerResponse, status: number, body: { success: boolean; error?: string }): void {
	response.writeHead(status);
	response.end(JSON.stringify(body));
}

function errorPage(heading: string, message: string): string {
	return oauthErrorHtml(message, heading);
}

function denialError(error: unknown, description: unknown): Error {
	const described = description ? String(description) : undefined;
	return error === "access_denied"
		? new CommandCodeAccessDeniedError(described)
		: new Error(described ?? String(error ?? ""));
}

function isLegacyHandoff(value: unknown): value is CommandCodeHandoff {
	if (!isRecord(value)) return false;
	return (
		typeof value.apiKey === "string" &&
		value.apiKey.length > 0 &&
		typeof value.state === "string" &&
		typeof value.userId === "string" &&
		typeof value.userName === "string" &&
		typeof value.keyName === "string"
	);
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(forceClose);
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (error && code !== "ERR_SERVER_NOT_RUNNING") reject(error);
			else resolve();
		};
		const forceClose = setTimeout(() => {
			server.closeAllConnections?.();
			finish();
		}, SERVER_CLOSE_GRACE_MS);
		forceClose.unref();
		server.close((error) => {
			finish(error ?? undefined);
		});
		server.closeIdleConnections?.();
	});
}

/** Start the native 1.93.2 callback contract on an ephemeral strict-loopback port. */
export async function startCommandCodeCallback(
	expectedState: string,
	signal?: AbortSignal,
): Promise<CommandCodeCallback> {
	signal?.throwIfAborted();
	let resolveHandoff!: (handoff: CommandCodeHandoff) => void;
	let rejectHandoff!: (error: Error) => void;
	const waitForHandoff = new Promise<CommandCodeHandoff>((resolve, reject) => {
		resolveHandoff = resolve;
		rejectHandoff = reject;
	});
	let pending: CommandCodeHandoff | undefined;
	const graceTimers = new Set<ReturnType<typeof setTimeout>>();
	let closing = false;
	let closePromise: Promise<void> | undefined;

	let server!: Server;
	const shutdownAfterCallback = () => {
		if (closing) return;
		closing = true;
		pending = undefined;
		for (const timer of graceTimers) clearTimeout(timer);
		graceTimers.clear();
		server.closeIdleConnections?.();
		server.close();
	};

	const handleForm = (form: URLSearchParams, response: ServerResponse) => {
		if (closing) return;
		const error = form.get("error");
		if (error) {
			if (form.get("state") !== expectedState) {
				sendHtml(
					response,
					403,
					errorPage(
						"Invalid state token",
						"The state token did not match this login attempt. Return to your terminal and restart login.",
					),
				);
				return;
			}
			const description = form.get("error_description");
			const page =
				error === "access_denied"
					? oauthErrorHtml(
							"You denied the request. No API key was created for this terminal.",
							"Authorization Denied",
						)
					: errorPage("Authentication failed", description || error);
			sendHtml(response, 200, page, () => {
				if (closing) return;
				shutdownAfterCallback();
				rejectHandoff(denialError(error, description));
			});
			return;
		}

		const apiKey = form.get("apiKey");
		const state = form.get("state");
		const userId = form.get("userId");
		const userName = form.get("userName");
		const keyName = form.get("keyName");
		if (!apiKey || !state || !userId || !userName || !keyName) {
			sendHtml(
				response,
				400,
				errorPage(
					"Invalid request",
					"Required parameters are missing. Return to your terminal and restart login, or paste your API key there manually.",
				),
			);
			return;
		}
		if (state !== expectedState) {
			sendHtml(
				response,
				403,
				errorPage(
					"Invalid state token",
					"The state token did not match this login attempt. Return to your terminal and restart login.",
				),
			);
			return;
		}

		pending = { apiKey, state, userId, userName, keyName };
		const timer = setTimeout(() => {
			graceTimers.delete(timer);
			if (closing || !pending) return;
			const handoff = pending;
			shutdownAfterCallback();
			resolveHandoff(handoff);
		}, LANDING_GRACE_MS);
		timer.unref();
		graceTimers.add(timer);
		response.writeHead(303, {
			Location: `${LANDING_PATH}?state=${encodeURIComponent(state)}`,
			"Cache-Control": "no-store",
			"Content-Length": "0",
		});
		response.end();
	};

	const handleJson = (body: string, response: ServerResponse) => {
		if (closing) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(body) as unknown;
		} catch {
			sendJson(response, 400, { success: false, error: "Invalid JSON" });
			return;
		}
		if (isRecord(parsed) && Object.hasOwn(parsed, "error")) {
			if (parsed.state !== expectedState) {
				sendJson(response, 403, { success: false, error: "Invalid state token" });
				return;
			}
			sendJson(response, 200, { success: true });
			shutdownAfterCallback();
			rejectHandoff(denialError(parsed.error, parsed.error_description));
			return;
		}
		if (!isLegacyHandoff(parsed)) {
			sendJson(response, 400, { success: false, error: "Missing required fields" });
			return;
		}
		if (parsed.state !== expectedState) {
			sendJson(response, 403, { success: false, error: "Invalid state token" });
			return;
		}
		sendJson(response, 200, { success: true });
		shutdownAfterCallback();
		resolveHandoff(parsed);
	};

	const handleBody = (request: IncomingMessage, response: ServerResponse, contentType: string) => {
		const declaredLength = Number(request.headers["content-length"]);
		if (Number.isFinite(declaredLength) && declaredLength > MAX_CALLBACK_BYTES) {
			response.writeHead(413, { Connection: "close" });
			response.end(JSON.stringify({ success: false, error: "Payload too large" }));
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let oversized = false;
		request.on("data", (chunk: Buffer) => {
			if (oversized) return;
			size += chunk.length;
			if (size > MAX_CALLBACK_BYTES) {
				oversized = true;
				response.writeHead(413, { Connection: "close" });
				response.end(JSON.stringify({ success: false, error: "Payload too large" }));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (oversized) return;
			if (closing) {
				if (!response.headersSent)
					sendJson(response, 503, { success: false, error: "Sign-in is already finishing" });
				return;
			}
			const body = Buffer.concat(chunks).toString("utf8");
			if (contentType === "application/x-www-form-urlencoded") handleForm(new URLSearchParams(body), response);
			else handleJson(body, response);
		});
		request.on("error", () => {
			if (!closing && !oversized && !response.headersSent)
				sendJson(response, 500, { success: false, error: "Request error" });
		});
	};

	server = createServer((request, response) => {
		if (closing) {
			response.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
			response.end(JSON.stringify({ success: false, error: "Sign-in is already finishing" }));
			return;
		}
		let url: URL;
		try {
			url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
		} catch {
			response.writeHead(400, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ success: false, error: "Bad request" }));
			return;
		}
		response.setHeader("Access-Control-Allow-Origin", allowedCorsOrigin(request.headers.origin));
		response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		response.setHeader("Access-Control-Allow-Headers", "Content-Type");
		response.setHeader("Content-Type", "application/json");
		if (request.method === "OPTIONS") {
			if (request.headers["access-control-request-private-network"] === "true") {
				response.setHeader("Access-Control-Allow-Private-Network", "true");
			}
			response.writeHead(204);
			response.end();
			return;
		}
		if (request.method === "GET" && url.pathname === LANDING_PATH) {
			if (url.searchParams.get("state") !== expectedState) {
				sendHtml(
					response,
					403,
					errorPage(
						"Invalid state token",
						"The state token did not match this login attempt. Return to your terminal and restart login.",
					),
				);
				return;
			}
			if (!pending) {
				sendHtml(
					response,
					404,
					errorPage(
						"Return to your terminal",
						"This page completes login automatically during sign-in. Restart login from your terminal if you reached it directly.",
					),
				);
				return;
			}
			const handoff = pending;
			pending = undefined;
			sendHtml(
				response,
				200,
				oauthSuccessHtml(
					handoff.userName
						? `Signed in as ${handoff.userName}. Close this tab and return to your terminal.`
						: "Close this tab and return to your terminal.",
				),
				() => {
					if (closing) return;
					shutdownAfterCallback();
					resolveHandoff(handoff);
				},
			);
			return;
		}
		if (url.pathname !== CALLBACK_PATH) {
			sendJson(response, 404, { success: false, error: "Not found" });
			return;
		}
		if (request.method === "GET") {
			response.setHeader("Allow", "POST, OPTIONS");
			sendHtml(
				response,
				405,
				errorPage(
					"Return to your terminal",
					"This page completes login automatically during sign-in. Restart login from your terminal if you reached it directly.",
				),
			);
			return;
		}
		if (request.method !== "POST") {
			response.setHeader("Allow", "POST, OPTIONS");
			sendJson(response, 405, { success: false, error: "Method not allowed. Use POST." });
			return;
		}
		const contentType = (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
		if (contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded") {
			response.writeHead(415, { Connection: "close" });
			response.end(JSON.stringify({ success: false, error: "Unsupported content type" }));
			return;
		}
		handleBody(request, response, contentType);
	});

	const port = await new Promise<number>((resolve, reject) => {
		const onListenError = (error: Error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		};
		const onAbort = () => {
			signal?.removeEventListener("abort", onAbort);
			server.removeListener("error", onListenError);
			server.close(() => {});
			reject(signal?.reason ?? new Error("Login cancelled"));
		};
		server.once("error", onListenError);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			return;
		}
		server.listen(0, LOOPBACK_HOST, () => {
			signal?.removeEventListener("abort", onAbort);
			server.removeListener("error", onListenError);
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Auth callback server bound without an address"));
				return;
			}
			resolve(address.port);
		});
	});
	server.on("error", (error) => {
		if (!closing) rejectHandoff(error);
	});
	try {
		signal?.throwIfAborted();
	} catch (error) {
		await closeServer(server).catch(() => {});
		throw error;
	}

	return {
		port,
		waitForHandoff,
		close: () => {
			if (closePromise) return closePromise;
			closing = true;
			pending = undefined;
			for (const timer of graceTimers) clearTimeout(timer);
			graceTimers.clear();
			closePromise = closeServer(server);
			return closePromise;
		},
	};
}
