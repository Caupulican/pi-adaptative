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
import {
	createPairing,
	isPairingKey,
	type PendingPairing,
	pairingId,
	parsePairingToken,
	preparePairing,
} from "./pairing.ts";
import { isMachineName, type LinkRefusal } from "./protocol.ts";

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
	readonly requireSealed?: true;
	/** Before first admission secret holds a private ECDH key, erased when the invitation is consumed. */
	readonly pairing?: PendingPairing;
}

/** A hub this machine joins. */
export interface JoinRecord {
	readonly pairingKey?: string;
	readonly invitationId?: string;
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
	const records: HubMachineRecord[] = [];
	for (const entry of stored) {
		if (
			!isPlainRecord(entry) ||
			!isMachineName(entry.name) ||
			typeof entry.secret !== "string" ||
			typeof entry.createdAt !== "string"
		)
			return undefined;
		let pairing: PendingPairing | undefined;
		if (entry.pairing !== undefined) {
			const value = entry.pairing;
			if (
				!isPlainRecord(value) ||
				typeof value.salt !== "string" ||
				typeof value.expiresAt !== "number" ||
				!Number.isSafeInteger(value.expiresAt)
			)
				return undefined;
			pairing = { salt: value.salt, expiresAt: value.expiresAt };
		}
		records.push({
			name: entry.name,
			secret: entry.secret,
			createdAt: entry.createdAt,
			...(entry.requireSealed === true ? { requireSealed: true } : {}),
			...(pairing ? { pairing } : {}),
			...(typeof entry.machineId === "string" ? { machineId: entry.machineId } : {}),
			...(entry.revoked === true ? { revoked: true } : {}),
		});
	}
	return records;
}

/** The hub's machine records; an unreadable file reads as none (see `readHubMachines` for the case that must be told apart). */
export function listHubMachines(agentDir: string): HubMachineRecord[] {
	return readHubMachines(agentDir) ?? [];
}

/** Serialize enrollment, rotation and revocation, including competing terminal sessions. */
function changeLinkRecords<T, R>(
	agentDir: string,
	file: string,
	read: (dir: string) => R[] | undefined,
	change: (records: R[]) => { records?: R[]; result: T },
): T {
	const dir = dirOf(agentDir);
	mkdirSync(dir, { recursive: true });
	return withFileLockSync(join(dir, file), () => {
		const current = read(agentDir);
		if (!current) throw new Error(`The link registry ${file} could not be read.`);
		const next = change(current);
		if (next.records) writeLinkFile(agentDir, file, next.records);
		return next.result;
	});
}

/** Issue a first invitation or replace the key of a known machine, keeping its bound install id. */
export function inviteHubMachine(agentDir: string, hubName: string, name: string, rotate = false): string | undefined {
	if (!isMachineName(name)) throw new Error("A machine name is lowercase letters, digits and dashes (up to 63).");
	return changeLinkRecords(agentDir, "machines.json", readHubMachines, (records) => {
		const current = records.find((record) => record.name === name);
		if (rotate && (!current || current.revoked)) return { result: undefined };
		if (!rotate && current) throw new Error(`A machine named ${name} already exists.`);
		const invite = createPairing(hubName, name);
		const next: HubMachineRecord = {
			...current,
			name,
			createdAt: current?.createdAt ?? new Date().toISOString(),
			secret: invite.privateKey,
			pairing: invite.pending,
			requireSealed: true,
		};
		return { records: [...records.filter((record) => record !== current), next], result: invite.token };
	});
}

export function revokeHubMachine(agentDir: string, name: string): HubMachineRecord | undefined {
	return changeLinkRecords(agentDir, "machines.json", readHubMachines, (records) => {
		const current = records.find((record) => record.name === name);
		if (!current || current.revoked) return { result: current };
		const revoked = { ...current, revoked: true };
		return { records: records.map((record) => (record === current ? revoked : record)), result: revoked };
	});
}

/** Compare the credentials proved by this hello with the current record under the same lock as revoke and rotate. */
export function bindHubMachine(
	agentDir: string,
	proven: HubMachineRecord,
	machineId: string,
	secret: string,
): LinkRefusal | undefined {
	return changeLinkRecords<LinkRefusal | undefined, HubMachineRecord>(
		agentDir,
		"machines.json",
		readHubMachines,
		(records) => {
			const current = records.find((record) => record.name === proven.name);
			if (!current || current.secret !== proven.secret) return { result: "bad_proof" };
			if (current.revoked) return { result: "revoked" };
			if (current.pairing && current.pairing.expiresAt <= Date.now()) return { result: "invitation_expired" };
			if (current.machineId && current.machineId !== machineId) return { result: "machine_changed" };
			if (current.machineId === machineId && !current.pairing) return { result: undefined };
			if (records.some((r) => !r.revoked && r.name !== current.name && r.machineId === machineId))
				return { result: "machine_taken" };
			const { pairing: _consumed, ...admitted } = current;
			return {
				records: records.map((r) => (r === current ? { ...admitted, machineId, secret } : r)),
				result: undefined,
			};
		},
	);
}

