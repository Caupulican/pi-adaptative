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
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
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

/** The roster's machines from facts: read on demand, and watched only while someone subscribes. */
export class FleetMachines {
	private readonly agentDir: string;
	private readonly listeners = new Set<() => void>();
	private watcher: FSWatcher | undefined;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	list(): FleetMachine[] {
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
				this.watcher?.close();
				this.watcher = undefined;
			}
		};
	}

	/** In-process writers call this so a session sees its own change without waiting for the watch. */
	notify(): void {
		for (const listener of [...this.listeners]) listener();
	}

	private watch(): void {
		if (this.watcher) return;
		const dir = join(this.agentDir, "remote");
		try {
			mkdirSync(dir, { recursive: true });
			this.watcher = watch(dir, { persistent: false }, (_event, filename) => {
				if (filename === null || filename.toString() === FILE) this.notify();
			});
			this.watcher.on("error", () => {
				this.watcher?.close();
				this.watcher = undefined;
			});
		} catch (error) {
			harnessLog.warn(
				"link",
				"the fleet record cannot be watched; the roster refreshes on this session's own changes",
				{
					reason: error instanceof Error ? error.name : "unknown",
				},
			);
		}
	}
}
