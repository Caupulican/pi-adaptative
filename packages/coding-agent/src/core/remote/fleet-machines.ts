/**
 * The machines this one links with, as facts (`remote/fleet.json`): each peer by install id, the owner's label for it,
 * whether a link to it is up now, since when it is down, and its newest capability advert. Whichever process holds a
 * link writes it (the hosting session for joiners, the channel host or a session for the hub joined); every session
 * reads it, so the roster, the fleet's room and placement agree on one record. A peer whose reporting process is gone
 * reads as offline from the time it was last seen: a crashed link holder never leaves a peer looking connected.
 */

import { existsSync, type FSWatcher, mkdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	isProcessOwnerRecord,
	judgeOwner,
	ownProcessOwner,
	type ProcessOwner,
} from "../../kernel/reliability/owner-identity.ts";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS } from "../../utils/fs-watch.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { type CapabilityFacts, parseCapabilityFacts } from "./capabilities.ts";
import { isMachineName } from "./protocol.ts";

export interface FleetMachine {
	readonly machineId: string;
	readonly name: string;
	/** What the peer is to this machine. */
	readonly role: "hub" | "joiner";
	readonly online: boolean;
	/** Epoch milliseconds on this machine's clock when the link to the peer went down. */
	readonly offlineSince?: number;
	readonly facts?: CapabilityFacts;
}

interface StoredMachine extends FleetMachine {
	readonly reporter: ProcessOwner;
	readonly seenAt: number;
}

const FILE = "fleet.json";
const fleetPath = (agentDir: string): string => join(agentDir, "remote", FILE);

function parseStored(machineId: string, value: unknown): StoredMachine | undefined {
	if (!isPlainRecord(value) || !isMachineName(value.name) || !isProcessOwnerRecord(value.reporter)) return undefined;
	if (value.role !== "hub" && value.role !== "joiner") return undefined;
	const facts = value.facts === undefined ? undefined : parseCapabilityFacts(value.facts);
	const offlineSince =
		typeof value.offlineSince === "number" && Number.isSafeInteger(value.offlineSince)
			? value.offlineSince
			: undefined;
	const seenAt = typeof value.seenAt === "number" && Number.isSafeInteger(value.seenAt) ? value.seenAt : 0;
	const online = value.online === true;
	return {
		machineId,
		name: value.name,
		role: value.role,
		online,
		...(offlineSince !== undefined ? { offlineSince } : !online ? { offlineSince: seenAt } : {}),
		...(facts ? { facts } : {}),
		reporter: value.reporter,
		seenAt,
	};
}

function readStored(agentDir: string): Map<string, StoredMachine> {
	const path = fleetPath(agentDir);
	const machines = new Map<string, StoredMachine>();
	if (!existsSync(path)) return machines;
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isPlainRecord(value) && isPlainRecord(value.machines))
			for (const [machineId, entry] of Object.entries(value.machines)) {
				const machine = parseStored(machineId, entry);
				if (machine) machines.set(machineId, machine);
			}
	} catch {
		// An unreadable record lists no machine; the next write replaces it.
	}
	return machines;
}

