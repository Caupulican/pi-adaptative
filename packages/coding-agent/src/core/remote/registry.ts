/**
 * What a machine keeps about the links it is part of, under `<agentDir>/remote/`: its own identity, the machines allowed to
 * join it as a hub, and the hubs it joined. Secrets are written for the owner only (mode 0600 on POSIX, an access list
 * naming only the current account on Windows) and never printed after they are made. A machine is keyed by the id its
 * own install generated (`identity.json` `machineId`); names are labels the owner reads.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { withHostFileWrite } from "../../utils/host-write-transition.ts";
import { hostTransitionsFile } from "../agent-paths.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { restrictWindowsToCurrentUser } from "../util/windows-user-acl.ts";
import { isMachineName, newSecret } from "./protocol.ts";

export interface MachineIdentity {
	readonly machineId: string;
	readonly name: string;
}

/** A machine the hub lets join, and the secret it proves. */
export interface HubMachineRecord {
	readonly name: string;
	readonly secret: string;
	readonly createdAt: string;
	/** The install id bound at the first successful join. */
	readonly machineId?: string;
	readonly revoked?: boolean;
}

/** A hub this machine joins. */
export interface JoinRecord {
	readonly address: string;
	/** The name the hub gave this machine. */
	readonly name: string;
	/** The hub's own name: the sender id its messages carry here. */
	readonly hubName: string;
	readonly secret: string;
}

/** A checkout this machine offers to placed jobs, by path; its identity is computed (`repo-identity.ts`). */
export interface LinkRepoSetting {
	readonly path: string;
	/** Whether the checkout is prepared for work (installed dependencies); a job never runs a setup command. */
	readonly ready?: boolean;
}

/** How far this machine lets a peer's jobs reach here: an answer only, reads of offered checkouts, or changes too. */
export type LinkPeerTrust = "answers" | "reads" | "changes";
export const LINK_PEER_TRUSTS: readonly LinkPeerTrust[] = ["answers", "reads", "changes"];

/** The owner's choices about one peer, keyed by its machine id. */
export interface LinkPeerSettings {
	/** Whether this machine runs jobs the peer places; absent takes the default (yes from the hub it joined). */
	readonly acceptsJobs?: boolean;
	readonly trust?: LinkPeerTrust;
	/** No new job is placed on the peer while held; jobs already there continue. */
	readonly hold?: boolean;
}

/** Owner-set behaviour of the link on this machine (`remote/settings.json`). */
export interface LinkSettings {
	/**
	 * Refuse a peer that does not seal the link: a hub refuses such a joiner, a joiner such a hub. Off by default, so a
	 * machine on an older build keeps linking unsealed.
	 */
	readonly requireSealed: boolean;
	/** Checkouts placed jobs may read here. None by default: a peer can then only ask for an answer. */
	readonly repos: readonly LinkRepoSetting[];
	readonly peers: Readonly<Record<string, LinkPeerSettings>>;
	/** How long a job placed on a peer that went offline waits for it to come back before it ends as unreachable. */
	readonly offlineHoldMs: number;
	/** How many placed jobs this machine runs at once. */
	readonly jobRoom: number;
}

export const DEFAULT_OFFLINE_HOLD_MS = 600_000;
export const DEFAULT_JOB_ROOM = 2;
const MAX_LINK_REPOS = 32;

const dirOf = (agentDir: string): string => join(agentDir, "remote");
const WIN32 = process.platform === "win32";
/** Link directories whose Windows access list this process already narrowed to the current account. */
const privateDirs = new Set<string>();

/**
 * On Windows, narrows the link directory to the current account once per process: files made in it afterwards (the
 * temporary file of a secret write included) inherit that, and so do the ones an older build left there. A failure is
 * a warning: the files stay as they were and the owner learns why.
 */
