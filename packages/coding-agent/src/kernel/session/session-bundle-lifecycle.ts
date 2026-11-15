import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { harnessLog } from "../harness-log.ts";
import { judgeOwner, type OwnerStanding, ownProcessOwner, type ProcessOwner } from "../reliability/owner-identity.ts";
import { isPositiveSafePid } from "../reliability/process-tree.ts";
import {
	type AtomicFileLockOptions,
	currentSynchronousFileLockScope,
	isMissingFileError,
	type SynchronousFileLockScope,
	withFileLockSync,
	writeFileAtomicSync,
} from "../storage/atomic-file.ts";
import { readOptionalBoundedTextFileSync } from "../storage/bounded-file.ts";
import { isPlainRecord } from "../utils/value-guards.ts";
import {
	type OrchestrationHome,
	orchestrationSessionDeletionFile,
	orchestrationSessionDeletionsDir,
	orchestrationSessionDir,
	resolvedOrchestrationHome,
	sameOrchestrationHome,
	sessionKeyOfDeletionFile,
} from "./session-bundle-paths.ts";
import {
	forgetRemovalBegun,
	forgetRetentionInFlight,
	markRetentionIndexComplete,
	readRetentionIndex,
	recordRemovalBegun,
	recordRetentionInFlight,
	removalBegun,
	retentionIndexComplete,
} from "./session-retention-index.ts";

/** Every operation here addresses a bundle inside an orchestration home; callers name the home they mean. */
export {
	type OrchestrationHome,
	ownerOrchestrationHome,
	ownerSessionStorageRoots,
	type SessionStorageRoots,
} from "./session-bundle-paths.ts";

export type SessionBundleDeletionPolicy = "retention" | "permanent";

/**
 * How far a tombstone's deletion went, read from the schema-3 marker an earlier build reads the same way and from its
 * `.removing` sibling (`session-retention-index.ts`): `removing` once its remover may have begun removing the bundle
 * (the sibling, created under the lock just before the first removal, {@link markSessionBundleRemoving}); else
 * `reserved` while its operation created it (`fresh`) and nothing of the bundle was touched; else `unrecorded` (an
 * earlier build's, or one whose remover settled what the bundle owed): how far it went is not known. Only a `reserved`
 * retention tombstone may be released with its bundle whole whatever refused it; an `unrecorded` one only when its
 * expiry was refused by something the open session settles ({@link settleSessionBundleDeletion} `released`), a
 * `removing` one never. Only a `removing` one proves its bundle passed the expiry's gates. A permanent tombstone
 * stands whatever its phase.
 */
export type SessionBundleDeletionPhase = "reserved" | "removing" | "unrecorded";

export interface SessionBundleDeletionReservation {
	readonly parentSessionId: string;
	readonly token: string;
	/** The tombstone's phase when this reservation took it: `reserved` unless it resumed an earlier expiry. */
	readonly phase: SessionBundleDeletionPhase;
}

interface DeletionOperation {
	token: string;
	/** The remover process, judged by {@link judgeOwner} before anyone else may recover the operation. */
	owner: ProcessOwner;
	processInstanceId: string;
	/** Only this operation created the absent marker, or took over one that stayed `reserved`; a resumed one never is. */
	fresh: boolean;
}

/** Schema 3 records the remover as a {@link ProcessOwner}; schema 2 (`host` + `pid`) is still read. */
const MARKER_SCHEMA_VERSION = 3;

interface DeletionMarker {
	schemaVersion: typeof MARKER_SCHEMA_VERSION;
	parentSessionId: string;
	policy: SessionBundleDeletionPolicy;
	operation?: DeletionOperation;
}

const MAX_MARKER_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROCESS_INSTANCE_ID = randomUUID();
const activeOperations = new Set<string>();
const admittedBundles = new Map<string, SynchronousFileLockScope>();

export function hasCurrentSessionBundleAdmission(home: OrchestrationHome, parentSessionId: string): boolean {
	const file = orchestrationSessionDeletionFile(home, parentSessionId);
	const scope = currentSynchronousFileLockScope(file);
	return scope !== undefined && admittedBundles.get(scope.lockfilePath) === scope;
}

/**
 * What a hold serves: `session`, an open session of the parent (the foreground, or an SDK session); `away-host`, the
 * bot daemon running the parent's routine runs while it is closed. An away host keeps the bundle alive but is no session:
 * it never takes back a collaboration job, so it never blocks another session's adoption of one. `channel-host`, the bot
 * daemon hosting the owner's phone session, and `bot-host`, a bot's host running the bot's own session: each is its
 * session's only open holder ({@link isExclusiveHostRole}), so it is admitted only while no session or other such host
 * holds the session, and an AgentSession open is refused while it holds it.
 */
export type SessionLeaseRole = "session" | "away-host" | "channel-host" | "bot-host";

/** A role that hosts its session alone: the phone session's channel host and a bot's host. */
export function isExclusiveHostRole(role: SessionLeaseRole): boolean {
	return role === "channel-host" || role === "bot-host";
}

/** A holder named in a refusal: its process id and what it serves. */
export interface SessionLeaseHolderRef {
	readonly pid: number;
	readonly role: SessionLeaseRole;
}

/** A session's lease registry (`file`) that does not read as one: no lease is taken or released there until it is inspected. */
export class SessionLeaseRegistryError extends Error {
	readonly file: string;
	constructor(file: string, message: string) {
		super(message);
		this.name = "SessionLeaseRegistryError";
		this.file = file;
	}
}

