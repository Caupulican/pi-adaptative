/**
 * One bot session host per process and agent directory. Every root session of the process attaches to the same host, so
 * two roots in one process never run two sessions of one bot, nor refuse each other a bot as if another process ran it
 * (the lock record names the host that holds it, not only the process). What is the process's answers from any attached
 * root (the store, model rules, spend bound, System One, clock): the root attached last that is still attached. A message
 * carries the root it came from as its sender (`BotSender`): the directory a bot it loads works in, what a profile compiles
 * to and the settings storage a bot reads there, and where its turns' spend goes; once that root detaches, the
 * root attached last answers. A bot's settings read their storage again after a change any attached root announces and when
 * a root attaches, so a root that replaces the one the bot loaded from (a new or resumed session) is followed from its
 * attach, and no root's detach leaves them stale; a root working in the bot's directory also hands it its project trust.
 * How far the roots hold a bot's charges is read from every attached root, since each may hold one it took while it
 * answered. The last root to detach stops the host, then tells its own keeper of the bot daemon that every bot it hosted
 * was let go (`botsLetGo`), as the attached root is told when another host lets one go. A child session (a bot's own
 * session, a worker) hosts no bots: it gets a host of its own that no other session shares.
 */
import { resolve } from "node:path";
import { realPathIdentity } from "../autonomy/path-scope.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { type BotChargeHolder, botChargesHeld } from "./bot-charges-held.ts";
import { errorText } from "./bot-error-text.ts";
import { LinkedSessionNotices } from "./bot-link-notices.ts";
import { publishBotRootHost } from "./bot-root-hosts.ts";
import { type BotSessionDelivery, BotSessionHost } from "./bot-session-host.ts";
import type { BotHostProcessKeeps, BotSender, BotSessionHostPorts } from "./bot-session-host-ports.ts";
import { UnrecordedBotStops } from "./bot-stop.ts";

/** What one root session hands its process's host: the process's ports, read from it while it answers, and its own sender. */
export interface BotSessionRootPorts
	extends Omit<BotSessionHostPorts, "sender" | "senderIn" | "leavesTo">,
		Omit<BotSender, "settings" | "chargesHeld" | "compileProfile"> {
	/** A root session always compiles a profile (`BotSender.compileProfile`). */
	compileProfile: NonNullable<BotSender["compileProfile"]>;
	/** The root's settings manager: a bot's settings read the same storage and follow the changes it announces. */
	settingsManager(): SettingsManager;
	/** Where this root keeps the charges of a bot's spend: its session files and itself (`botChargesHeld`). */
	chargeHolder(): BotChargeHolder;
}

/** A bot's settings manager, with its subscription to each attached root's changes. */
interface SettingsFollower {
	readonly settings: SettingsManager;
	/** The directory whose project settings it reads (the path identity of the cwd of the root it was made from). */
	readonly place: string;
	readonly subscriptions: Map<BotSessionRootPorts, () => void>;
}

interface AttachedRoots {
	/** The attached roots' ports, in attach order; the last one answers for the process. */
	readonly roots: BotSessionRootPorts[];
	readonly followers: Set<SettingsFollower>;
}

interface SharedHost extends AttachedRoots {
	readonly host: BotSessionHost;
	/** What the host keeps (`keepsFor`): a root's, shared for the process and agent directory; a child's, its own. */
	readonly keeps: BotHostProcessKeeps;
	/** The host's stop, once its last root detached: it stays registered until its sessions closed and their locks are free. */
	stopping?: Promise<void>;
}

const hosts = new Map<string, SharedHost>();

/**
 * What each agent directory's hosts in this process keep across one another (`BotHostProcessKeeps`): the owner's stops the
 * process could not record, what the owner was told of the work a stop or release left behind a symbolic link, and why
 * each bot's session state was told as kept in the owner's home. A root's host and the one that replaces it (a new,
 * resumed or forked session detaches the old root before the new one attaches) hold the same, kept for the process, so a
 * replaced host neither loses a stop nor tells a notice again. A child session's host keeps its own while it runs and hands
 * the stops it still holds to these as it stops (`UnrecordedBotStops.adopt`).
 */
const processKeeps = new Map<string, BotHostProcessKeeps>();

/**
 * A runtime of agent directory `agentDir` quits, its root session detached: the owner's stops its hosts hold unrecorded
 * (its root's, kept for the process and agent directory, and those its child sessions' hosts handed over as they stopped)
 * are recorded one last time (`UnrecordedBotStops.recordAtQuit`), and none is held after it. While another root of the
 * process still holds that host they stay its own, for its runtime's quit. Another agent directory's are never touched.
 * What the owner is told of each, once. Never throws.
 */
export function recordHeldBotStopsAtQuit(agentDir: string): string[] {
	const key = resolve(agentDir);
	return hosts.has(key) ? [] : (processKeeps.get(key)?.unrecorded.recordAtQuit() ?? []);
}

/** What the hosts of agent directory `key` keep in this process: a root's are shared, a child host's are its own. */
function keepsFor(key: string, root: boolean): BotHostProcessKeeps {
	const kept = root ? processKeeps.get(key) : undefined;
	if (kept) return kept;
	const keeps = {
		unrecorded: new UnrecordedBotStops(key),
		links: new LinkedSessionNotices(),
		notMoved: new Set<string>(),
	};
	if (root) processKeeps.set(key, keeps);
	return keeps;
}

