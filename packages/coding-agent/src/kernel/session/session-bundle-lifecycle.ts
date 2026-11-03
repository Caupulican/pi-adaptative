import { randomUUID } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
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
import { orchestrationSessionDeletionFile, orchestrationSessionDir } from "./session-bundle-paths.ts";

export type SessionBundleDeletionPolicy = "retention" | "permanent";

export interface SessionBundleDeletionReservation {
	readonly parentSessionId: string;
	readonly token: string;
}

interface DeletionOperation {
	token: string;
	/** The remover process, judged by {@link judgeOwner} before anyone else may recover the operation. */
	owner: ProcessOwner;
	processInstanceId: string;
	/** Only this operation created the absent marker; a resumed operation never inherits it. */
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

export function hasCurrentSessionBundleAdmission(agentDir: string, parentSessionId: string): boolean {
	const file = orchestrationSessionDeletionFile(agentDir, parentSessionId);
	const scope = currentSynchronousFileLockScope(file);
	return scope !== undefined && admittedBundles.get(scope.lockfilePath) === scope;
}

interface BundleHolder {
	token: string;
	/** The holding process, judged by {@link judgeOwner}; only a `dead` holder stops serving the session. */
	owner: ProcessOwner;
	processInstanceId: string;
}

/** Schema 2 records each holder as a {@link ProcessOwner}; schema 1 (`host` + `pid`) is still read. */
const HOLDERS_SCHEMA_VERSION = 2;
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
	readonly agentDir: string;
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
		(value.schemaVersion !== 1 && value.schemaVersion !== HOLDERS_SCHEMA_VERSION) ||
		value.parentSessionId !== parentSessionId ||
		!Array.isArray(value.holders) ||
		value.holders.length > MAX_BUNDLE_HOLDERS
	)
		throw new Error("Session bundle lifetime leases require inspection.");
	const legacy = value.schemaVersion === 1;
	const tokens = new Set<string>();
	const holders: BundleHolder[] = [];
	for (const holder of value.holders) {
		const owner = isPlainRecord(holder) ? parseRecordedOwner(holder, legacy) : undefined;
		if (
			!isPlainRecord(holder) ||
			!owner ||
			Object.keys(holder).length !== (legacy ? 4 : 3) ||
			typeof holder.token !== "string" ||
			!UUID_PATTERN.test(holder.token) ||
			tokens.has(holder.token) ||
			typeof holder.processInstanceId !== "string" ||
			!UUID_PATTERN.test(holder.processInstanceId)
		)
			throw new Error("Session bundle lifetime lease identity is invalid.");
		tokens.add(holder.token);
		holders.push({ token: holder.token, owner, processInstanceId: holder.processInstanceId });
	}
	return holders;
}

