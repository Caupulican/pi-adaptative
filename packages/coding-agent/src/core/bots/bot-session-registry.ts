/**
 * One bot session host per process and agent directory. Every root session of the process attaches to the same host, so
 * two roots in one process never run two sessions of one bot, nor refuse each other a bot as if another process ran it
 * (the lock record names the host that holds it, not only the process). The host reads the ports of the root attached
 * last that is still attached (its settings, model rules, spend bound, cost view, clock and warnings); the last root to
 * detach stops it. A child session (a bot's own session, a worker) hosts no bots: it gets a host of its own that no
 * other session shares.
 */
import { resolve } from "node:path";
import { BotSessionHost, type BotSessionHostPorts } from "./bot-session-host.ts";

interface SharedHost {
	readonly host: BotSessionHost;
	/** The attached roots' ports, in attach order; the last one answers. */
	readonly roots: BotSessionHostPorts[];
}

const hosts = new Map<string, SharedHost>();

/** One root session's attachment to its process's bot session host. */
export interface BotSessionAttachment {
	readonly host: BotSessionHost;
	/** Observes the bots' session changes while this root stays attached (see `BotSessionHost.subscribe`). */
	subscribe(listener: (change: readonly string[]) => void): () => void;
	/** Detaches the root; the last root's detach stops the host and resolves once its sessions closed. */
	detach(): Promise<void>;
}

/** Ports that answer from the root attached last; a host never outlives its last root, which answers its stop. */
function relayPorts(roots: readonly BotSessionHostPorts[]): BotSessionHostPorts {
	const root = (): BotSessionHostPorts => {
		const current = roots.at(-1);
		if (!current) throw new Error("No root session is attached to the bot session host.");
		return current;
	};
	return {
		agentDir: () => root().agentDir(),
		cwd: () => root().cwd(),
		store: () => root().store(),
		modelRegistry: () => root().modelRegistry(),
		settings: () => root().settings(),
		systemOne: () => root().systemOne(),
		timers: () => root().timers(),
		hostSessionId: () => root().hostSessionId(),
		warn: (message) => root().warn(message),
		modelRefusal: (record, model) => root().modelRefusal(record, model),
		turnSpendBoundUsd: () => root().turnSpendBoundUsd(),
		reportUsage: (usage, report) => root().reportUsage(usage, report),
	};
}

/**
 * Attaches a session to a bot session host: a root session to the one of its process and agent directory, built on the
 * first attach; a child session to one of its own.
 */
export function attachBotSessionHost(ports: BotSessionHostPorts, root: boolean): BotSessionAttachment {
	const key = resolve(ports.agentDir());
	let shared = root ? hosts.get(key) : undefined;
	if (!shared) {
		const roots: BotSessionHostPorts[] = [];
		shared = { roots, host: new BotSessionHost(relayPorts(roots)) };
		if (root) hosts.set(key, shared);
	}
	const { host, roots } = shared;
	roots.push(ports);
	const listeners = new Set<() => void>();
	let detached = false;
	return {
		host,
		subscribe(listener) {
			const unsubscribe = host.subscribe(listener);
			listeners.add(unsubscribe);
			return () => {
				listeners.delete(unsubscribe);
				unsubscribe();
			};
		},
		async detach() {
			if (detached) return;
			detached = true;
			for (const unsubscribe of listeners) unsubscribe();
			listeners.clear();
			if (roots.length > 1) {
				roots.splice(roots.indexOf(ports), 1);
				return;
			}
			// The last root answers the host's stop (its warnings, its cost view), then leaves.
			if (hosts.get(key)?.host === host) hosts.delete(key);
			try {
				await host.stop();
			} finally {
				roots.length = 0;
			}
		},
	};
}