/** A channel or bot host (`refused`) was refused: the session is open (or held by a process that cannot be judged dead). */
export class SessionHeldError extends Error {
	readonly holders: readonly SessionLeaseHolderRef[];
	readonly refused: SessionLeaseRole;
	constructor(parentSessionId: string, holders: readonly SessionLeaseHolderRef[], refused: SessionLeaseRole) {
		const host = refused === "bot-host" ? "the bot's host runs" : "the daemon hosts";
		super(
			`Session ${parentSessionId} is open (pid ${holders.map((holder) => holder.pid).join(", ")}); ${host} it once it is closed.`,
		);
		this.name = "SessionHeldError";
		this.holders = holders;
		this.refused = refused;
	}
}

/**
 * A lease was refused because the session no longer belongs in the home it was opened in: its orchestration state moved
 * (a bot session's, out of the owner's home into its bot's) after the opener chose the home and before it took the
 * lease's lock. Nothing was written; the session is opened again, which finds it in its home now.
 */
export class SessionHomeChangedError extends Error {
	readonly sessionId: string;
	readonly home: OrchestrationHome;
	readonly current: OrchestrationHome;
	constructor(sessionId: string, home: OrchestrationHome, current: OrchestrationHome) {
		super(
			`Session ${sessionId} moved from ${home.root} to ${current.root} while it was being opened; open it again.`,
		);
		this.name = "SessionHomeChangedError";
		this.sessionId = sessionId;
		this.home = home;
		this.current = current;
	}
}

/**
 * An AgentSession open was refused: the bot daemon hosts the session as the owner's phone session (`channel-host`), or
 * a bot's host runs it as the bot's own (`bot-host`). The owner reads it in their language (`hostedSessionRefusal`).
 */
export class SessionHostedError extends Error {
	readonly holder: SessionLeaseHolderRef;
	constructor(holder: SessionLeaseHolderRef) {
		super(
			holder.role === "bot-host"
				? `This session is a bot's own conversation; its host (pid ${holder.pid}) runs it.`
				: `This is the phone session; the background daemon (pid ${holder.pid}) is hosting it. Stop the daemon to open it here (\`/bot daemon stop\`).`,
		);
		this.name = "SessionHostedError";
		this.holder = holder;
	}
}

interface BundleHolder {
	token: string;
	/** The holding process, judged by {@link judgeOwner}; only a `dead` holder stops serving the session. */
	owner: ProcessOwner;
	processInstanceId: string;
	role: SessionLeaseRole;
}

/**
 * Schema 2 records each holder as a {@link ProcessOwner}; schema 1 (`host` + `pid`) is still read. Schema 3 adds a
 * `role` key to an away-host, channel-host or bot-host holder; the registry is written as schema 3 only while it holds
 * one, so a build that predates roles refuses (as needing inspection) only a parent such a host holds right now, and a
 * build that does not know a role refuses its holder (its key count is that of no holder it reads): a bot session its
 * host holds is refused, not opened beside it, by a build older than the `bot-host` role.
 */
const HOLDERS_SCHEMA_VERSION = 2;
const ROLE_HOLDERS_SCHEMA_VERSION = 3;
const OWNER_KEYS: readonly string[] = ["pid", "startTime", "hostname", "machineId"];

/**
 * A persisted owner identity, or undefined when it is malformed. The same checks gate both the current shape and
 * the legacy `host` + `pid` pair it is upgraded from, so an older file is judged exactly like a fresh one.
 */
function parseProcessOwner(value: unknown): ProcessOwner | undefined {
	if (!isPlainRecord(value) || Object.keys(value).some((key) => !OWNER_KEYS.includes(key))) return undefined;
	const { pid, startTime, hostname, machineId } = value;
	if (!isPositiveSafePid(pid)) return undefined;
	if (startTime !== undefined && (typeof startTime !== "string" || !/^[0-9]{1,32}$/.test(startTime))) return undefined;
	if (hostname !== undefined && (typeof hostname !== "string" || !hostname || hostname.length > 512)) return undefined;
	if (machineId !== undefined && (typeof machineId !== "string" || !/^[0-9a-f]{1,128}$/.test(machineId)))
		return undefined;
	return {
		pid,
		...(startTime !== undefined ? { startTime } : {}),
		...(hostname !== undefined ? { hostname } : {}),
		...(machineId !== undefined ? { machineId } : {}),
	};
}

/** The owner a record names: `owner` in the current shape, `host` + `pid` in the legacy one. */
function parseRecordedOwner(record: Record<string, unknown>, legacy: boolean): ProcessOwner | undefined {
	if (!legacy) return parseProcessOwner(record.owner);
	return typeof record.host === "string" ? parseProcessOwner({ pid: record.pid, hostname: record.host }) : undefined;
}

interface BundleLeaseState {
	readonly home: OrchestrationHome;
	readonly parentSessionId: string;
	readonly holder: BundleHolder;
	claimed: boolean;
	status: "held" | "releasing" | "released";
}

/** A persisted session's lifetime hold, acquired before constructing any session-bound owners. */
export interface SessionBundleLease {
	release(): void;
}

const MAX_BUNDLE_HOLDERS = 64;
const MAX_HOLDER_BYTES = 64 * 1024;
const bundleLeases = new WeakMap<SessionBundleLease, BundleLeaseState>();

