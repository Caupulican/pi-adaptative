/**
 * What a machine keeps about the links it is part of, under `<agentDir>/remote/`: its own identity, the machines allowed to
 * join it as a hub, and the hubs it joined. Secrets are written for the owner only and never printed after they are made.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isPlainRecord } from "../util/value-guards.ts";
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

const dirOf = (agentDir: string): string => join(agentDir, "remote");

function writeSecretFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
	renameSync(temp, path);
	if (process.platform !== "win32") chmodSync(path, 0o600);
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function sanitizeName(raw: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return isMachineName(cleaned) ? cleaned : "machine";
}

/** This install's identity: made on first use (a random id, the hostname as the name) and kept. */
export function loadIdentity(agentDir: string): MachineIdentity {
	const path = join(dirOf(agentDir), "identity.json");
	const stored = readJson(path);
	if (isPlainRecord(stored) && typeof stored.machineId === "string" && isMachineName(stored.name))
		return { machineId: stored.machineId, name: stored.name };
	const identity: MachineIdentity = { machineId: randomUUID(), name: sanitizeName(hostname()) };
	writeSecretFile(path, identity);
	return identity;
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
