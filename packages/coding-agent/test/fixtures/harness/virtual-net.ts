import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";

/**
 * An in-memory network of unix-socket endpoints, for the one phase of a journey that exercises the pi-chat mesh.
 * It reaches nothing outside the process: a server listens on a path in this namespace and a connection to any
 * other path fails as an absent socket does (ENOENT). Sockets are duplex streams joined in pairs, so the production
 * mesh runs its real framing, handshake and routing over them.
 */
class VirtualSocket extends Duplex {
	peer: VirtualSocket | undefined;

	constructor() {
		super({ allowHalfOpen: false });
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
	private path: string | undefined;
	private readonly connections = new Set<VirtualSocket>();

	constructor(network: VirtualNetwork, onConnection?: (socket: VirtualSocket) => void) {
		super();
		this.network = network;
		if (onConnection) this.on("connection", onConnection);
	}

	listen(path: string): this {
		setImmediate(() => {
			if (!this.network.bind(path, this)) {
				this.emit(
					"error",
					Object.assign(new Error(`listen EADDRINUSE: address already in use ${path}`), { code: "EADDRINUSE" }),
				);
				return;
			}
			this.path = path;
			this.listening = true;
			this.emit("listening");
		});
		return this;
	}

	accept(socket: VirtualSocket): void {
		this.connections.add(socket);
		socket.once("close", () => this.connections.delete(socket));
		this.emit("connection", socket);
	}

	close(callback?: () => void): this {
		if (this.path !== undefined) this.network.unbind(this.path, this);
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
	private liveSockets = 0;

	/** Sockets and listeners still open: a phase that ends with any has leaked one. */
	get open(): number {
		return this.servers.size + this.liveSockets;
	}

	bind(path: string, server: VirtualServer): boolean {
		if (this.servers.has(path)) return false;
		this.servers.set(path, server);
		return true;
	}

	unbind(path: string, server: VirtualServer): void {
		if (this.servers.get(path) === server) this.servers.delete(path);
	}

	readonly createServer = (onConnection?: (socket: VirtualSocket) => void): VirtualServer =>
		new VirtualServer(this, onConnection);

	readonly connect = (path: string): VirtualSocket => {
		const client = new VirtualSocket();
		const served = new VirtualSocket();
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
			const server = this.servers.get(path);
			if (!server?.listening) {
				client.destroy(Object.assign(new Error(`connect ENOENT ${path}`), { code: "ENOENT" }));
				return;
			}
			server.accept(served);
			client.emit("connect");
		});
		return client;
	};
}
