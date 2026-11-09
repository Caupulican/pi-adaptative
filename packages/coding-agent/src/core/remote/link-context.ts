/**
 * What a machine that is both a hub and a joiner tells the hub above it, so that hub can refuse a loop of hubs: the ids of
 * the machines joined here and how deep that chain goes. The hub controller of an agent directory provides it; the link
 * provider of the same directory reads it.
 *
 * It also keeps where each link stands in `remote/links.json`, for the owner's status and for tools reading the
 * records: `joins` holds each hub this machine joined (by address, the proven hub id beside it), `machines` each
 * machine joined to this hub (by its install id, the name as a label). The session hosting the hub and the one serving
 * the link channel can be different processes, so each writes only its own entries, merged under the file's lock.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

interface LinkContext {
	readonly subtree: () => readonly string[];
	readonly depth: () => number;
}

/** Where one joined hub's link stands. */
export interface JoinLinkState {
	/** "connected", or why not, in the owner's words. */
	readonly state: string;
	readonly hubName?: string;
	/** The hub's install id, once its welcome proved the secret. */
	readonly hubId?: string;
	/** The features active on the connected link (`sealed/1` when sealed); empty for an unsealed link. */
	readonly features?: readonly string[];
}

/** A machine joined to this hub, as the hosting session last saw it. */
export interface HubMachineLinkState {
	readonly name: string;
	readonly connected: boolean;
	readonly features: readonly string[];
	/** The ids joined below it and how deep its chain goes, for a session that reports this hub upward. */
	readonly subtree: readonly string[];
	readonly depth: number;
}

interface LinksFile {
	joins: Record<string, JoinLinkState>;
	machines: Record<string, HubMachineLinkState>;
}

const contexts = new Map<string, LinkContext>();
/** Per agent directory, each joined hub's address and where its link stands. */
const joinStates = new Map<string, Map<string, JoinLinkState>>();

const linksPath = (agentDir: string): string => join(agentDir, "remote", "links.json");

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

function readJoinState(value: unknown): JoinLinkState | undefined {
	// The first layout kept the owner's words alone under each address.
	if (typeof value === "string") return { state: value };
	if (!isPlainRecord(value) || typeof value.state !== "string") return undefined;
	const features = strings(value.features);
	return {
		state: value.state,
		...(typeof value.hubName === "string" ? { hubName: value.hubName } : {}),
		...(typeof value.hubId === "string" ? { hubId: value.hubId } : {}),
		...(features ? { features } : {}),
	};
}

function readMachineState(value: unknown): HubMachineLinkState | undefined {
	if (!isPlainRecord(value) || typeof value.name !== "string" || typeof value.connected !== "boolean")
		return undefined;
	return {
		name: value.name,
		connected: value.connected,
		features: strings(value.features) ?? [],
		subtree: strings(value.subtree) ?? [],
		depth: typeof value.depth === "number" && Number.isInteger(value.depth) && value.depth >= 0 ? value.depth : 0,
	};
}

/** The links file; a file in the first layout (address to text at the top level) reads as joins. */
function readLinks(agentDir: string): LinksFile {
	const links: LinksFile = { joins: {}, machines: {} };
	const path = linksPath(agentDir);
	if (!existsSync(path)) return links;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return links;
	}
	if (!isPlainRecord(value)) return links;
	const sectioned = isPlainRecord(value.joins) || isPlainRecord(value.machines);
	const joins = sectioned ? value.joins : value;
	if (isPlainRecord(joins))
		for (const [address, entry] of Object.entries(joins)) {
			const state = readJoinState(entry);
			if (state) links.joins[address] = state;
		}
	if (sectioned && isPlainRecord(value.machines))
		for (const [machineId, entry] of Object.entries(value.machines)) {
			const state = readMachineState(entry);
			if (state) links.machines[machineId] = state;
		}
	return links;
}

function updateLinks(agentDir: string, change: (links: LinksFile) => void): void {
	const path = linksPath(agentDir);
	// Written beside the other link records, so a tool reading them sees where each link stands; the state is still
	// served from memory when the file cannot be written.
	try {
		mkdirSync(join(agentDir, "remote"), { recursive: true });
		withFileLockSync(path, () => {
			const links = readLinks(agentDir);
			change(links);
			writeFileAtomicSync(path, `${JSON.stringify(links, null, 1)}\n`);
		});
	} catch {
		// Memory keeps serving the state.
	}
}

export function reportJoinState(agentDir: string, address: string, state: JoinLinkState): void {
	const states = joinStates.get(agentDir) ?? new Map<string, JoinLinkState>();
	joinStates.set(agentDir, states);
	states.set(address, state);
	updateLinks(agentDir, (links) => {
		links.joins[address] = state;
	});
}

/** Where a joined hub's link stands: this process's own view, else what the process serving the link wrote. */
export function joinStateFor(agentDir: string, address: string): JoinLinkState {
	return joinStates.get(agentDir)?.get(address) ?? readLinks(agentDir).joins[address] ?? { state: "not started" };
}

/** The hosting session's whole view of the machines joined to it (keyed by install id), replacing the last one. */
export function reportHubMachines(agentDir: string, machines: Readonly<Record<string, HubMachineLinkState>>): void {
	updateLinks(agentDir, (links) => {
		links.machines = { ...machines };
	});
}

/** What the hosting session last wrote about the machines joined to it. */
export function hubMachinesFor(agentDir: string): Readonly<Record<string, HubMachineLinkState>> {
	return readLinks(agentDir).machines;
}

/**
 * Registers the hub controller's view for its agent directory and returns the withdrawal that controller calls when its
 * session closes. The registration lives exactly as long as its provider: left in place, the closures would keep a closed
 * session reachable for the life of the process. The withdrawal removes only its own registration, so a later session's
 * context for the same directory stays.
 */
export function provideLinkContext(agentDir: string, context: LinkContext): () => void {
	contexts.set(agentDir, context);
	return () => {
		if (contexts.get(agentDir) === context) contexts.delete(agentDir);
	};
}

export function linkContextFor(agentDir: string): LinkContext {
	return contexts.get(agentDir) ?? { subtree: () => [], depth: () => 0 };
}
