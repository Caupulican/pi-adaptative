/**
 * What a machine keeps about the links it is part of, under `<agentDir>/remote/`: its own identity, the machines allowed to
 * join it as a hub, and the hubs it joined. Secrets are written for the owner only (mode 0600 on POSIX, an access list
 * naming only the current account on Windows) and never printed after they are made. A machine is keyed by the id its
 * own install generated (`identity.json` `machineId`); names are labels the owner reads.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
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

/** Owner-set behaviour of the link on this machine (`remote/settings.json`). */
export interface LinkSettings {
	/**
	 * Refuse a peer that does not seal the link: a hub refuses such a joiner, a joiner such a hub. Off by default, so a
	 * machine on an older build keeps linking unsealed.
	 */
	readonly requireSealed: boolean;
}

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

function writeSecretFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	protectLinkDir(dirname(path));
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
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

export function loadLinkSettings(agentDir: string): LinkSettings {
	const stored = readJson(join(dirOf(agentDir), "settings.json"), false);
	return { requireSealed: isPlainRecord(stored) && stored.requireSealed === true };
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
	writeSecretFile(join(dirOf(agentDir), "identity.json"), identity);
	return identity;
}

export function listHubMachines(agentDir: string): HubMachineRecord[] {
	const stored = readJson(join(dirOf(agentDir), "machines.json"));
	if (!Array.isArray(stored)) return [];
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

function saveHubMachines(agentDir: string, machines: readonly HubMachineRecord[]): void {
	writeSecretFile(join(dirOf(agentDir), "machines.json"), machines);
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
	writeSecretFile(join(dirOf(agentDir), "joins.json"), [...joins, join_]);
}

export function removeJoin(agentDir: string, address: string): boolean {
	const joins = listJoins(agentDir);
	const kept = joins.filter((entry) => entry.address !== address);
	if (kept.length === joins.length) return false;
	writeSecretFile(join(dirOf(agentDir), "joins.json"), kept);
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
