import { randomUUID } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { probeProcessLiveness } from "../reliability/process-tree.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../storage/atomic-file.ts";
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
	host: string;
	pid: number;
	processInstanceId: string;
	/** Only this operation created the absent marker; a resumed operation never inherits it. */
	fresh: boolean;
}

interface DeletionMarker {
	schemaVersion: 2;
	parentSessionId: string;
	policy: SessionBundleDeletionPolicy;
	operation?: DeletionOperation;
}

const MAX_MARKER_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROCESS_INSTANCE_ID = randomUUID();
const activeOperations = new Set<string>();

interface BundleHolder {
	token: string;
	host: string;
	pid: number;
	processInstanceId: string;
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
		value.schemaVersion !== 1 ||
		value.parentSessionId !== parentSessionId ||
		!Array.isArray(value.holders) ||
		value.holders.length > MAX_BUNDLE_HOLDERS
	)
		throw new Error("Session bundle lifetime leases require inspection.");
	const tokens = new Set<string>();
	for (const holder of value.holders) {
		if (
			!isPlainRecord(holder) ||
			Object.keys(holder).length !== 4 ||
			typeof holder.token !== "string" ||
			!UUID_PATTERN.test(holder.token) ||
			tokens.has(holder.token) ||
			typeof holder.processInstanceId !== "string" ||
			!UUID_PATTERN.test(holder.processInstanceId) ||
			typeof holder.host !== "string" ||
			!holder.host ||
			holder.host.length > 512 ||
			typeof holder.pid !== "number" ||
			!Number.isSafeInteger(holder.pid) ||
			holder.pid < 1
		)
			throw new Error("Session bundle lifetime lease identity is invalid.");
		tokens.add(holder.token);
	}
	return value.holders as BundleHolder[];
}

function writeHolders(file: string, parentSessionId: string, holders: BundleHolder[]): void {
	if (holders.length === 0) {
		unlinkSync(file);
		return;
	}
	const text = `${JSON.stringify({ schemaVersion: 1, parentSessionId, holders })}\n`;
	if (Buffer.byteLength(text) > MAX_HOLDER_BYTES) throw new Error("Session bundle lifetime leases are too large.");
	writeFileAtomicSync(file, text);
}

function liveHolders(file: string, parentSessionId: string): BundleHolder[] {
	const holders = readHolders(file, parentSessionId);
	const live = holders.filter((holder) => holder.host !== hostname() || probeProcessLiveness(holder.pid) !== "dead");
	if (live.length !== holders.length) writeHolders(file, parentSessionId, live);
	return live;
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
		host: hostname(),
		pid: process.pid,
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
		value.schemaVersion !== 2 ||
		value.parentSessionId !== parentSessionId ||
		(value.policy !== "retention" && value.policy !== "permanent") ||
		Object.keys(value).some((key) => !["schemaVersion", "parentSessionId", "policy", "operation"].includes(key))
	) {
		throw new Error("Session bundle deletion marker requires inspection; its ownership or policy is unknown.");
	}
	const operation = value.operation;
	if (
		operation !== undefined &&
		(!isPlainRecord(operation) ||
			Object.keys(operation).length !== 5 ||
			typeof operation.token !== "string" ||
			!UUID_PATTERN.test(operation.token) ||
			typeof operation.processInstanceId !== "string" ||
			!UUID_PATTERN.test(operation.processInstanceId) ||
			typeof operation.host !== "string" ||
			!operation.host ||
			operation.host.length > 512 ||
			typeof operation.pid !== "number" ||
			!Number.isSafeInteger(operation.pid) ||
			operation.pid < 1 ||
			typeof operation.fresh !== "boolean")
	) {
		throw new Error("Session bundle deletion operation is invalid.");
	}
	return value as unknown as DeletionMarker;
}

function writeMarker(file: string, marker: DeletionMarker): void {
	const text = `${JSON.stringify(marker)}\n`;
	if (Buffer.byteLength(text) > MAX_MARKER_BYTES) throw new Error("Session bundle deletion marker is too large.");
	writeFileAtomicSync(file, text);
}

function canRecoverOperation(operation: DeletionOperation): boolean {
	if (operation.host !== hostname()) return false;
	if (operation.pid === process.pid && operation.processInstanceId === PROCESS_INSTANCE_ID) {
		return !activeOperations.has(operation.token);
	}
	return probeProcessLiveness(operation.pid) === "dead";
}

/** A retained cleanup already passed age admission; its own partial writes do not restart that age. */
export function hasPendingSessionBundleRetention(agentDir: string, parentSessionId: string): boolean {
	return (
		readMarker(orchestrationSessionDeletionFile(agentDir, parentSessionId), parentSessionId)?.policy === "retention"
	);
}

/** Lock order is bundle admission, then transcript. No filesystem lock spans asynchronous removal. */
export function withSessionBundleAdmission<T>(agentDir: string, parentSessionId: string, operation: () => T): T {
	const tombstone = orchestrationSessionDeletionFile(agentDir, parentSessionId);
	return withFileLockSync(tombstone, () => {
		const marker = readMarker(tombstone, parentSessionId);
		if (marker) {
			let removalConfirmed = false;
			if (marker.policy === "retention" && (!marker.operation || canRecoverOperation(marker.operation))) {
				try {
					lstatSync(orchestrationSessionDir(agentDir, parentSessionId));
				} catch (error) {
					if (!isMissingFileError(error)) throw error;
					removalConfirmed = true;
				}
			}
			if (!removalConfirmed) throw new Error("Worker session bundle deletion has been reserved.");
			// The original remover is settled/dead and its bundle is absent. Recover an interrupted
			// marker cleanup here: a directory-only sweep can no longer discover this completed removal.
			unlinkSync(tombstone);
		}
		return operation();
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
			schemaVersion: 2,
			parentSessionId,
			policy,
			operation: { token, host: hostname(), pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID, fresh },
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
	const tombstone = orchestrationSessionDeletionFile(agentDir, reservation.parentSessionId);
	return withFileLockSync(tombstone, () => {
		const marker = readMarker(tombstone, reservation.parentSessionId);
		if (
			marker?.policy !== "permanent" ||
			marker.operation?.token !== reservation.token ||
			!activeOperations.has(reservation.token)
		)
			throw new Error("Permanent session bundle deletion ownership changed before inspection.");
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
					schemaVersion: 2,
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