/** One root session's attachment to its process's bot session host. */
export interface BotSessionAttachment {
	readonly host: BotSessionHost;
	/** The host as this root's message dispatch reaches it: each delivery carries this root as its sender. */
	readonly delivery: BotSessionDelivery;
	/** Observes the bots' session changes while this root stays attached (see `BotSessionHost.subscribe`). */
	subscribe(listener: (change: readonly string[]) => void): () => void;
	/**
	 * Opens the bots owed work that no process takes (`BotSessionHost.openOwed`), recording this root as one hosting bots
	 * (`publishBotRootHost`): the daemon leaves the bots that work in its directory to it until it detaches.
	 */
	hostOwed(): void;
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
			const source = current();
			const follower: SettingsFollower = {
				settings: source.settingsManager().sibling(),
				place: realPathIdentity(source.cwd()),
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
		hostKeepsFile: () => current().hostKeepsFile(),
		warn: (message) => current().warn(message),
		reportUsage: (usage, report) => current().reportUsage(usage, report),
		chargesPersisted: (listener) => current().chargesPersisted(listener),
		// Every attached root may hold a charge it took while it answered: each is read, none attached answering nothing.
		chargesHeld: (sessionId, instance, since) => {
			answering(shared);
			return botChargesHeld(
				shared.roots.map((attached) => attached.chargeHolder()),
				sessionId,
				instance,
				since,
			);
		},
	};
}

/**
 * Reads the storage again after each change `root`'s manager announces; returns that reread. A change is announced
 * before its write is queued, so the write is awaited from the next microtask, then the settings are read from the
 * storage it reached. A root working in the follower's directory holds the owner's trust decision for its project
 * settings (`/trust` changes it without a write the storage shows), so the follower takes it first. A write or a read that
 * fails leaves the bots on the settings they had, and the owner is told.
 */
function follow(follower: SettingsFollower, root: BotSessionRootPorts): () => void {
	const main = root.settingsManager();
	const reread = () =>
		queueMicrotask(
			() =>
				void main
					.flush()
					.then(() => {
						if (realPathIdentity(root.cwd()) === follower.place)
							follower.settings.setProjectTrusted(main.isProjectTrusted());
						return follower.settings.reload();
					})
					.catch((error: unknown) =>
						root.warn(
							interfaceText().botTeam.botSettingsNotReread(
								error instanceof Error ? error.message : String(error),
							),
						),
					),
		);
	follower.subscriptions.set(root, main.subscribeChanges(reread));
	return reread;
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
		spendCeilings: () => root().spendCeilings(),
		usageRules: () => root().usageRules(),
		hostKind: () => root().hostKind(),
		botsLetGo: (detaching) => root().botsLetGo?.(detaching),
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
		// A child's host keeps its own; a root's those of its process and agent directory.
		const keeps = keepsFor(key, root);
		const host = new BotSessionHost(
			relayPorts(attachedRoots),
			keeps,
			shared?.stopping?.catch(() => undefined),
		);
		shared = { ...attachedRoots, host, keeps };
		if (root) hosts.set(key, shared);
	}
	const attached = shared;
	const { host, roots, followers } = attached;
	roots.push(ports);
	// What the attaching root's manager holds may be newer than what a loaded bot read: it is read now, not at the next change.
	for (const follower of followers) follow(follower, ports)();
	const sender = senderOf(attached, ports);
	const listeners = new Set<() => void>();
	let detached = false;
	let unpublish: (() => unknown) | undefined;
	// The root's record goes once the host it names let the bots go (the root left it, or it stopped): a failure is told.
	const unrecord = () => {
		const failed = unpublish?.();
		unpublish = undefined;
		if (failed !== undefined) ports.warn(interfaceText().botTeam.botRootHostNotRemoved(errorText(failed)));
	};
	return {
		host,
		hostOwed() {
			if (detached) return;
			try {
				unpublish ??= publishBotRootHost(ports.agentDir(), ports.cwd());
			} catch (error) {
				// Unrecorded, the daemon keeps the bots it hosts: this root's messages reach them through their inboxes.
				ports.warn(
					interfaceText().botTeam.botRootHostNotRecorded(error instanceof Error ? error.message : String(error)),
				);
			}
			host.openOwed();
		},
		delivery: {
			deliver: (agentId, message, options, origin) => host.deliver(agentId, message, options, origin, sender),
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
				unrecord();
				return;
			}
			// The last root answers the host's stop (its warnings, its cost view), then leaves; the host stays registered
			// until it stopped, so a root attached meanwhile waits for it.
			const stopping = host.stop();
			attached.stopping = stopping;
			try {
				await stopping;
			} finally {
				// Its record goes first: the bots its host let go are then counted for the daemon (`botsLetGo`), as no root
				// works where they do any more, while this root still answers the host's reads.
				unrecord();
				ports.botsLetGo?.(true);
				roots.length = 0;
				if (hosts.get(key) === attached) hosts.delete(key);
				// A child's host keeps its own: the stops it still holds go to its process and agent directory's, recorded
				// there again and at the quit of a runtime of that directory, not lost with the host.
				if (!root) keepsFor(key, true).unrecorded.adopt(attached.keeps.unrecorded);
			}
		},
	};
}

/**
 * A host with no root session, for the bot daemon: its own (no root attaches to it), with what it keeps of its own; the
 * owner's stops it still holds unrecorded when it stops are recorded one last time and what is told of them goes to
 * `ports.warn`.
 */
export function rootlessBotSessionHost(ports: BotSessionHostPorts): {
	readonly host: BotSessionHost;
	stop(): Promise<void>;
} {
	const keeps = keepsFor(resolve(ports.agentDir()), false);
	const host = new BotSessionHost(ports, keeps);
	return {
		host,
		stop: async () => {
			try {
				await host.stop();
			} finally {
				for (const told of keeps.unrecorded.recordAtQuit()) ports.warn(told);
			}
		},
	};
}
