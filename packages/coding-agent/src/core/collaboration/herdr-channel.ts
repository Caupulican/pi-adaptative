import { connect, type Socket } from "node:net";
import { CollaborationBackendError } from "./backend.ts";

export interface HerdrEventChannel {
	request(method: string, params: Record<string, unknown>): Promise<unknown>;
	onEvent(listener: (event: unknown) => void): () => void;
	close(): void;
}

/** Herdr owns one request per socket. Only events.subscribe keeps its dedicated socket open. */
export async function connectHerdrChannel(path: string, signal: AbortSignal): Promise<HerdrEventChannel> {
	if (signal.aborted) throw new CollaborationBackendError("aborted", "Herdr connection cancelled.", "not-submitted");
	const listeners = new Set<(event: unknown) => void>();
	const connections = new Map<Socket, (error: Error) => void>();
	let sequence = 0;
	let closed = false;
	let subscribed = false;
	const fail = () => {
		if (closed) return;
		closed = true;
		signal.removeEventListener("abort", fail);
		const error = new CollaborationBackendError(
			"connection_closed",
			"Herdr event connection ended; no input is replayed.",
		);
		for (const [socket, reject] of connections) {
			reject(error);
			socket.destroy();
		}
		connections.clear();
		for (const listener of listeners) listener({ error: { code: "connection_closed" } });
		listeners.clear();
	};
	signal.addEventListener("abort", fail, { once: true });
	// Validate reachability before admitting a handle. No request or input is submitted here.
	const probe = connect(path);
	try {
		await new Promise<void>((resolve, reject) => {
			connections.set(probe, reject);
			probe.once("connect", resolve);
			probe.once("error", reject);
		});
	} catch {
		fail();
		throw new CollaborationBackendError(
			"connection_closed",
			"Herdr connection failed before submission.",
			"not-submitted",
		);
	} finally {
		connections.delete(probe);
		probe.destroy();
	}
	return {
		request(method, params) {
			if (closed || connections.size >= 32)
				return Promise.reject(
					new CollaborationBackendError("connection_closed", "Herdr event channel is unavailable."),
				);
			const streaming = method === "events.subscribe";
			if (streaming && subscribed)
				return Promise.reject(
					new CollaborationBackendError(
						"duplicate_subscription",
						"Herdr event subscription is already owned.",
						"not-submitted",
					),
				);
			let encoded: string;
			const id = `pi-${++sequence}`;
			try {
				encoded = `${JSON.stringify({ id, method, params })}\n`;
			} catch {
				return Promise.reject(
					new CollaborationBackendError("invalid_request", "Invalid Herdr request payload.", "not-submitted"),
				);
			}
			if (Buffer.byteLength(encoded) > 1024 * 1024)
				return Promise.reject(
					new CollaborationBackendError(
						"invalid_request",
						"Herdr request exceeds its wire bound.",
						"not-submitted",
					),
				);
			if (streaming) subscribed = true;
			return new Promise((resolve, reject) => {
				const socket = connect(path);
				connections.set(socket, reject);
				let acknowledged = false;
				let completed = false;
				let buffer = "";
				const finish = () => {
					completed = true;
					connections.delete(socket);
					socket.destroy();
				};
				socket.setEncoding("utf8");
				socket.once("connect", () => {
					if (closed) return finish();
					socket.write(encoded);
				});
				socket.on("error", () => {
					if (!completed) fail();
				});
				socket.on("close", () => {
					if (!completed) fail();
				});
				socket.on("data", (chunk: string) => {
					buffer += chunk;
					if (Buffer.byteLength(buffer) > 1024 * 1024) return fail();
					let newline = buffer.indexOf("\n");
					while (newline >= 0) {
						const line = buffer.slice(0, newline);
						buffer = buffer.slice(newline + 1);
						let value: unknown;
						try {
							value = JSON.parse(line);
						} catch {
							return fail();
						}
						if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
						const envelope = value as Record<string, unknown>;
						if (!acknowledged) {
							if (envelope.id !== id) return fail();
							if (envelope.error) {
								reject(
									new CollaborationBackendError("backend_error", "Herdr rejected the event-channel request."),
								);
								finish();
								return;
							}
							acknowledged = true;
							resolve(envelope.result);
							if (!streaming) {
								finish();
								return;
							}
						} else if (streaming && envelope.event) {
							for (const listener of listeners) listener(value);
						} else return fail();
						newline = buffer.indexOf("\n");
					}
				});
			});
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close: fail,
	};
}