function writeHolders(file: string, parentSessionId: string, holders: BundleHolder[]): void {
	if (holders.length === 0) {
		unlinkSync(file);
		return;
	}
	const text = `${JSON.stringify({ schemaVersion: HOLDERS_SCHEMA_VERSION, parentSessionId, holders })}\n`;
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

/** One process currently holding a lifetime lease on a persisted session, as {@link readSessionLeaseHolders} sees it. */
export interface SessionLeaseHolder {
	readonly owner: ProcessOwner;
	readonly processInstanceId: string;
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
export function readSessionLeaseHolders(agentDir: string, parentSessionId: string): SessionLeaseHolder[] {
	const file = `${orchestrationSessionDeletionFile(resolve(agentDir), parentSessionId)}.leases.json`;
	return readHolders(file, parentSessionId).map((holder) => ({
		owner: holder.owner,
		processInstanceId: holder.processInstanceId,
		standing: judgeOwner(holder.owner),
		self: holder.processInstanceId === PROCESS_INSTANCE_ID,
	}));
}

function releaseBundleLease(state: BundleLeaseState): void {
	if (state.status === "released") return;
	const tombstone = orchestrationSessionDeletionFile(state.agentDir, state.parentSessionId);
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

export function acquireSessionBundleLease(agentDir: string, parentSessionId: string): SessionBundleLease {
	const directory = resolve(agentDir);
	const tombstone = orchestrationSessionDeletionFile(directory, parentSessionId);
	const file = `${tombstone}.leases.json`;
	const holder: BundleHolder = {
		token: randomUUID(),
		owner: ownProcessOwner(),
		processInstanceId: PROCESS_INSTANCE_ID,
	};
	withSessionBundleAdmission(directory, parentSessionId, () => {
		const holders = liveHolders(file, parentSessionId);
		if (holders.length >= MAX_BUNDLE_HOLDERS) throw new Error("Session bundle lifetime lease capacity reached.");
		writeHolders(file, parentSessionId, [...holders, holder]);
	});
	const state: BundleLeaseState = { agentDir: directory, parentSessionId, holder, claimed: false, status: "held" };
	const lease: SessionBundleLease = Object.freeze({
		release() {
			if (state.claimed) throw new Error("The session owns this bundle lease; close the session to release it.");
			releaseBundleLease(state);
		},
	});
	bundleLeases.set(lease, state);
	return lease;
}

/** Direct construction must transfer a real, unclaimed hold for this exact persisted session. */
export function claimSessionBundleLease(
	lease: SessionBundleLease | undefined,
	agentDir: string,
	parentSessionId: string,
	persisted: boolean,
): SessionBundleLease | undefined {
	if (!persisted && lease === undefined) return;
	const state = lease && bundleLeases.get(lease);
	if (
		state?.status !== "held" ||
		state.claimed ||
		state.agentDir !== resolve(agentDir) ||
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

/** Bridge retirement and activation, retaining both sessions through rollback and unwinding partial acquisition. */
export async function withSessionBundleLeases<T>(
	agentDir: string,
	sessionIds: readonly string[],
	operation: () => Promise<T>,
): Promise<T> {
	const leases: SessionBundleLease[] = [];
	const releaseFailures: unknown[] = [];
	let operationFailure: { error: unknown } | undefined;
	let result: T | undefined;
	try {
		for (const id of new Set(sessionIds)) leases.push(acquireSessionBundleLease(agentDir, id));
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

/** This process may take over an operation it finished itself, or one whose remover is PROVEN gone. */
function canRecoverOperation(operation: DeletionOperation): boolean {
	if (operation.owner.pid === process.pid && operation.processInstanceId === PROCESS_INSTANCE_ID) {
		return !activeOperations.has(operation.token);
	}
	return judgeOwner(operation.owner) === "dead";
}

/** A retained cleanup already passed age admission; its own partial writes do not restart that age. */
export function hasPendingSessionBundleRetention(agentDir: string, parentSessionId: string): boolean {
	return (
		readMarker(orchestrationSessionDeletionFile(agentDir, parentSessionId), parentSessionId)?.policy === "retention"
	);
}

export type SessionBundleLockOptions = Pick<
	AtomicFileLockOptions,
	"retries" | "sleepSync" | "minRetryDelayMs" | "maxRetryDelayMs" | "retryFactor" | "stale"
>;

type BundleAdmissionResult<T> = { admitted: false } | { admitted: true; value: T };

/** Lock order is bundle admission, then transcript. No filesystem lock spans asynchronous removal. */
export function withSessionBundleAdmission<T>(
	agentDir: string,
	parentSessionId: string,
	operation: () => T,
	options?: SessionBundleLockOptions,
): T {
	const result = admitSessionBundle(agentDir, parentSessionId, operation, options, true);
	if (!result.admitted) throw new Error("Worker session bundle deletion has been reserved.");
	return result.value;
}

/** Optional storage maintenance never revives or writes through a deletion reservation. */
export function withSessionBundleMaintenance<T>(
	agentDir: string,
	parentSessionId: string,
	operation: () => T,
	options?: SessionBundleLockOptions,
): BundleAdmissionResult<T> {
	return admitSessionBundle(agentDir, parentSessionId, operation, options, false);
}

function admitSessionBundle<T>(
	agentDir: string,
	parentSessionId: string,
	operation: () => T,
	options: SessionBundleLockOptions | undefined,
	recoverCompletedRetention: boolean,
): BundleAdmissionResult<T> {
	const tombstone = orchestrationSessionDeletionFile(agentDir, parentSessionId);
	if (hasCurrentSessionBundleAdmission(agentDir, parentSessionId)) return { admitted: true, value: operation() };
	return withFileLockSync(
		tombstone,
		() => {
			const marker = readMarker(tombstone, parentSessionId);
			if (marker) {
				if (!recoverCompletedRetention) return { admitted: false };
				let removalConfirmed = false;
				if (marker.policy === "retention" && (!marker.operation || canRecoverOperation(marker.operation))) {
					try {
						lstatSync(orchestrationSessionDir(agentDir, parentSessionId));
					} catch (error) {
						if (!isMissingFileError(error)) throw error;
						removalConfirmed = true;
					}
				}
				if (!removalConfirmed) return { admitted: false };
				// The original remover is settled/dead and its bundle is absent. Recover an interrupted
				// marker cleanup here: a directory-only sweep can no longer discover this completed removal.
				unlinkSync(tombstone);
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
export function withSessionBundleInspection<T>(agentDir: string, parentSessionId: string, operation: () => T): T {
	const tombstone = orchestrationSessionDeletionFile(agentDir, parentSessionId);
	return withFileLockSync(tombstone, operation, {
		borrowedScope: currentSynchronousFileLockScope(tombstone),
	});
}

/** Inspect a possibly absent bundle file without recreating its parent or bypassing concurrent writers. */
export function withSessionBundleFileInspection<T>(
	agentDir: string,
	parentSessionId: string,
	file: string,
	operation: () => T,
): T {
	return withSessionBundleInspection(agentDir, parentSessionId, () => {
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
	agentDir: string,
	parentSessionId: string,
	policy: SessionBundleDeletionPolicy,
	canDelete: (existingPolicy: SessionBundleDeletionPolicy | undefined) => boolean,
	/** A caller that bypassed age checks must not acquire a fresh deletion after a stale hint. */
	requireExistingRetention = false,
): SessionBundleDeletionReservation | undefined {
	const tombstone = orchestrationSessionDeletionFile(agentDir, parentSessionId);
	return withFileLockSync(tombstone, () => {
		const marker = readMarker(tombstone, parentSessionId);
		if (requireExistingRetention && marker?.policy !== "retention") return undefined;
		const fresh = marker === undefined;
		if (marker?.policy === "permanent" && policy === "retention") return undefined;
		if (marker?.operation && !canRecoverOperation(marker.operation)) return undefined;
		if (liveHolders(`${tombstone}.leases.json`, parentSessionId).length > 0) return undefined;
		if (!canDelete(marker?.policy)) return undefined;
		const token = randomUUID();
		const next: DeletionMarker = {
			schemaVersion: MARKER_SCHEMA_VERSION,
			parentSessionId,
			policy,
			operation: { token, owner: ownProcessOwner(), processInstanceId: PROCESS_INSTANCE_ID, fresh },
		};
		activeOperations.add(token);
		try {
			writeMarker(tombstone, next);
			return Object.freeze({ parentSessionId, token });
		} catch (error) {
			activeOperations.delete(token);
			throw error;
		}
	});
}

/** Inspect artifact eligibility only while this exact permanent remover still owns the bundle. */
export function withPermanentSessionBundleDeletion<T>(
	agentDir: string,
	reservation: SessionBundleDeletionReservation,
	operation: () => T,
): T {
	return withReservedSessionBundleDeletion(agentDir, reservation, "permanent", operation);
}

/** Expiry may settle existing obligations only for this exact active retention reservation. */
export function withSessionBundleRetention<T>(
	agentDir: string,
	parentSessionId: string,
	reservation: SessionBundleDeletionReservation,
	operation: () => T,
): T {
	if (reservation.parentSessionId !== parentSessionId)
		throw new Error("Session bundle retention belongs to another session.");
	return withReservedSessionBundleDeletion(agentDir, reservation, "retention", operation);
}

function withReservedSessionBundleDeletion<T>(
	agentDir: string,
	reservation: SessionBundleDeletionReservation,
	policy: SessionBundleDeletionPolicy,
	operation: () => T,
): T {
	const tombstone = orchestrationSessionDeletionFile(agentDir, reservation.parentSessionId);
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

/** Settle only after physical removal ends. A failed/partial removal keeps the admission barrier. */
export function settleSessionBundleDeletion(
	agentDir: string,
	reservation: SessionBundleDeletionReservation,
	outcome: "removed" | "deferred" | "retained",
): void {
	const tombstone = orchestrationSessionDeletionFile(agentDir, reservation.parentSessionId);
	try {
		withFileLockSync(tombstone, () => {
			const marker = readMarker(tombstone, reservation.parentSessionId);
			if (!marker?.operation || marker.operation.token !== reservation.token) {
				throw new Error("Session bundle deletion ownership changed before settlement.");
			}
			// The durable reservation owns policy until physical removal and its settlement finish.
			if (
				marker.policy === "retention" &&
				(outcome === "removed" || (outcome === "deferred" && marker.operation.fresh))
			) {
				unlinkSync(tombstone);
			} else {
				writeMarker(tombstone, {
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