/** The address the owner configured with /remote listen, including whether it is still enabled. */
export interface HubConfig {
	readonly host: string;
	readonly port: number;
	readonly enabled: boolean;
}

export function readHubConfig(agentDir: string): HubConfig | undefined {
	const value = readJson(join(dirOf(agentDir), "hub.json"), false);
	return isPlainRecord(value) &&
		typeof value.host === "string" &&
		value.host.trim().length > 0 &&
		isLinkPort(value.port)
		? { host: value.host, port: value.port, enabled: value.enabled === true }
		: undefined;
}

function readJoins(agentDir: string): JoinRecord[] | undefined {
	const path = join(dirOf(agentDir), "joins.json");
	if (!existsSync(path)) return [];
	const stored = readJson(path);
	if (!Array.isArray(stored)) return undefined;
	const records: JoinRecord[] = [];
	for (const entry of stored) {
		if (
			!isPlainRecord(entry) ||
			typeof entry.address !== "string" ||
			!isMachineName(entry.name) ||
			!isMachineName(entry.hubName) ||
			typeof entry.secret !== "string"
		)
			return undefined;
		const common = { address: entry.address, name: entry.name, hubName: entry.hubName, secret: entry.secret };
		if (entry.pairingKey === undefined && entry.invitationId === undefined) records.push(common);
		else if (isPairingKey(entry.pairingKey) && typeof entry.invitationId === "string")
			records.push({ ...common, pairingKey: entry.pairingKey, invitationId: entry.invitationId });
		else return undefined;
	}
	return records;
}

export function listJoins(agentDir: string): JoinRecord[] {
	return readJoins(agentDir) ?? [];
}

/** Save the reconnect key before dialing. Repeating an invitation keeps the key of the first attempt. */
export function enrollJoin(agentDir: string, address: string, raw: string, legacy = false): JoinRecord | undefined {
	if (!parseAddress(address)) return undefined;
	const token = parsePairingToken(raw) ?? (legacy ? parseLegacyToken(raw) : undefined);
	if (!token) return undefined;
	return changeLinkRecords(agentDir, "joins.json", readJoins, (records) => {
		const current = records.find((entry) => entry.address === address && entry.name === token.name);
		const id = "salt" in token ? pairingId(token) : undefined;
		const enrolled = id ? records.find((entry) => entry.invitationId === id) : undefined;
		if (enrolled) {
			if (enrolled.address === address) return { result: enrolled };
			if (current) throw new Error("Another enrollment already uses that machine name at the requested address.");
			const moved = { ...enrolled, address };
			return { records: records.map((entry) => (entry === enrolled ? moved : entry)), result: moved };
		}
		const next: JoinRecord = {
			address,
			name: token.name,
			hubName: token.hubName,
			...("salt" in token ? { ...preparePairing(token), invitationId: id } : { secret: token.secret }),
		};
		return { records: [...records.filter((entry) => entry !== current), next], result: next };
	});
}

export function removeJoin(agentDir: string, address: string): boolean {
	return changeLinkRecords(agentDir, "joins.json", readJoins, (records) => {
		const kept = records.filter((entry) => entry.address !== address);
		return kept.length === records.length ? { result: false } : { records: kept, result: true };
	});
}

function isLinkPort(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** `host:port` (a bracketed IPv6 host allowed), or undefined. */
export function parseAddress(raw: string): { host: string; port: number } | undefined {
	const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(raw.trim());
	if (!match) return undefined;
	const port = Number(match[3]);
	return isLinkPort(port) ? { host: match[1] ?? match[2]!, port } : undefined;
}

/** Previously issued long-lived tokens can still enroll on a legacy hub. */
function parseLegacyToken(raw: string): { hubName: string; name: string; secret: string } | undefined {
	const parts = raw.trim().split(".");
	if (parts.length !== 3) return undefined;
	const [hubName, name, secret] = parts as [string, string, string];
	return isMachineName(hubName) && isMachineName(name) && /^[A-Za-z0-9_-]{20,128}$/.test(secret)
		? { hubName, name, secret }
		: undefined;
}