function protectLinkDir(dir: string): void {
	if (!WIN32 || privateDirs.has(dir) || !existsSync(dir)) return;
	privateDirs.add(dir);
	try {
		restrictWindowsToCurrentUser(dir, true);
	} catch (error) {
		harnessLog.warn("link", "the link directory could not be narrowed to this account", {
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
}

/**
 * One of the link's files, written owner-only as a host write: the journal records it, so the protected-path watch of every
 * session on this agent directory explains the change rather than blaming a worker that was running.
 */
function writeLinkFile(agentDir: string, name: string, value: unknown): void {
	const path = join(dirOf(agentDir), name);
	const content = `${JSON.stringify(value, null, 1)}\n`;
	withHostFileWrite(path, content, () => writeSecretFileContent(path, content), hostTransitionsFile(agentDir));
}

function writeSecretFileContent(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	protectLinkDir(dirname(path));
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, content, { mode: 0o600 });
	renameSync(temp, path);
	if (!WIN32) {
		chmodSync(path, 0o600);
		return;
	}
	try {
		restrictWindowsToCurrentUser(path, false);
	} catch (error) {
		harnessLog.warn("link", "a link secret file could not be narrowed to this account", {
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
}

/** Reads a link record; one that holds a secret narrows the directory on Windows first, one that does not (identity, settings) leaves it alone. */
function readJson(path: string, holdsSecret = true): unknown {
	if (!existsSync(path)) return undefined;
	if (holdsSecret) protectLinkDir(dirname(path));
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function readPeerSettings(value: unknown): LinkPeerSettings | undefined {
	if (!isPlainRecord(value)) return undefined;
	const trust = LINK_PEER_TRUSTS.find((level) => level === value.trust);
	return {
		...(typeof value.acceptsJobs === "boolean" ? { acceptsJobs: value.acceptsJobs } : {}),
		...(trust ? { trust } : {}),
		...(value.hold === true ? { hold: true } : {}),
	};
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export function loadLinkSettings(agentDir: string): LinkSettings {
	const stored = readJson(join(dirOf(agentDir), "settings.json"), false);
	const record = isPlainRecord(stored) ? stored : {};
	const repos = Array.isArray(record.repos)
		? record.repos
				.flatMap((entry): LinkRepoSetting[] =>
					isPlainRecord(entry) && typeof entry.path === "string" && isAbsolute(entry.path)
						? [{ path: entry.path, ...(entry.ready === true ? { ready: true } : {}) }]
						: [],
				)
				.slice(0, MAX_LINK_REPOS)
		: [];
	const peers: Record<string, LinkPeerSettings> = {};
	if (isPlainRecord(record.peers))
		for (const [machineId, value] of Object.entries(record.peers)) {
			const peer = readPeerSettings(value);
			if (peer) peers[machineId] = peer;
		}
	return {
		requireSealed: record.requireSealed === true,
		repos,
		peers,
		offlineHoldMs: boundedInteger(record.offlineHoldMs, 0, 24 * 60 * 60_000, DEFAULT_OFFLINE_HOLD_MS),
		jobRoom: boundedInteger(record.jobRoom, 0, 16, DEFAULT_JOB_ROOM),
	};
}

/**
 * Changes the owner's choices about one peer in `remote/settings.json`, leaving every other key as the owner wrote it.
 * Under the settings file's lock, so two sessions changing two peers keep both.
 */
export function updateLinkPeerSettings(
	agentDir: string,
	machineId: string,
	change: LinkPeerSettings,
): LinkPeerSettings {
	const path = join(dirOf(agentDir), "settings.json");
	mkdirSync(dirOf(agentDir), { recursive: true });
	return withFileLockSync(path, () => {
		const stored = readJson(path, false);
		const record = isPlainRecord(stored) ? { ...stored } : {};
		const peers = isPlainRecord(record.peers) ? { ...record.peers } : {};
		const next = { ...(readPeerSettings(peers[machineId]) ?? {}), ...change };
		peers[machineId] = next;
		record.peers = peers;
		const content = `${JSON.stringify(record, null, 1)}\n`;
		withHostFileWrite(path, content, () => writeFileAtomicSync(path, content), hostTransitionsFile(agentDir));
		return next;
	});
}

function sanitizeName(raw: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return isMachineName(cleaned) ? cleaned : "machine";
}

function readIdentity(path: string): MachineIdentity | undefined {
	const stored = readJson(path, false);
	return isPlainRecord(stored) && typeof stored.machineId === "string" && isMachineName(stored.name)
		? { machineId: stored.machineId, name: stored.name }
		: undefined;
}

/**
 * This install's identity: made on first use (a random id, the hostname as the name) and kept. The id is what every
 * link record is keyed by; two machines that share a hostname (a WSL instance and its Windows host) differ by it.
 * The first file is published by an exclusive link, so two sessions starting at once on a fresh agent directory
 * agree on one id instead of each keeping its own.
 */
export function loadIdentity(agentDir: string): MachineIdentity {
	const path = join(dirOf(agentDir), "identity.json");
	const stored = readIdentity(path);
	if (stored) return stored;
	const identity: MachineIdentity = { machineId: randomUUID(), name: sanitizeName(hostname()) };
	mkdirSync(dirOf(agentDir), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(identity, null, 1)}\n`, { mode: 0o600 });
	try {
		if (existsSync(path)) renameSync(temp, path);
		else linkSync(temp, path);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		const winner = readIdentity(path);
		if (winner) return winner;
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
	return readIdentity(path) ?? identity;
}

export function renameIdentity(agentDir: string, name: string): MachineIdentity {
	if (!isMachineName(name)) throw new Error("A machine name is lowercase letters, digits and dashes (up to 63).");
	const identity = { ...loadIdentity(agentDir), name };
	writeLinkFile(agentDir, "identity.json", identity);
	return identity;
}

/**
 * The hub's machine records. A missing file holds none; a file that exists but cannot be read or parsed is unknown, so the
 * result is undefined: a reader that acts on the records (a connection cut) must skip the change, not read it as empty.
 */
export function readHubMachines(agentDir: string): HubMachineRecord[] | undefined {
	const path = join(dirOf(agentDir), "machines.json");
	if (!existsSync(path)) return [];
	protectLinkDir(dirname(path));
	let stored: unknown;
	try {
		stored = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	if (!Array.isArray(stored)) return undefined;
	return stored.flatMap((entry): HubMachineRecord[] =>
		isPlainRecord(entry) &&
		isMachineName(entry.name) &&
		typeof entry.secret === "string" &&
		typeof entry.createdAt === "string"
			? [
					{
						name: entry.name,
						secret: entry.secret,
						createdAt: entry.createdAt,
						...(typeof entry.machineId === "string" ? { machineId: entry.machineId } : {}),
						...(entry.revoked === true ? { revoked: true } : {}),
					},
				]
			: [],
	);
}

/** The hub's machine records; an unreadable file reads as none (see `readHubMachines` for the case that must be told apart). */
export function listHubMachines(agentDir: string): HubMachineRecord[] {
	return readHubMachines(agentDir) ?? [];
}

function saveHubMachines(agentDir: string, machines: readonly HubMachineRecord[]): void {
	writeLinkFile(agentDir, "machines.json", machines);
}

/** The other name already bound to `machineId` (not revoked), when an install would join this hub under a second name. */
export function nameBoundTo(agentDir: string, machineId: string, except: string): string | undefined {
	return listHubMachines(agentDir).find(
		(machine) => machine.machineId === machineId && machine.name !== except && machine.revoked !== true,
	)?.name;
}

/** Lets a machine join this hub under `name`; the secret is returned once, here, for the owner to carry over. */
export function addHubMachine(agentDir: string, name: string): { record: HubMachineRecord } {
	if (!isMachineName(name)) throw new Error("A machine name is lowercase letters, digits and dashes (up to 63).");
	const machines = listHubMachines(agentDir);
	if (machines.some((machine) => machine.name === name)) throw new Error(`A machine named ${name} already exists.`);
	const record: HubMachineRecord = { name, secret: newSecret(), createdAt: new Date().toISOString() };
	saveHubMachines(agentDir, [...machines, record]);
	return { record };
}

export function updateHubMachine(
	agentDir: string,
	name: string,
	change: Partial<HubMachineRecord>,
): HubMachineRecord | undefined {
	const machines = listHubMachines(agentDir);
	const index = machines.findIndex((machine) => machine.name === name);
	if (index < 0) return undefined;
	const next = { ...machines[index]!, ...change, name };
	saveHubMachines(
		agentDir,
		machines.map((machine, i) => (i === index ? next : machine)),
	);
	return next;
}

/**
 * Gives a joined machine a new secret under the same name and install id: the old secret stops proving anything at the
 * next handshake, and every job keyed by the machine's id survives. The secret is returned once, for the owner to carry.
 */
export function rotateHubMachine(agentDir: string, name: string): HubMachineRecord | undefined {
	const current = listHubMachines(agentDir).find((machine) => machine.name === name);
	if (!current || current.revoked) return undefined;
	return updateHubMachine(agentDir, name, { secret: newSecret() });
}

/** Whether the owner turned this machine's hub on (`hub.json`): a machine with a hub on is linked, joined or not. */
export function hubTurnedOn(agentDir: string): boolean {
	const stored = readJson(join(dirOf(agentDir), "hub.json"), false);
	return isPlainRecord(stored) && stored.enabled === true;
}

export function listJoins(agentDir: string): JoinRecord[] {
	const stored = readJson(join(dirOf(agentDir), "joins.json"));
	if (!Array.isArray(stored)) return [];
	return stored.flatMap((entry): JoinRecord[] =>
		isPlainRecord(entry) &&
		typeof entry.address === "string" &&
		isMachineName(entry.name) &&
		isMachineName(entry.hubName) &&
		typeof entry.secret === "string"
			? [{ address: entry.address, name: entry.name, hubName: entry.hubName, secret: entry.secret }]
			: [],
	);
}

export function saveJoin(agentDir: string, join_: JoinRecord): void {
	const joins = listJoins(agentDir).filter((entry) => !(entry.address === join_.address && entry.name === join_.name));
	writeLinkFile(agentDir, "joins.json", [...joins, join_]);
}

export function removeJoin(agentDir: string, address: string): boolean {
	const joins = listJoins(agentDir);
	const kept = joins.filter((entry) => entry.address !== address);
	if (kept.length === joins.length) return false;
	writeLinkFile(agentDir, "joins.json", kept);
	return true;
}

/** `host:port` (a bracketed IPv6 host allowed), or undefined. */
export function parseAddress(raw: string): { host: string; port: number } | undefined {
	const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(raw.trim());
	if (!match) return undefined;
	const port = Number(match[3]);
	return port >= 1 && port <= 65535 ? { host: match[1] ?? match[2]!, port } : undefined;
}

/** The join string `/remote add` prints and `/remote join` reads: the hub's name, this machine's name and the secret. */
export function formatJoinToken(hubName: string, name: string, secret: string): string {
	return `${hubName}.${name}.${secret}`;
}

export function parseJoinToken(raw: string): { hubName: string; name: string; secret: string } | undefined {
	const parts = raw.trim().split(".");
	if (parts.length !== 3) return undefined;
	const [hubName, name, secret] = parts as [string, string, string];
	return isMachineName(hubName) && isMachineName(name) && /^[A-Za-z0-9_-]{20,128}$/.test(secret)
		? { hubName, name, secret }
		: undefined;
}