function readHolders(file: string, parentSessionId: string): BundleHolder[] {
	const text = readOptionalBoundedTextFileSync(file, MAX_HOLDER_BYTES, "Session bundle lifetime leases");
	if (text === undefined) return [];
	const value: unknown = JSON.parse(text);
	if (
		!isPlainRecord(value) ||
		Object.keys(value).length !== 3 ||
		(value.schemaVersion !== 1 &&
			value.schemaVersion !== HOLDERS_SCHEMA_VERSION &&
			value.schemaVersion !== ROLE_HOLDERS_SCHEMA_VERSION) ||
		value.parentSessionId !== parentSessionId ||
		!Array.isArray(value.holders) ||
		value.holders.length > MAX_BUNDLE_HOLDERS
	)
		throw new SessionLeaseRegistryError(file, "Session bundle lifetime leases require inspection.");
	const legacy = value.schemaVersion === 1;
	const roles = value.schemaVersion === ROLE_HOLDERS_SCHEMA_VERSION;
	const tokens = new Set<string>();
	const holders: BundleHolder[] = [];
	for (const holder of value.holders) {
		const owner = isPlainRecord(holder) ? parseRecordedOwner(holder, legacy) : undefined;
		// Only an away, channel or bot host records its role; a holder without one is a session.
		const role =
			roles &&
			isPlainRecord(holder) &&
			(holder.role === "away-host" || holder.role === "channel-host" || holder.role === "bot-host")
				? holder.role
				: undefined;
		if (
			!isPlainRecord(holder) ||
			!owner ||
			Object.keys(holder).length !== (legacy || role ? 4 : 3) ||
			typeof holder.token !== "string" ||
			!UUID_PATTERN.test(holder.token) ||
			tokens.has(holder.token) ||
			typeof holder.processInstanceId !== "string" ||
			!UUID_PATTERN.test(holder.processInstanceId)
		)
			throw new SessionLeaseRegistryError(file, "Session bundle lifetime lease identity is invalid.");
		tokens.add(holder.token);
		holders.push({
			token: holder.token,
			owner,
			processInstanceId: holder.processInstanceId,
			role: role ?? "session",
		});
	}
	return holders;
}

function writeHolders(file: string, parentSessionId: string, holders: BundleHolder[]): void {
	if (holders.length === 0) {
		unlinkSync(file);
		return;
	}
	const roles = holders.some((holder) => holder.role !== "session");
	const text = `${JSON.stringify({
		schemaVersion: roles ? ROLE_HOLDERS_SCHEMA_VERSION : HOLDERS_SCHEMA_VERSION,
		parentSessionId,
		holders: holders.map(({ role, ...holder }) => (role !== "session" ? { ...holder, role } : holder)),
	})}\n`;
	if (Buffer.byteLength(text) > MAX_HOLDER_BYTES) throw new Error("Session bundle lifetime leases are too large.");
	writeFileAtomicSync(file, text);
}

/** Prunes only holders PROVEN gone; an `alive`, `foreign` or `unknown` holder keeps serving the session. */
function liveHolders(file: string, parentSessionId: string): BundleHolder[] {
	const holders = readHolders(file, parentSessionId);
	const live = holders.filter((holder) => judgeOwner(holder.owner) !== "dead");
	if (live.length !== holders.length) writeHolders(file, parentSessionId, live);
	return live;
}

const holderRef = (holder: {
	readonly owner: ProcessOwner;
	readonly role: SessionLeaseRole;
}): SessionLeaseHolderRef => ({
	pid: holder.owner.pid,
	role: holder.role,
});

/**
 * The holders among `holders` (none proven dead) a channel or bot host is refused for, as its admission counts them: a
 * session or another channel or bot host, whether alive, on another machine or unjudgeable; an away host never is.
 */
export function botHostBlockers<T extends { readonly role: SessionLeaseRole }>(holders: readonly T[]): T[] {
	return holders.filter((holder) => holder.role === "session" || isExclusiveHostRole(holder.role));
}

/**
 * The admission of one holder over the holders not proven dead (alive, foreign or unknown all hold): a channel or bot
 * host is refused while a session or another such host holds the session ({@link botHostBlockers}), a session asking
 * `refuseHosted` while such a host does; every other admission is bounded by capacity alone.
 */
function admitHolder(
	parentSessionId: string,
	holders: readonly BundleHolder[],
	holder: BundleHolder,
	refuseHosted: boolean,
): BundleHolder[] {
	if (holders.length >= MAX_BUNDLE_HOLDERS) throw new Error("Session bundle lifetime lease capacity reached.");
	if (isExclusiveHostRole(holder.role)) {
		const open = botHostBlockers(holders);
		if (open.length > 0) throw new SessionHeldError(parentSessionId, open.map(holderRef), holder.role);
	}
	const host = refuseHosted && holder.role === "session" && holders.find((entry) => isExclusiveHostRole(entry.role));
	if (host) throw new SessionHostedError(holderRef(host));
	return [...holders, holder];
}

/** One process currently holding a lifetime lease on a persisted session, as {@link readSessionLeaseHolders} sees it. */
export interface SessionLeaseHolder {
	/** The hold's identity; {@link sessionBundleLeaseToken} names the hold a caller acquired itself. */
	readonly token: string;
	readonly owner: ProcessOwner;
	readonly processInstanceId: string;
	/** What the hold serves: an open session, or an away host running the closed parent's routine runs. */
	readonly role: SessionLeaseRole;
	/** {@link judgeOwner}'s standing. Only `dead` proves the holder no longer serves the session. */
	readonly standing: OwnerStanding;
	/** The holder is this very process. */
	readonly self: boolean;
}

/**
 * Who is serving a persisted session right now, answerable from any process: every recorded lifetime lease holder,
 * each judged by {@link judgeOwner}. Read-only: it neither locks the registry nor prunes dead holders (the file is
 * replaced atomically, so a reader always sees one whole snapshot). A session that is not persisted, or that no
 * process holds, has no holders. A registry that cannot be parsed throws; a caller must treat that as unknown.
 */