function changeStored(
	agentDir: string,
	machineId: string,
	change: (current: StoredMachine | undefined) => object | undefined,
): void {
	const path = fleetPath(agentDir);
	mkdirSync(join(agentDir, "remote"), { recursive: true });
	try {
		withFileLockSync(path, () => {
			const machines = readStored(agentDir);
			const next = change(machines.get(machineId));
			if (!next) return;
			const out: Record<string, unknown> = {};
			for (const [id, machine] of machines) out[id] = machine;
			out[machineId] = { ...next, reporter: ownProcessOwner(), seenAt: Date.now() };
			writeFileAtomicSync(path, `${JSON.stringify({ machines: out })}\n`, { mode: 0o600 });
		});
	} catch (error) {
		harnessLog.warn("link", "the fleet record could not be written", {
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
}

function publicPart({ reporter: _reporter, seenAt: _seenAt, ...machine }: StoredMachine): FleetMachine {
	return machine;
}

/** A link to the peer is up: it is online, under the label this side knows it by. */
export function recordPeerUp(
	agentDir: string,
	peer: { machineId: string; name: string; role: "hub" | "joiner" },
): void {
	changeStored(agentDir, peer.machineId, (current) => ({
		name: peer.name,
		role: peer.role,
		online: true,
		...(current?.facts ? { facts: current.facts } : {}),
	}));
}

export function recordPeerFacts(agentDir: string, machineId: string, facts: CapabilityFacts): void {
	changeStored(agentDir, machineId, (current) => (current ? { ...publicPart(current), facts } : undefined));
}

/** The link to the peer went down; jobs placed there wait for it within the offline hold. */
export function recordPeerDown(agentDir: string, machineId: string, now = Date.now()): void {
	changeStored(agentDir, machineId, (current) =>
		current?.online ? { ...publicPart(current), online: false, offlineSince: now } : undefined,
	);
}

/**
 * The roster's machines from facts: read on demand, and watched only while someone subscribes. A lost watch tells the
 * listeners to re-read and is re-armed on a bounded retry, and also on the next read or subscribe.
 */
export class FleetMachines {
	private readonly agentDir: string;
	private readonly timers: TimerPort;
	private readonly listeners = new Set<() => void>();
	private watcher: FSWatcher | undefined;
	/** The watch is lost or could not be armed; cleared when a watch arms again. Keeps one warning per streak of failures. */
	private watchDown = false;
	/** The pending bounded re-arm of a lost watch, while anyone listens. */
	private retry: unknown;

	constructor(agentDir: string, timers: TimerPort = SYSTEM_TIMER_PORT) {
		this.agentDir = agentDir;
		this.timers = timers;
	}

	list(): FleetMachine[] {
		// Armed before the read, so a change made between the two is seen by the watch rather than missed.
		this.watch();
		return [...readStored(this.agentDir).values()].map(({ reporter, seenAt, ...machine }) =>
			machine.online && judgeOwner(reporter) === "dead"
				? { ...machine, online: false, offlineSince: seenAt }
				: machine,
		);
	}

	get(machineId: string): FleetMachine | undefined {
		return this.list().find((machine) => machine.machineId === machineId);
	}

	byName(name: string): FleetMachine | undefined {
		return this.list().find((machine) => machine.name === name);
	}

	/** Calls `onChange` whenever the record changes, from any process; the returned function stops it. */
	subscribe(onChange: () => void): () => void {
		this.listeners.add(onChange);
		this.watch();
		return () => {
			this.listeners.delete(onChange);
			if (this.listeners.size === 0) {
				this.cancelRetry();
				closeWatcher(this.watcher);
				this.watcher = undefined;
				this.watchDown = false;
			}
		};
	}

	/** In-process writers call this so a session sees its own change without waiting for the watch. */
	notify(): void {
		for (const listener of [...this.listeners]) listener();
	}

	/** Arms the watch while someone listens; a no-op while it is armed or nobody does. */
	private watch(): void {
		if (this.watcher || this.listeners.size === 0) return;
		const dir = join(this.agentDir, "remote");
		try {
			mkdirSync(dir, { recursive: true });
			const watcher = watch(dir, { persistent: false }, (_event, filename) => {
				if (this.watcher === watcher && (filename === null || filename.toString() === FILE)) this.notify();
			});
			watcher.on("error", (error) => {
				// A late error from a watcher already replaced is not this watch's loss.
				if (this.watcher !== watcher) return;
				closeWatcher(watcher);
				this.watcher = undefined;
				this.unarmed(error);
				// A change may have landed while nothing watched: the listeners re-read now; the bounded retry re-arms the watch.
				this.notify();
			});
			this.watcher = watcher;
			this.cancelRetry();
			// A watch back after a loss: changes made while it was down reach the listeners as one re-read.
			if (this.watchDown) {
				this.watchDown = false;
				this.notify();
			}
		} catch (error) {
			this.unarmed(error);
		}
	}

	/**
	 * The watch is not armed: one warning per streak of failures, and a bounded retry re-arms it while anyone listens. A read
	 * or subscribe arms it sooner.
	 */
	private unarmed(error: unknown): void {
		if (!this.watchDown) {
			harnessLog.warn("link", "the fleet record cannot be watched; it is re-armed on a bounded retry", {
				reason: error instanceof Error ? error.name : "unknown",
			});
		}
		this.watchDown = true;
		this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.retry !== undefined) return;
		this.retry = this.timers.setTimeout(() => {
			this.retry = undefined;
			this.watch();
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private cancelRetry(): void {
		if (this.retry === undefined) return;
		this.timers.clearTimeout(this.retry);
		this.retry = undefined;
	}
}
