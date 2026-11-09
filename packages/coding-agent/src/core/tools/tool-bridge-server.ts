import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
	MAX_TOOL_BRIDGE_CONNECTIONS,
	MAX_TOOL_BRIDGE_REQUEST_BYTES,
	TOOL_BRIDGE_HELLO_TIMEOUT_MS,
} from "./tool-bridge-policy.ts";

/**
 * The local channel of one bridged script run: newline-delimited JSON frames over a Unix socket in a private
 * directory (POSIX) or a randomly named pipe (Windows); no TCP port is opened. The run's secret is the authority, not
 * the address: a Windows pipe is reachable as its default ACL allows.
 *
 * A connection proves the run's secret in its first frame (`{"t":"hello","token":...}`, compared in constant time)
 * before any call is read; a wrong secret, any other first frame, an oversized or malformed frame, or no hello in
 * time closes it. Calls are `{"t":"call","id":<n>,"tool":<name>,"args":{...}}`; each is answered with
 * `{"t":"result","id":<n>,"ok":true,"text":...}` or `{"t":"result","id":<n>,"ok":false,"kind":...,"message":...}`.
 * The listener exists only while its run does: `close` stops it, ends every connection and removes the socket.
 */

export type ToolBridgeFailureKind = "refused" | "error" | "limit" | "cancelled";

export type ToolBridgeReply = { ok: true; text: string } | { ok: false; kind: ToolBridgeFailureKind; message: string };

export interface ToolBridgeRequest {
	readonly id: number;
	readonly tool: string;
	readonly args: Record<string, unknown>;
}

export interface ToolBridgeListener {
	readonly address: string;
	readonly token: string;
	/** Connections closed because they did not prove the run's secret. */
	readonly authFailures: number;
	close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrame(line: Buffer): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(line.toString("utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function tokenMatches(expected: Buffer, presented: unknown): boolean {
	if (typeof presented !== "string") return false;
	const candidate = Buffer.from(presented, "utf8");
	return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** POSIX socket in the run's private directory; on Windows a pipe name no other run can guess. */
function bridgeAddress(directory: string): string {
	return process.platform === "win32"
		? `\\\\.\\pipe\\pi-tool-bridge-${randomBytes(16).toString("hex")}`
		: join(directory, "bridge.sock");
}

/**
 * Starts the run's listener. `handle` answers one authenticated call; it must settle (the run's own bounds and
 * cancellation live there), and its reply is written back on the connection that asked.
 */
export async function openToolBridgeListener(input: {
	/** A directory only this run uses (created private by the caller). */
	readonly directory: string;
	readonly handle: (request: ToolBridgeRequest) => Promise<ToolBridgeReply>;
}): Promise<ToolBridgeListener> {
	const token = randomBytes(32).toString("hex");
	const expected = Buffer.from(token, "utf8");
	const address = bridgeAddress(input.directory);
	const sockets = new Set<Socket>();
	let authFailures = 0;
	let closed = false;

	const serve = (socket: Socket): void => {
		if (closed) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		let authenticated = false;
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		const helloTimer = setTimeout(() => {
			if (!authenticated) {
				authFailures++;
				socket.destroy();
			}
		}, TOOL_BRIDGE_HELLO_TIMEOUT_MS);
		helloTimer.unref?.();
		const send = (frame: Record<string, unknown>): void => {
			if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
		};
		const refuseConnection = (): void => {
			if (!authenticated) authFailures++;
			socket.destroy();
		};
		const onFrame = (frame: Record<string, unknown> | undefined): boolean => {
			if (!frame) return false;
			if (!authenticated) {
				if (frame.t !== "hello" || !tokenMatches(expected, frame.token)) return false;
				authenticated = true;
				clearTimeout(helloTimer);
				send({ t: "ready" });
				return true;
			}
			const id = frame.id;
			if (frame.t !== "call" || typeof id !== "number" || !Number.isSafeInteger(id)) return false;
			if (typeof frame.tool !== "string" || (frame.args !== undefined && !isRecord(frame.args))) return false;
			const request: ToolBridgeRequest = { id, tool: frame.tool, args: frame.args ?? {} };
			void input.handle(request).then(
				(reply) => send({ t: "result", id, ...reply }),
				(error: unknown) =>
					send({
						t: "result",
						id,
						ok: false,
						kind: "error",
						message: error instanceof Error ? error.message : String(error),
					}),
			);
			return true;
		};
		socket.on("data", (chunk: Buffer) => {
			let rest = chunk;
			while (rest.length > 0) {
				const newline = rest.indexOf(0x0a);
				if (newline < 0) {
					pending.push(rest);
					pendingBytes += rest.length;
					if (pendingBytes > MAX_TOOL_BRIDGE_REQUEST_BYTES) refuseConnection();
					return;
				}
				const line = Buffer.concat([...pending, rest.subarray(0, newline)]);
				pending = [];
				pendingBytes = 0;
				rest = rest.subarray(newline + 1);
				if (line.length > MAX_TOOL_BRIDGE_REQUEST_BYTES || !onFrame(parseFrame(line))) {
					refuseConnection();
					return;
				}
			}
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			clearTimeout(helloTimer);
			sockets.delete(socket);
		});
	};

	const server: Server = createServer(serve);
	server.maxConnections = MAX_TOOL_BRIDGE_CONNECTIONS;
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(address, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	// The directory is already private; the socket itself is the owner's alone as well. A socket that cannot be made
	// so is not served.
	if (process.platform !== "win32") {
		try {
			await chmod(address, 0o600);
		} catch (error) {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			throw error;
		}
	}

	return {
		address,
		token,
		get authFailures() {
			return authFailures;
		},
		close: () => {
			closed = true;
			for (const socket of sockets) socket.destroy();
			return new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}