export function readSessionLeaseHolders(home: OrchestrationHome, parentSessionId: string): SessionLeaseHolder[] {
	const file = `${orchestrationSessionDeletionFile(resolvedOrchestrationHome(home), parentSessionId)}.leases.json`;
	return readHolders(file, parentSessionId).map((holder) => ({
		token: holder.token,
		owner: holder.owner,
		processInstanceId: holder.processInstanceId,
		role: holder.role,
		standing: judgeOwner(holder.owner),
		self: holder.processInstanceId === PROCESS_INSTANCE_ID,
	}));
}

/** Whether `home` holds the session: its bundle, its deletion tombstone or its lifetime leases are there. */
export function orchestrationHomeHoldsSession(home: OrchestrationHome, parentSessionId: string): boolean {
	const tombstone = orchestrationSessionDeletionFile(home, parentSessionId);
	return (
		existsSync(orchestrationSessionDir(home, parentSessionId)) ||
		existsSync(tombstone) ||
		existsSync(`${tombstone}.leases.json`)
	);
}

/**
 * The channel or bot host holding the session that is not proven dead, if any; read-only like
 * {@link readSessionLeaseHolders}.
 */
export function sessionExclusiveHost(home: OrchestrationHome, parentSessionId: string): SessionLeaseHolder | undefined {
	return readSessionLeaseHolders(home, parentSessionId).find(
		(holder) => isExclusiveHostRole(holder.role) && holder.standing !== "dead",
	);
}

/**
 * Refuse, before anything is opened or written, to open a session a channel or bot host holds: the check the AgentSession
 * acquire makes ({@link acquireSessionBundleLease} with `refuseHosted`), read-only. An unreadable registry throws.
 */
export function refuseHostedSession(home: OrchestrationHome, parentSessionId: string): void {
	const host = sessionExclusiveHost(home, parentSessionId);
	if (host) throw new SessionHostedError(holderRef(host));
}

function releaseBundleLease(state: BundleLeaseState): void {
	if (state.status === "released") return;
	const tombstone = orchestrationSessionDeletionFile(state.home, state.parentSessionId);
	const file = `${tombstone}.leases.json`;
	withFileLockSync(tombstone, () => {
		const holders = readHolders(file, state.parentSessionId);
		const index = holders.findIndex((entry) => entry.token === state.holder.token);
		if (index < 0 && state.status !== "releasing") throw new Error("Session bundle lifetime lease disappeared.");
		state.status = "releasing";
		if (index >= 0)
			writeHolders(
				file,
				state.parentSessionId,
				holders.filter((entry) => entry.token !== state.holder.token),
			);
		state.status = "released";
	});
}

/**
 * Where a session belongs now, asked under its tombstone lock: the opener's own derivation of its home, run again. A
 * lease is taken only in the home it still names, so no session holds leases in two homes.
 */
export type SessionHomeNow = () => OrchestrationHome;

/**
 * Takes a lifetime lease on a persisted session, in the home `homeNow` still names under the lock (another refuses it:
 * {@link SessionHomeChangedError}).
 */
export function acquireSessionBundleLease(
	home: OrchestrationHome,
	parentSessionId: string,
	/**
	 * `refuseHosted`: a `session` hold is refused while a channel or bot host holds the session (the AgentSession open).
	 * `homeNow`: the session's home derived again under the lock; another than `home` refuses the lease.
	 */
	options: { role?: SessionLeaseRole; refuseHosted?: boolean; homeNow: SessionHomeNow },
): SessionBundleLease {
	const resolvedHome = resolvedOrchestrationHome(home);
	const tombstone = orchestrationSessionDeletionFile(resolvedHome, parentSessionId);
	const file = `${tombstone}.leases.json`;
	const holder: BundleHolder = {
		token: randomUUID(),
		owner: ownProcessOwner(),
		processInstanceId: PROCESS_INSTANCE_ID,
		role: options.role ?? "session",
	};
	withSessionBundleAdmission(resolvedHome, parentSessionId, () => {
		const current = options.homeNow();
		if (!sameOrchestrationHome(current, resolvedHome))
			throw new SessionHomeChangedError(parentSessionId, resolvedHome, current);
		const holders = liveHolders(file, parentSessionId);
		writeHolders(file, parentSessionId, admitHolder(parentSessionId, holders, holder, options.refuseHosted === true));
	});
	const state: BundleLeaseState = { home: resolvedHome, parentSessionId, holder, claimed: false, status: "held" };
	const lease: SessionBundleLease = Object.freeze({
		release() {
			if (state.claimed) throw new Error("The session owns this bundle lease; close the session to release it.");
			releaseBundleLease(state);
		},
	});
	bundleLeases.set(lease, state);
	return lease;
}

/**
 * The holder token of a hold {@link acquireSessionBundleLease} returned, as {@link readSessionLeaseHolders} lists it.
 * A process can hold the same session more than once, so `self` cannot tell its holds apart; the token does.
 */
export function sessionBundleLeaseToken(lease: SessionBundleLease): string {
	const state = bundleLeases.get(lease);
	if (!state) throw new Error("Not a session bundle lifetime lease acquired by this process.");
	return state.holder.token;
}

/** Direct construction must transfer a real, unclaimed hold for this exact persisted session. */
export function claimSessionBundleLease(
	lease: SessionBundleLease | undefined,
	home: OrchestrationHome,
	parentSessionId: string,
	persisted: boolean,
): SessionBundleLease | undefined {
	if (!persisted && lease === undefined) return;
	const state = lease && bundleLeases.get(lease);
	if (
		state?.status !== "held" ||
		state.claimed ||
		state.home.root !== resolvedOrchestrationHome(home).root ||
		state.parentSessionId !== parentSessionId
	)
		throw new Error("Persisted AgentSession construction requires its own live session bundle lease.");
	state.claimed = true;
	return Object.freeze({ release: () => releaseBundleLease(state) });
}

