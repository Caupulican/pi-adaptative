import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { Duplex } from "node:stream";

type VirtualEndpoint =
	| { readonly kind: "unix"; readonly key: string; readonly path: string }
	| { readonly kind: "tcp"; readonly key: string; readonly host: string; readonly port: number };

export type VirtualListenOptions = {
	readonly path?: string;
	readonly port?: number;
	readonly host?: string;
};

export type VirtualConnectOptions = { readonly path: string } | { readonly port: number; readonly host?: string };

export interface VirtualNetworkOptions {
	/** Materializes and cleans up a virtual POSIX socket path when the world pairs `VirtualNetwork` with `VirtualFileSystem`. */
	readonly onUnixBind?: (path: string) => boolean;
	readonly onUnixUnbind?: (path: string) => void;
}

/**
 * An in-memory network of unix-socket and TCP `host:port` endpoints, for the journey phases that exercise the pi-chat
 * mesh and linked-machine hub/client transports. It reaches nothing outside the process: a server listens on a path or
 * `host:port` in this namespace, and a connection to an absent unix socket fails with `ENOENT` while an absent TCP
 * endpoint fails with `ECONNREFUSED`. Sockets are duplex streams joined in pairs, so production runs its real framing,
 * handshake and routing over them.
 */
class VirtualSocket extends Duplex {
	peer: VirtualSocket | undefined;

	constructor() {
		super({ allowHalfOpen: false });
	}

	setNoDelay(_noDelay?: boolean): this {
		return this;
	}

	setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
		return this;
	}

	unref(): this {
		return this;
	}

	ref(): this {
		return this;
	}

	override _read(): void {}

	override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		const peer = this.peer;
		if (peer && !peer.destroyed) peer.push(chunk);
		callback();
	}

	override _final(callback: (error?: Error | null) => void): void {
		this.peer?.push(null);
		callback();
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		const peer = this.peer;
		this.peer = undefined;
		callback(error);
		if (peer && !peer.destroyed) peer.destroy();
	}
}

class VirtualServer extends EventEmitter {
	listening = false;
	private readonly network: VirtualNetwork;
	private endpoint: VirtualEndpoint | undefined;
	private createdSocketFile = false;
	private readonly connections = new Set<VirtualSocket>();

	constructor(network: VirtualNetwork, onConnection?: (socket: VirtualSocket) => void) {
		super();
		this.network = network;
		if (onConnection) this.on("connection", onConnection);
	}

	listen(path: string, callback?: () => void): this;
	listen(port: number, host?: string | (() => void), callback?: () => void): this;
	listen(options: VirtualListenOptions, callback?: () => void): this;
	listen(target: string | number | VirtualListenOptions, second?: string | (() => void), third?: () => void): this {
		const onListening = typeof second === "function" ? second : third;
		if (onListening) this.once("listening", onListening);
		setImmediate(() => {
			let endpoint: VirtualEndpoint;
			let display: string;
			if (typeof target === "string" || (typeof target === "object" && typeof target.path === "string")) {
				const path = typeof target === "string" ? target : (target.path ?? "");
				endpoint = { kind: "unix", key: `unix:${path}`, path };
				display = path;
			} else {
				const requestedPort = typeof target === "number" ? target : (target.port ?? 0);
				const host =
					typeof second === "string"
						? second
						: typeof target === "object" && typeof target.host === "string"
							? target.host
							: "0.0.0.0";
				const port = requestedPort === 0 ? this.network.allocatePort(host) : requestedPort;
				endpoint = { kind: "tcp", key: `tcp:${host}:${port}`, host, port };
				display = `${host}:${port}`;
			}
			if (!this.network.bind(endpoint.key, this)) {
				if (onListening) this.off("listening", onListening);
				this.emit(
					"error",
					Object.assign(new Error(`listen EADDRINUSE: address already in use ${display}`), {
						code: "EADDRINUSE",
					}),
				);
				return;
			}
			this.endpoint = endpoint;
			this.createdSocketFile = endpoint.kind === "unix" && this.network.notifyUnixBind(endpoint.path);
			this.listening = true;
			this.emit("listening");
		});
		return this;
	}

