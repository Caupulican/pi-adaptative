/**
 * One bot session host per process and agent directory. Every root session of the process attaches to the same host, so
 * two roots in one process never run two sessions of one bot, nor refuse each other a bot as if another process ran it
 * (the lock record names the host that holds it, not only the process). What is the process's answers from any attached
 * root (the store, model rules, spend bound, System One, clock): the root attached last that is still attached. A message
 * carries the root it came from as its sender (`BotSender`): the directory a bot it loads works in, what a profile compiles
 * to and the settings storage a bot reads there, and where its turns' warnings and spend go; once that root detaches, the
 * root attached last answers. A bot's settings read their storage again after a change any attached root announces, a
 * root attached later included, so no root's detach leaves them stale. The last root to detach stops the host. A child session (a bot's own session, a worker) hosts
 * no bots: it gets a host of its own that no other session shares.
 */
import { resolve } from "node:path";
import { realPathIdentity } from "../autonomy/path-scope.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { SettingsManager } from "../settings-manager.ts";
import {
	type BotSender,
	type BotSessionDelivery,
	BotSessionHost,
	type BotSessionHostPorts,
} from "./bot-session-host.ts";

/** What one root session hands its process's host: the process's ports, read from it while it answers, and its own sender. */
export interface BotSessionRootPorts
	extends Omit<BotSessionHostPorts, "sender" | "senderIn">,
		Omit<BotSender, "settings"> {
	/** The root's settings manager: a bot's settings read the same storage and follow the changes it announces. */
	settingsManager(): SettingsManager;
}

/** A bot's settings manager, with its subscription to each attached root's changes. */
interface SettingsFollower {
	readonly settings: SettingsManager;
	readonly subscriptions: Map<BotSessionRootPorts, () => void>;
}

interface AttachedRoots {
	/** The attached roots' ports, in attach order; the last one answers for the process. */
	readonly roots: BotSessionRootPorts[];
	readonly followers: Set<SettingsFollower>;
}

interface SharedHost extends AttachedRoots {
	readonly host: BotSessionHost;
	/** The host's stop, once its last root detached: it stays registered until its sessions closed and their locks are free. */
	stopping?: Promise<void>;
}

const hosts = new Map<string, SharedHost>();

/** One root session's attachment to its process's bot session host. */
export interface BotSessionAttachment {
	readonly host: BotSessionHost;
	/** The host as this root's message dispatch reaches it: each delivery carries this root as its sender. */
	readonly delivery: BotSessionDelivery;
	/** Observes the bots' session changes while this root stays attached (see `BotSessionHost.subscribe`). */
	subscribe(listener: (change: readonly string[]) => void): () => void;
	/** Detaches the root; the last root's detach stops the host and resolves once its sessions closed. */
	detach(): Promise<void>;
}

function answering(shared: AttachedRoots): BotSessionRootPorts {
	const current = shared.roots.at(-1);
	if (!current) throw new Error("No root session is attached to the bot session host.");
	return current;
}

/** `root` as a message's sender while it stays attached, the root attached last afterwards. */
function senderOf(shared: AttachedRoots, root: BotSessionRootPorts): BotSender {
	const current = () => (shared.roots.includes(root) ? root : answering(shared));
	return {
		cwd: () => current().cwd(),
		compileProfile: (record) => current().compileProfile(record),
		settings: () => {
			const follower: SettingsFollower = {
				settings: current().settingsManager().sibling(),
				subscriptions: new Map(),
			};
			for (const attached of shared.roots) follow(follower, attached);
			shared.followers.add(follower);
			return {
				settings: follower.settings,
				release: () => {
					shared.followers.delete(follower);
					for (const unsubscribe of follower.subscriptions.values()) unsubscribe();
					follower.subscriptions.clear();
				},
			};
		},
		hostSessionId: () => current().hostSessionId(),
		warn: (message) => current().warn(message),
		reportUsage: (usage, report) => current().reportUsage(usage, report),
	};
}

/**
 * Reads the storage again after each change `root`'s manager announces. A change is announced before its write is
 * queued, so the write is awaited from the next microtask, then the settings are read from the storage it reached. A
 * write or a read that fails leaves the bots on the settings they had, and the owner is told.
 */
function follow(follower: SettingsFollower, root: BotSessionRootPorts): void {
	const main = root.settingsManager();
	const reread = () =>
		queueMicrotask(
			() =>
				void main
					.flush()
					.then(() => follower.settings.reload())
					.catch((error: unknown) =>
						root.warn(
							interfaceText().botTeam.botSettingsNotReread(
								error instanceof Error ? error.message : String(error),
							),
						),
					),
		);
	follower.subscriptions.set(root, main.subscribeChanges(reread));
}

/** The process's ports, answered by the root attached last; a host never outlives its last root, which answers its stop. */
function relayPorts(shared: AttachedRoots): BotSessionHostPorts {
	const root = () => answering(shared);
	return {
		agentDir: () => root().agentDir(),
		sender: () => senderOf(shared, root()),
		senderIn: (cwd) => {
			const place = realPathIdentity(cwd);
			const found = shared.roots.findLast((candidate) => realPathIdentity(candidate.cwd()) === place);
			return found && senderOf(shared, found);
		},
		store: () => root().store(),
		modelRegistry: () => root().modelRegistry(),
		systemOne: () => root().systemOne(),
		timers: () => root().timers(),
		warn: (message) => root().warn(message),
		modelRefusal: (record, model) => root().modelRefusal(record, model),
		turnSpendBound: () => root().turnSpendBound(),
	};
}

/**
 * Attaches a session to a bot session host: a root session to the one of its process and agent directory, built on the
 * first attach; a child session to one of its own.
 */
export function attachBotSessionHost(ports: BotSessionRootPorts, root: boolean): BotSessionAttachment {
	const key = resolve(ports.agentDir());
	let shared = root ? hosts.get(key) : undefined;
	if (!shared || shared.stopping) {
		const attachedRoots: AttachedRoots = { roots: [], followers: new Set() };
		// A root attached while the previous host stops gets a new one that builds no session before that stop ended: the
		// locks the stopping host still holds are free by then.
		const host = new BotSessionHost(
			relayPorts(attachedRoots),
			shared?.stopping?.catch(() => undefined),
		);
		shared = { ...attachedRoots, host };
		if (root) hosts.set(key, shared);
	}
	const attached = shared;
	const { host, roots, followers } = attached;
	roots.push(ports);
	for (const follower of followers) follow(follower, ports);
	const sender = senderOf(attached, ports);
	const listeners = new Set<() => void>();
	let detached = false;
	return {
		host,
		delivery: {
			deliver: (agentId, message, mode) => host.deliver(agentId, message, mode, sender),
			noteHistoryRun: (agentId, parentSessionId, runtime) => host.noteHistoryRun(agentId, parentSessionId, runtime),
			runsAsSession: (record) => host.runsAsSession(record, sender),
		},
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
			for (const follower of followers) {
				follower.subscriptions.get(ports)?.();
				follower.subscriptions.delete(ports);
			}
			if (roots.length > 1) {
				roots.splice(roots.indexOf(ports), 1);
				return;
			}
			// The last root answers the host's stop (its warnings, its cost view), then leaves; the host stays registered
			// until it stopped, so a root attached meanwhile waits for it.
			const stopping = host.stop();
			attached.stopping = stopping;
			try {
				await stopping;
			} finally {
				roots.length = 0;
				if (hosts.get(key) === attached) hosts.delete(key);
			}
		},
	};
}