/** Retains the operation's disposition when only bridge cleanup failed. */
export class SessionBundleLeaseReleaseError extends AggregateError {
	readonly operationFailure: { error: unknown } | undefined;
	constructor(failures: unknown[], operationFailure: { error: unknown } | undefined) {
		super(failures, "Session transition or bundle lease release failed.");
		this.operationFailure = operationFailure;
	}
}

/**
 * Bridge retirement and activation, retaining both sessions through rollback and unwinding partial acquisition. The
 * hold of a session asking `refuseHosted` (the one being opened) refuses it while a channel or bot host holds it
 * (`SessionHostedError`), as the AgentSession open it bridges does, so the refusal comes before the current session is
 * closed; the session being left is held as it is.
 */
export async function withSessionBundleLeases<T>(
	/**
	 * Each session in the home its manager's roots name, with that home derived again (`homeNow`); one held twice is
	 * leased once, refusing a hosted session when either asks.
	 */
	sessions: readonly {
		readonly home: OrchestrationHome;
		readonly sessionId: string;
		readonly homeNow: SessionHomeNow;
		readonly refuseHosted: boolean;
	}[],
	operation: () => Promise<T>,
): Promise<T> {
	const leases: SessionBundleLease[] = [];
	const releaseFailures: unknown[] = [];
	let operationFailure: { error: unknown } | undefined;
	let result: T | undefined;
	try {
		const held = new Map<string, (typeof sessions)[number]>();
		for (const session of sessions) {
			const key = orchestrationSessionDeletionFile(resolvedOrchestrationHome(session.home), session.sessionId);
			const first = held.get(key);
			held.set(key, first ? { ...first, refuseHosted: first.refuseHosted || session.refuseHosted } : session);
		}
		for (const { home, sessionId, homeNow, refuseHosted } of held.values())
			leases.push(acquireSessionBundleLease(home, sessionId, { refuseHosted, homeNow }));
		result = await operation();
	} catch (error) {
		operationFailure = { error };
	} finally {
		for (const lease of leases.reverse()) {
			try {
				lease.release();
			} catch (error) {
				releaseFailures.push(error);
			}
		}
	}
	if (releaseFailures.length > 0)
		throw new SessionBundleLeaseReleaseError(
			operationFailure ? [operationFailure.error, ...releaseFailures] : releaseFailures,
			operationFailure,
		);
	if (operationFailure) throw operationFailure.error;
	return result as T;
}

function readMarker(file: string, parentSessionId: string): DeletionMarker | undefined {
	const text = readOptionalBoundedTextFileSync(file, MAX_MARKER_BYTES, "Session bundle deletion marker");
	if (text === undefined) return undefined;
	const value: unknown = JSON.parse(text);
	if (
		!isPlainRecord(value) ||
		(value.schemaVersion !== 2 && value.schemaVersion !== MARKER_SCHEMA_VERSION) ||
		value.parentSessionId !== parentSessionId ||
		(value.policy !== "retention" && value.policy !== "permanent") ||
		Object.keys(value).some((key) => !["schemaVersion", "parentSessionId", "policy", "operation"].includes(key))
	) {
		throw new Error("Session bundle deletion marker requires inspection; its ownership or policy is unknown.");
	}
	const legacy = value.schemaVersion === 2;
	const recorded = value.operation;
	if (recorded === undefined) return { schemaVersion: MARKER_SCHEMA_VERSION, parentSessionId, policy: value.policy };
	const owner = isPlainRecord(recorded) ? parseRecordedOwner(recorded, legacy) : undefined;
	if (
		!isPlainRecord(recorded) ||
		!owner ||
		Object.keys(recorded).length !== (legacy ? 5 : 4) ||
		typeof recorded.token !== "string" ||
		!UUID_PATTERN.test(recorded.token) ||
		typeof recorded.processInstanceId !== "string" ||
		!UUID_PATTERN.test(recorded.processInstanceId) ||
		typeof recorded.fresh !== "boolean"
	) {
		throw new Error("Session bundle deletion operation is invalid.");
	}
	return {
		schemaVersion: MARKER_SCHEMA_VERSION,
		parentSessionId,
		policy: value.policy,
		operation: {
			token: recorded.token,
			owner,
			processInstanceId: recorded.processInstanceId,
			fresh: recorded.fresh,
		},
	};
}

function writeMarker(file: string, marker: DeletionMarker): void {
	const text = `${JSON.stringify(marker)}\n`;
	if (Buffer.byteLength(text) > MAX_MARKER_BYTES) throw new Error("Session bundle deletion marker is too large.");
	writeFileAtomicSync(file, text);
}

/**
 * Writes the session's tombstone in `home` under its lock, keeping the in-flight index (`session-retention-index.ts`):
 * a retention is indexed before its marker is written, a permanent one leaves the index and its removal record.
 */
function writeTombstone(home: OrchestrationHome, tombstone: string, marker: DeletionMarker): void {
	if (marker.policy === "retention") recordRetentionInFlight(home, marker.parentSessionId);
	writeMarker(tombstone, marker);
	if (marker.policy === "permanent") {
		forgetRemovalBegun(home, marker.parentSessionId);
		forgetRetentionInFlight(home, marker.parentSessionId);
	}
}

/** Removes the session's tombstone in `home` under its lock, then its removal record and index entry. */
function removeTombstone(home: OrchestrationHome, tombstone: string, parentSessionId: string): void {
	unlinkSync(tombstone);
	forgetRemovalBegun(home, parentSessionId);
	forgetRetentionInFlight(home, parentSessionId);
}