	address(): AddressInfo | string | null {
		if (!this.listening || !this.endpoint) return null;
		if (this.endpoint.kind === "unix") return this.endpoint.path;
		return { address: this.endpoint.host, family: "IPv4", port: this.endpoint.port };
	}

	unref(): this {
		return this;
	}

	ref(): this {
		return this;
	}

	accept(socket: VirtualSocket): void {
		this.connections.add(socket);
		socket.once("close", () => this.connections.delete(socket));
		this.emit("connection", socket);
	}

	close(callback?: () => void): this {
		if (this.endpoint !== undefined) {
			const bound = this.endpoint;
			const createdSocketFile = this.createdSocketFile;
			this.createdSocketFile = false;
			this.network.unbind(bound.key, this);
			this.endpoint = undefined;
			if (bound.kind === "unix" && createdSocketFile) {
				this.network.notifyUnixUnbind(bound.path);
			}
		}
		this.listening = false;
		for (const socket of [...this.connections]) socket.destroy();
		setImmediate(() => {
			this.emit("close");
			callback?.();
		});
		return this;
	}
}

export class VirtualNetwork {
	private readonly servers = new Map<string, VirtualServer>();
	private readonly options: VirtualNetworkOptions;
	private liveSockets = 0;
	private nextPort = 40_000;

	constructor(options: VirtualNetworkOptions = {}) {
		this.options = options;
	}

	/** Sockets and listeners still open: a phase that ends with any has leaked one. */
	get open(): number {
		return this.servers.size + this.liveSockets;
	}

	notifyUnixBind(path: string): boolean {
		return this.options.onUnixBind?.(path) === true;
	}

	notifyUnixUnbind(path: string): void {
		this.options.onUnixUnbind?.(path);
	}

	allocatePort(host: string): number {
		while (this.servers.has(`tcp:${host}:${this.nextPort}`)) {
			this.nextPort += 1;
		}
		const port = this.nextPort;
		this.nextPort += 1;
		return port;
	}

	bind(key: string, server: VirtualServer): boolean {
		if (this.servers.has(key)) return false;
		this.servers.set(key, server);
		return true;
	}

	unbind(key: string, server: VirtualServer): void {
		if (this.servers.get(key) === server) this.servers.delete(key);
	}

	private resolveTcpServer(host: string, port: number): VirtualServer | undefined {
		const exact = this.servers.get(`tcp:${host}:${port}`);
		if (exact) return exact;
		if (host === "localhost") {
			return this.servers.get(`tcp:127.0.0.1:${port}`) ?? this.servers.get(`tcp:0.0.0.0:${port}`);
		}
		return this.servers.get(`tcp:0.0.0.0:${port}`);
	}

	readonly createServer = (onConnection?: (socket: VirtualSocket) => void): VirtualServer =>
		new VirtualServer(this, onConnection);

	readonly connect = (
		target: string | number | VirtualConnectOptions,
		second?: string | (() => void),
		third?: () => void,
	): VirtualSocket => {
		const onConnect = typeof second === "function" ? second : third;
		const client = new VirtualSocket();
		const served = new VirtualSocket();
		if (onConnect) client.once("connect", onConnect);
		client.peer = served;
		served.peer = client;
		this.liveSockets += 2;
		client.once("close", () => {
			this.liveSockets -= 1;
		});
		served.once("close", () => {
			this.liveSockets -= 1;
		});
		setImmediate(() => {
			if (typeof target === "string" || (typeof target === "object" && "path" in target)) {
				const path = typeof target === "string" ? target : target.path;
				const server = this.servers.get(`unix:${path}`);
				if (!server?.listening) {
					client.destroy(Object.assign(new Error(`connect ENOENT ${path}`), { code: "ENOENT" }));
					return;
				}
				server.accept(served);
				client.emit("connect");
				return;
			}
			const port = typeof target === "number" ? target : target.port;
			const host =
				typeof second === "string"
					? second
					: typeof target === "object" && typeof target.host === "string"
						? target.host
						: "127.0.0.1";
			const server = this.resolveTcpServer(host, port);
			if (!server?.listening) {
				client.destroy(Object.assign(new Error(`connect ECONNREFUSED ${host}:${port}`), { code: "ECONNREFUSED" }));
				return;
			}
			server.accept(served);
			client.emit("connect");
		});
		return client;
	};
}