function tombstonePhase(
	home: OrchestrationHome,
	parentSessionId: string,
	marker: DeletionMarker,
): SessionBundleDeletionPhase {
	if (removalBegun(home, parentSessionId)) return "removing";
	return marker.operation?.fresh ? "reserved" : "unrecorded";
}

/** This process may take over an operation it finished itself, or one whose remover is PROVEN gone. */
function canRecoverOperation(operation: DeletionOperation): boolean {
	if (operation.owner.pid === process.pid && operation.processInstanceId === PROCESS_INSTANCE_ID) {
		return !activeOperations.has(operation.token);
	}
	return judgeOwner(operation.owner) === "dead";
}

/**
 * The deletion policy the session's tombstone in `home` records, read without the lock (the marker is replaced whole):
 * `permanent` from the moment the session's deletion is reserved, kept after its removal settles; `retention` while
 * an expiry retires its bundle; undefined when no deletion was ever reserved there. A marker that does not read throws.
 */
export function sessionBundleDeletionPolicy(
	home: OrchestrationHome,
	parentSessionId: string,
): SessionBundleDeletionPolicy | undefined {
	return readMarker(orchestrationSessionDeletionFile(home, parentSessionId), parentSessionId)?.policy;
}

/**
 * A retention tombstone an expiry resumes past the age gates: one an earlier expiry settled without finishing (it
 * already passed age admission, and its own partial writes do not restart that age), one an earlier build left, or one
 * whose remover may have begun removing. A `reserved` tombstone is not resumed: the bundle is whole, and its expiry
 * starts over through every gate.
 */
function isPendingRetention(
	phase: SessionBundleDeletionPhase | undefined,
	marker: DeletionMarker | undefined,
): boolean {
	return marker?.policy === "retention" && phase !== "reserved";
}

/**
 * The phase of the session's tombstone in `home` when it is a retention an expiry resumes ({@link isPendingRetention});
 * undefined otherwise. Read unlocked: the reservation confirms it under the lock.
 */
export function pendingSessionBundleRetention(
	home: OrchestrationHome,
	parentSessionId: string,
): SessionBundleDeletionPhase | undefined {
	const marker = readMarker(orchestrationSessionDeletionFile(home, parentSessionId), parentSessionId);
	if (!marker) return undefined;
	const phase = tombstonePhase(home, parentSessionId, marker);
	return isPendingRetention(phase, marker) ? phase : undefined;
}

/**
 * Whether a retention tombstone may go while its bundle stands: nothing of the bundle was touched (`reserved`) and no
 * live remover holds it.
 */
function isReleasableRetention(home: OrchestrationHome, marker: DeletionMarker): boolean {
	return (
		marker.policy === "retention" &&
		tombstonePhase(home, marker.parentSessionId, marker) === "reserved" &&
		(!marker.operation || canRecoverOperation(marker.operation))
	);
}

/**
 * What the session's retention tombstone in `home` asks of an expiry, judged under its lock: `none` (no retention: an
 * index entry left by a settled or upgraded tombstone is pruned), `released` (a `reserved` one no live remover holds
 * went, its bundle whole and its session openable again), `active` (a live remover holds it) or `pending` with its
 * phase (an expiry resumes it). A marker that does not read throws.
 */
export function inspectSessionBundleRetention(
	home: OrchestrationHome,
	parentSessionId: string,
):
	| { readonly kind: "none" | "released" | "active" }
	| { readonly kind: "pending"; readonly phase: Exclude<SessionBundleDeletionPhase, "reserved"> } {
	const tombstone = orchestrationSessionDeletionFile(home, parentSessionId);
	return withFileLockSync(tombstone, () => {
		const marker = readMarker(tombstone, parentSessionId);
		if (marker?.policy !== "retention") {
			forgetRetentionInFlight(home, parentSessionId);
			return { kind: "none" } as const;
		}
		if (isReleasableRetention(home, marker)) {
			removeTombstone(home, tombstone, parentSessionId);
			return { kind: "released" } as const;
		}
		if (marker.operation && !canRecoverOperation(marker.operation)) return { kind: "active" } as const;
		const phase = tombstonePhase(home, parentSessionId, marker);
		if (phase === "reserved") return { kind: "active" } as const;
		return { kind: "pending", phase } as const;
	});
}

/**
 * The sessions whose retention tombstones `home`'s in-flight index names (`session-retention-index.ts`), each to be
 * confirmed with {@link inspectSessionBundleRetention}, and how many tombstones or entries could not be read. The first
 * call in a home with tombstones indexes the retention tombstones written before the index existed, once (a tombstone
 * that cannot be read or indexed is counted and left; admission still reads it); no other tombstone is read. A home
 * without tombstones is not written to.
 */
export async function sessionBundleRetentionsInFlight(
	home: OrchestrationHome,
): Promise<{ sessionIds: string[]; unreadable: number }> {
	const dir = orchestrationSessionDeletionsDir(home);
	if (!existsSync(dir)) return { sessionIds: [], unreadable: 0 };
	let unindexed = 0;
	if (!retentionIndexComplete(home)) {
		let read = 0;
		for (const name of readdirSync(dir)) {
			if (sessionKeyOfDeletionFile(name) === undefined) continue;
			// Every tombstone is read once, the permanent ones too: yield now and then.
			if (++read % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			if (!indexTombstone(home, join(dir, name))) unindexed++;
		}
		markRetentionIndexComplete(home);
	}
	const index = readRetentionIndex(home);
	return { sessionIds: index.sessionIds, unreadable: index.unreadable + unindexed };
}

/**
 * Indexes the tombstone `file` when it may be a retention (its policy is confirmed under the lock where the entry is
 * read: an entry whose tombstone settled meanwhile is stale and pruned there; one whose policy does not read is indexed,
 * so it is counted where it is read). Whether it was indexed or needs none; false when it names no session of its file,
 * or could not be read or indexed.
 */
function indexTombstone(home: OrchestrationHome, file: string): boolean {
	let parentSessionId: string | null | undefined;
	try {
		parentSessionId = recordedTombstone(file);
		if (parentSessionId === null) return true;
		if (parentSessionId === undefined || orchestrationSessionDeletionFile(home, parentSessionId) !== file)
			return false;
		recordRetentionInFlight(home, parentSessionId);
		return true;
	} catch (error) {
		harnessLog.warn("sessions", "a session bundle tombstone was not indexed", {
			file,
			detail: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/**
 * The session a tombstone file names for the index: null for a permanent tombstone or one gone since it was listed,
 * undefined when its content names none.
 */
function recordedTombstone(file: string): string | null | undefined {
	const text = readOptionalBoundedTextFileSync(file, MAX_MARKER_BYTES, "Session bundle deletion marker");
	if (text === undefined) return null;
	const value: unknown = JSON.parse(text);
	if (!isPlainRecord(value) || typeof value.parentSessionId !== "string") return undefined;
	return value.policy === "permanent" ? null : value.parentSessionId;
}

export type SessionBundleLockOptions = Pick<
	AtomicFileLockOptions,
	"retries" | "sleepSync" | "minRetryDelayMs" | "maxRetryDelayMs" | "retryFactor" | "stale"
>;

type BundleAdmissionResult<T> = { admitted: false } | { admitted: true; value: T };

/** Lock order is bundle admission, then transcript. No filesystem lock spans asynchronous removal. */
export function withSessionBundleAdmission<T>(
	home: OrchestrationHome,
	parentSessionId: string,
	operation: () => T,
	options?: SessionBundleLockOptions,
): T {
	const result = admitSessionBundle(home, parentSessionId, operation, options, true);
	if (!result.admitted) throw new Error("Worker session bundle deletion has been reserved.");
	return result.value;
}

/** Optional storage maintenance never revives or writes through a deletion reservation. */
export function withSessionBundleMaintenance<T>(
	home: OrchestrationHome,
	parentSessionId: string,
	operation: () => T,
	options?: SessionBundleLockOptions,
): BundleAdmissionResult<T> {
	return admitSessionBundle(home, parentSessionId, operation, options, false);
}

function admitSessionBundle<T>(
	home: OrchestrationHome,
	parentSessionId: string,
	operation: () => T,
	options: SessionBundleLockOptions | undefined,
	recoverCompletedRetention: boolean,
): BundleAdmissionResult<T> {
	const tombstone = orchestrationSessionDeletionFile(home, parentSessionId);
	if (hasCurrentSessionBundleAdmission(home, parentSessionId)) return { admitted: true, value: operation() };
	return withFileLockSync(
		tombstone,
		() => {
			const marker = readMarker(tombstone, parentSessionId);
			if (marker) {
				if (!recoverCompletedRetention) return { admitted: false };
				// A retention that never began removing leaves the bundle whole: opening the session releases it.
				let removalConfirmed = isReleasableRetention(home, marker);
				if (
					!removalConfirmed &&
					marker.policy === "retention" &&
					(!marker.operation || canRecoverOperation(marker.operation))
				) {
					try {
						lstatSync(orchestrationSessionDir(home, parentSessionId));
					} catch (error) {
						if (!isMissingFileError(error)) throw error;
						removalConfirmed = true;
					}
				}
				if (!removalConfirmed) return { admitted: false };
				// The original remover is settled/dead and its bundle is absent, or it never began removing. Recover an
				// interrupted marker cleanup here, or release the untouched bundle.
				removeTombstone(home, tombstone, parentSessionId);
			}
			const scope = currentSynchronousFileLockScope(tombstone)!;
			const key = scope.lockfilePath;
			admittedBundles.set(key, scope);
			try {
				return { admitted: true, value: operation() };
			} finally {
				admittedBundles.delete(key);
			}
		},
		{
			retries: options?.retries,
			sleepSync: options?.sleepSync,
			minRetryDelayMs: options?.minRetryDelayMs,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			retryFactor: options?.retryFactor,
			stale: options?.stale,
			borrowedScope: currentSynchronousFileLockScope(tombstone),
		},
	);
}

/** Serialize inspection and existing claim settlement without admitting creation into a deleted bundle. */
export function withSessionBundleInspection<T>(
	home: OrchestrationHome,
	parentSessionId: string,
	operation: () => T,
): T {
	const tombstone = orchestrationSessionDeletionFile(home, parentSessionId);
	return withFileLockSync(tombstone, operation, {
		borrowedScope: currentSynchronousFileLockScope(tombstone),
	});
}

/** Inspect a possibly absent bundle file without recreating its parent or bypassing concurrent writers. */
export function withSessionBundleFileInspection<T>(
	home: OrchestrationHome,
	parentSessionId: string,
	file: string,
	operation: () => T,
): T {
	return withSessionBundleInspection(home, parentSessionId, () => {
		let acquired = false;
		try {
			return withFileLockSync(
				file,
				() => {
					acquired = true;
					return operation();
				},
				{ createParentDirectories: false },
			);
		} catch (error) {
			if (acquired || !isMissingFileError(error)) throw error;
			// The file's parent is absent, and bundle exclusion blocks its writers. The caller
			// still validates absence; its own IO/identity errors are never treated as lock failure.
			return operation();
		}
	});
}

/** Reserve before any removal. Refused admission must not publish new destructive intent. */
export function reserveSessionBundleDeletion(
	home: OrchestrationHome,
	parentSessionId: string,
	policy: SessionBundleDeletionPolicy,
	canDelete: (existingPolicy: SessionBundleDeletionPolicy | undefined) => boolean,
	/** A caller that bypassed age checks must not acquire a fresh deletion after a stale hint. */
	requireExistingRetention = false,
): SessionBundleDeletionReservation | undefined {
	const tombstone = orchestrationSessionDeletionFile(home, parentSessionId);
	return withFileLockSync(tombstone, () => {
		const marker = readMarker(tombstone, parentSessionId);
		// A removal record left by a tombstone that went is stale: a new tombstone starts with its bundle whole.
		if (!marker) forgetRemovalBegun(home, parentSessionId);
		const phase = marker ? tombstonePhase(home, parentSessionId, marker) : "reserved";
		if (requireExistingRetention && !isPendingRetention(phase, marker)) return undefined;
		if (marker?.policy === "permanent" && policy === "retention") return undefined;
		if (marker?.operation && !canRecoverOperation(marker.operation)) return undefined;
		if (liveHolders(`${tombstone}.leases.json`, parentSessionId).length > 0) return undefined;
		if (!canDelete(marker?.policy)) return undefined;
		const token = randomUUID();
		const next: DeletionMarker = {
			schemaVersion: MARKER_SCHEMA_VERSION,
			parentSessionId,
			policy,
			// A resumed tombstone keeps how far its deletion went.
			operation: {
				token,
				owner: ownProcessOwner(),
				processInstanceId: PROCESS_INSTANCE_ID,
				fresh: phase === "reserved",
			},
		};
		activeOperations.add(token);
		try {
			writeTombstone(home, tombstone, next);
			return Object.freeze({ parentSessionId, token, phase });
		} catch (error) {
			activeOperations.delete(token);
			throw error;
		}
	});
}

/** Inspect artifact eligibility only while this exact permanent remover still owns the bundle. */
export function withPermanentSessionBundleDeletion<T>(
	home: OrchestrationHome,
	reservation: SessionBundleDeletionReservation,
	operation: () => T,
): T {
	return withReservedSessionBundleDeletion(home, reservation, "permanent", operation);
}

/** Expiry may settle existing obligations only for this exact active retention reservation. */
export function withSessionBundleRetention<T>(
	home: OrchestrationHome,
	parentSessionId: string,
	reservation: SessionBundleDeletionReservation,
	operation: () => T,
): T {
	if (reservation.parentSessionId !== parentSessionId)
		throw new Error("Session bundle retention belongs to another session.");
	return withReservedSessionBundleDeletion(home, reservation, "retention", operation);
}

function withReservedSessionBundleDeletion<T>(
	home: OrchestrationHome,
	reservation: SessionBundleDeletionReservation,
	policy: SessionBundleDeletionPolicy,
	operation: () => T,
): T {
	const tombstone = orchestrationSessionDeletionFile(home, reservation.parentSessionId);
	return withFileLockSync(tombstone, () => {
		const marker = readMarker(tombstone, reservation.parentSessionId);
		if (
			marker?.policy !== policy ||
			marker.operation?.token !== reservation.token ||
			!activeOperations.has(reservation.token)
		)
			throw new Error("Session bundle deletion ownership changed before reserved work.");
		return operation();
	});
}

/**
 * Records, under the tombstone's lock, that this retention's remover begins removing the bundle (the tombstone's
 * `.removing` sibling): called just before the first removal, so a tombstone still `reserved` proves the bundle whole.
 */
export function markSessionBundleRemoving(
	home: OrchestrationHome,
	reservation: SessionBundleDeletionReservation,
): void {
	withReservedSessionBundleDeletion(home, reservation, "retention", () => {
		if (!removalBegun(home, reservation.parentSessionId)) recordRemovalBegun(home, reservation.parentSessionId);
	});
}

/**
 * Settle only after physical removal ends. A failed/partial removal keeps the admission barrier. `released`: a
 * retention refused by something only the open session settles, which leaves its bundle openable whatever its phase
 * before removal began.
 */
export function settleSessionBundleDeletion(
	home: OrchestrationHome,
	reservation: SessionBundleDeletionReservation,
	outcome: "removed" | "deferred" | "retained" | "released",
): void {
	const tombstone = orchestrationSessionDeletionFile(home, reservation.parentSessionId);
	try {
		withFileLockSync(tombstone, () => {
			const marker = readMarker(tombstone, reservation.parentSessionId);
			if (!marker?.operation || marker.operation.token !== reservation.token) {
				throw new Error("Session bundle deletion ownership changed before settlement.");
			}
			// The durable reservation owns policy until physical removal and its settlement finish. A retention that
			// defers before touching anything leaves the bundle whole, so its tombstone goes; one that keeps its
			// barrier is resumed by the next expiry, with its phase.
			const phase = tombstonePhase(home, reservation.parentSessionId, marker);
			if (outcome === "released" && (marker.policy !== "retention" || phase === "removing"))
				throw new Error("Session bundle deletion cannot be released once its removal began.");
			if (
				marker.policy === "retention" &&
				(outcome === "removed" || outcome === "released" || (outcome === "deferred" && phase === "reserved"))
			) {
				removeTombstone(home, tombstone, reservation.parentSessionId);
			} else {
				writeTombstone(home, tombstone, {
					schemaVersion: MARKER_SCHEMA_VERSION,
					parentSessionId: marker.parentSessionId,
					policy: marker.policy,
				});
			}
		});
	} finally {
		// Even failed metadata settlement follows a physically settled operation. This exact process
		// can safely reclaim it; peers still need proven process absence before taking it over.
		activeOperations.delete(reservation.token);
	}
}
