import { createHash, randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, mkdirSync, unlinkSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { stateFile } from "../agent-paths.ts";
import {
	canonicalPathScopeIdentity,
	isPathWithinScope,
	pathScopesOverlap,
	safeRealpathSync,
} from "../autonomy/path-scope.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import { requireBoundedTrimmedText } from "../util/bounded-value.ts";
import { parseLocalWorkerProcessOwnerId } from "./worker-process-owner.ts";

const SCHEMA_VERSION = 1;
const MAX_IDENTIFIER_CHARS = 256;
const MAX_PATH_CHARS = 4096;
const MAX_SCOPES = 32;
const MAX_RESERVATIONS = 64;
const MAX_FILE_BYTES = 128 * 1024;
const availabilityListeners = new Map<string, Set<() => void>>();

type WatchDirectory = (
	directory: string,
	options: { persistent: boolean },
	listener: (eventType: string, fileName: string | Buffer | null) => void,
) => FSWatcher;

export interface WorkerWriteReservationWorkspace {
	/** Canonical repository/workspace root shared by primary and isolated worktrees. */
	repositoryRoot: string;
	/** Actual checkout used by this attempt. A non-primary checkout requires an isolation identity. */
	executionRoot: string;
	/** Durable worktree identity supplied by the worktree owner, never a model-provided label. */
	isolatedWorktreeId?: string;
}

export interface WorkerWriteReservationRequest {
	parentSessionId: string;
	/** Exact pi-owned process instance that acquired this reservation. */
	ownerId: string;
	taskId: string;
	attemptId: string;
	fencingToken: number;
	access: "read" | "write";
	workspace: WorkerWriteReservationWorkspace;
	/** Absolute authorized write roots. They are resolved before persistence. */
	writeScopes: readonly string[];
}

export interface WorkerWriteReservationLease {
	filePath: string;
	reservationId: string;
	parentSessionId: string;
	ownerId: string;
	taskId: string;
	attemptId: string;
	fencingToken: number;
	repositoryRoot: string;
	executionRoot: string;
	executionIdentity: string;
	isolatedWorktreeId?: string;
	writeScopes: readonly string[];
}

export type WorkerWriteReservationAcquireResult =
	| { kind: "granted"; lease?: WorkerWriteReservationLease }
	| {
			kind: "blocked";
			reasonCode: "overlapping_write_scope" | "attempt_reservation_conflict" | "reservation_capacity_reached";
			conflictingReservationIds?: readonly string[];
	  };

export type WorkerWriteReservationReleaseResult =
	| { kind: "released" }
	| { kind: "stale_fence" }
	| { kind: "not_found" };

export type WorkerWriteReservationEvidenceState = "live" | "not_live" | "unknown";

export interface WorkerWriteReservationRecoveryEvidence {
	reservationId: string;
	state: WorkerWriteReservationEvidenceState;
}

export interface WorkerWriteReservationRecoveryRequest {
	workspace: WorkerWriteReservationWorkspace;
	/** Caller-owned lease observations. This store never polls process state or worker output. */
	evidence: readonly WorkerWriteReservationRecoveryEvidence[];
}

export interface WorkerWriteReservationRecoveryOutcome {
	kind: "active" | "stale" | "inspection_required";
	reservationId: string;
	lease: WorkerWriteReservationLease;
}

interface PersistedReservation {
	reservationId: string;
	parentSessionId: string;
	ownerId: string;
	taskId: string;
	attemptId: string;
	fencingToken: number;
	repositoryRoot: string;
	executionRoot: string;
	executionIdentity: string;
	isolatedWorktreeId?: string;
	writeScopes: string[];
	createdAt: string;
}

interface PersistedReservationStore {
	schemaVersion: number;
	repositoryRoot: string;
	reservations: PersistedReservation[];
}

interface CanonicalWorkspace {
	repositoryRoot: string;
	executionRoot: string;
	executionIdentity: string;
	isolatedWorktreeId?: string;
}

function positiveFencingToken(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Fencing token must be a positive safe integer.");
	return value;
}

/**
 * Prefer a real path for filesystem-backed scopes, but preserve a foreign lexical path family
 * (for example a Windows drive path inspected from WSL) so shared path-scope helpers retain
 * their documented Windows drive/UNC comparison semantics.
 */
function canonicalRealOrLexicalPath(value: string, label: string): string {
	const lexical = canonicalPathScopeIdentity(requireBoundedTrimmedText(value, MAX_PATH_CHARS, label));
	const resolved = safeRealpathSync(lexical);
	return pathScopesOverlap(lexical, resolved) ? canonicalPathScopeIdentity(resolved) : lexical;
}

function canonicalWorkspace(workspace: WorkerWriteReservationWorkspace): CanonicalWorkspace {
	const repositoryRoot = canonicalRealOrLexicalPath(workspace.repositoryRoot, "Repository root");
	const executionRoot = canonicalRealOrLexicalPath(workspace.executionRoot, "Execution root");
	const isolatedWorktreeId = workspace.isolatedWorktreeId
		? requireBoundedTrimmedText(workspace.isolatedWorktreeId, MAX_IDENTIFIER_CHARS, "Isolated worktree id")
		: undefined;
	const isPrimaryExecutionRoot =
		isPathWithinScope(executionRoot, repositoryRoot) && isPathWithinScope(repositoryRoot, executionRoot);
	if (isPrimaryExecutionRoot && isolatedWorktreeId) {
		throw new TypeError("An isolated worktree execution root must differ from the shared repository root.");
	}
	if (!isPrimaryExecutionRoot && !isolatedWorktreeId) {
		throw new TypeError("A non-primary execution root requires an explicit isolated worktree identity.");
	}
	return {
		repositoryRoot,
		executionRoot,
		executionIdentity: isolatedWorktreeId ? `isolated:${executionRoot}` : `shared:${repositoryRoot}`,
		...(isolatedWorktreeId ? { isolatedWorktreeId } : {}),
	};
}

function reservationFile(agentDir: string, repositoryRoot: string): string {
	const digest = createHash("sha256")
		.update("pi-worker-write-reservations-v1")
		.update("\0")
		.update(repositoryRoot)
		.digest("hex");
	return stateFile(agentDir, "orchestration", "worker-write-reservations", `${digest}.json`);
}

function notifyAvailability(filePath: string): void {
	for (const listener of availabilityListeners.get(filePath) ?? []) queueMicrotask(listener);
}

function leaseFromRecord(filePath: string, record: PersistedReservation): WorkerWriteReservationLease {
	return {
		filePath,
		reservationId: record.reservationId,
		parentSessionId: record.parentSessionId,
		ownerId: record.ownerId,
		taskId: record.taskId,
		attemptId: record.attemptId,
		fencingToken: record.fencingToken,
		repositoryRoot: record.repositoryRoot,
		executionRoot: record.executionRoot,
		executionIdentity: record.executionIdentity,
		...(record.isolatedWorktreeId ? { isolatedWorktreeId: record.isolatedWorktreeId } : {}),
		writeScopes: [...record.writeScopes],
	};
}

function stringField(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string") throw new Error(`Worker write reservation ${label} is invalid.`);
	return requireBoundedTrimmedText(value, maximum, `Worker write reservation ${label}`);
}

function localOwnerId(value: unknown): string {
	const ownerId = stringField(value, "owner id", MAX_IDENTIFIER_CHARS);
	if (!parseLocalWorkerProcessOwnerId(ownerId)) throw new Error("Worker write reservation owner id is invalid.");
	return ownerId;
}

function parseReservation(value: unknown, repositoryRoot: string): PersistedReservation {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Worker write reservation entry is invalid.");
	const entry = value as Record<string, unknown>;
	const fencingToken = entry.fencingToken;
	if (typeof fencingToken !== "number") throw new Error("Worker write reservation fencing token is invalid.");
	const parsedRepositoryRoot = stringField(entry.repositoryRoot, "repository root", MAX_PATH_CHARS);
	if (parsedRepositoryRoot !== repositoryRoot)
		throw new Error("Worker write reservation repository root conflicts with its store.");
	if (!Array.isArray(entry.writeScopes) || entry.writeScopes.length === 0 || entry.writeScopes.length > MAX_SCOPES) {
		throw new Error("Worker write reservation scopes are invalid.");
	}
	const writeScopes = entry.writeScopes.map((scope) => stringField(scope, "write scope", MAX_PATH_CHARS));
	const isolatedWorktreeId =
		entry.isolatedWorktreeId === undefined
			? undefined
			: stringField(entry.isolatedWorktreeId, "isolated worktree id", MAX_IDENTIFIER_CHARS);
	return {
		reservationId: stringField(entry.reservationId, "id", MAX_IDENTIFIER_CHARS),
		parentSessionId: stringField(entry.parentSessionId, "parent session", MAX_IDENTIFIER_CHARS),
		ownerId: localOwnerId(entry.ownerId),
		taskId: stringField(entry.taskId, "task", MAX_IDENTIFIER_CHARS),
		attemptId: stringField(entry.attemptId, "attempt", MAX_IDENTIFIER_CHARS),
		fencingToken: positiveFencingToken(fencingToken),
		repositoryRoot: parsedRepositoryRoot,
		executionRoot: stringField(entry.executionRoot, "execution root", MAX_PATH_CHARS),
		executionIdentity: stringField(entry.executionIdentity, "execution identity", MAX_PATH_CHARS),
		...(isolatedWorktreeId ? { isolatedWorktreeId } : {}),
		writeScopes,
		createdAt: stringField(entry.createdAt, "created time", MAX_IDENTIFIER_CHARS),
	};
}

function parseStore(raw: string, repositoryRoot: string): PersistedReservationStore {
	if (Buffer.byteLength(raw, "utf-8") > MAX_FILE_BYTES)
		throw new Error("Worker write reservation store exceeds its byte limit.");
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("Worker write reservation store is unreadable; refusing concurrent write admission.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Worker write reservation store is invalid.");
	const store = value as Record<string, unknown>;
	if (store.schemaVersion !== SCHEMA_VERSION) throw new Error("Worker write reservation store schema is unsupported.");
	if (stringField(store.repositoryRoot, "store repository root", MAX_PATH_CHARS) !== repositoryRoot) {
		throw new Error("Worker write reservation store root conflicts with the requested workspace.");
	}
	if (!Array.isArray(store.reservations) || store.reservations.length > MAX_RESERVATIONS) {
		throw new Error("Worker write reservation store entries are invalid.");
	}
	const reservations = store.reservations.map((entry) => parseReservation(entry, repositoryRoot));
	if (new Set(reservations.map((entry) => entry.reservationId)).size !== reservations.length) {
		throw new Error("Worker write reservation store contains duplicate reservation identities.");
	}
	return { schemaVersion: SCHEMA_VERSION, repositoryRoot, reservations };
}

function writeStore(filePath: string, store: PersistedReservationStore): void {
	const serialized = `${JSON.stringify(store)}\n`;
	if (Buffer.byteLength(serialized, "utf-8") > MAX_FILE_BYTES) {
		throw new Error("Worker write reservation store would exceed its byte limit.");
	}
	writeFileAtomicSync(filePath, serialized, { mode: 0o600 });
}

function overlappingReservationIds(
	reservations: readonly PersistedReservation[],
	executionIdentity: string,
	writeScopes: readonly string[],
): string[] {
	const matches: string[] = [];
	for (const reservation of reservations) {
		if (reservation.executionIdentity !== executionIdentity) continue;
		if (
			reservation.writeScopes.some((reservedScope) =>
				writeScopes.some((requestedScope) => pathScopesOverlap(reservedScope, requestedScope)),
			)
		) {
			matches.push(reservation.reservationId);
		}
	}
	return matches;
}

/**
 * Cross-process, agent-owned admission seam for concurrent worker mutations. It owns only
 * reservations; lifecycle, process liveness, and terminal status remain controller concerns.
 */
export class WorkerWriteReservationStore {
	private readonly agentDir: string;
	private readonly watchDirectory: WatchDirectory;

	constructor(options: { agentDir: string; watchDirectory?: WatchDirectory }) {
		this.agentDir = requireBoundedTrimmedText(options.agentDir, MAX_PATH_CHARS, "Agent directory");
		this.watchDirectory = options.watchDirectory ?? watch;
	}

	acquire(request: WorkerWriteReservationRequest): WorkerWriteReservationAcquireResult {
		if (request.access === "read") return { kind: "granted" };
		if (request.access !== "write") throw new TypeError("Worker write reservation access must be read or write.");
		if (request.writeScopes.length === 0 || request.writeScopes.length > MAX_SCOPES) {
			throw new TypeError(`Write reservations require from 1 through ${MAX_SCOPES} write scopes.`);
		}
		const workspace = canonicalWorkspace(request.workspace);
		const writeScopes = [
			...new Set(request.writeScopes.map((scope) => canonicalRealOrLexicalPath(scope, "Write scope"))),
		].sort();
		if (writeScopes.some((scope) => !isPathWithinScope(scope, workspace.executionRoot))) {
			throw new TypeError("Write reservation scopes must be within the execution root.");
		}
		const parentSessionId = requireBoundedTrimmedText(
			request.parentSessionId,
			MAX_IDENTIFIER_CHARS,
			"Parent session id",
		);
		const ownerId = localOwnerId(request.ownerId);
		const taskId = requireBoundedTrimmedText(request.taskId, MAX_IDENTIFIER_CHARS, "Task id");
		const attemptId = requireBoundedTrimmedText(request.attemptId, MAX_IDENTIFIER_CHARS, "Attempt id");
		const fencingToken = positiveFencingToken(request.fencingToken);
		const filePath = reservationFile(this.agentDir, workspace.repositoryRoot);

		return withFileLockSync(filePath, () => {
			const store = this.readLocked(filePath, workspace.repositoryRoot);
			const matchingAttempt = store.reservations.find(
				(reservation) =>
					reservation.parentSessionId === parentSessionId &&
					reservation.ownerId === ownerId &&
					reservation.taskId === taskId &&
					reservation.attemptId === attemptId &&
					reservation.fencingToken === fencingToken,
			);
			if (matchingAttempt) {
				if (
					matchingAttempt.executionIdentity !== workspace.executionIdentity ||
					matchingAttempt.isolatedWorktreeId !== workspace.isolatedWorktreeId ||
					matchingAttempt.writeScopes.length !== writeScopes.length ||
					matchingAttempt.writeScopes.some((scope, index) => scope !== writeScopes[index])
				) {
					return { kind: "blocked", reasonCode: "attempt_reservation_conflict" };
				}
				return { kind: "granted", lease: leaseFromRecord(filePath, matchingAttempt) };
			}
			const conflicts = overlappingReservationIds(store.reservations, workspace.executionIdentity, writeScopes);
			if (conflicts.length > 0) {
				return { kind: "blocked", reasonCode: "overlapping_write_scope", conflictingReservationIds: conflicts };
			}
			if (store.reservations.length >= MAX_RESERVATIONS)
				return { kind: "blocked", reasonCode: "reservation_capacity_reached" };
			const record: PersistedReservation = {
				reservationId: randomUUID(),
				parentSessionId,
				ownerId,
				taskId,
				attemptId,
				fencingToken,
				repositoryRoot: workspace.repositoryRoot,
				executionRoot: workspace.executionRoot,
				executionIdentity: workspace.executionIdentity,
				...(workspace.isolatedWorktreeId ? { isolatedWorktreeId: workspace.isolatedWorktreeId } : {}),
				writeScopes,
				createdAt: new Date().toISOString(),
			};
			store.reservations.push(record);
			writeStore(filePath, store);
			return { kind: "granted", lease: leaseFromRecord(filePath, record) };
		});
	}

	release(lease: WorkerWriteReservationLease): WorkerWriteReservationReleaseResult {
		const repositoryRoot = requireBoundedTrimmedText(lease.repositoryRoot, MAX_PATH_CHARS, "Lease repository root");
		const ownerId = localOwnerId(lease.ownerId);
		const expectedFilePath = reservationFile(this.agentDir, repositoryRoot);
		if (lease.filePath !== expectedFilePath)
			throw new TypeError("Worker write reservation lease does not belong to this agent state.");
		return withFileLockSync(expectedFilePath, () => {
			const store = this.readLocked(expectedFilePath, repositoryRoot);
			const index = store.reservations.findIndex((reservation) => reservation.reservationId === lease.reservationId);
			if (index < 0) {
				const supersedingReservation = store.reservations.some(
					(reservation) =>
						reservation.parentSessionId === lease.parentSessionId &&
						reservation.ownerId === ownerId &&
						reservation.taskId === lease.taskId &&
						reservation.fencingToken > lease.fencingToken,
				);
				return { kind: supersedingReservation ? "stale_fence" : "not_found" };
			}
			const record = store.reservations[index];
			if (
				record.parentSessionId !== lease.parentSessionId ||
				record.ownerId !== ownerId ||
				record.taskId !== lease.taskId ||
				record.attemptId !== lease.attemptId ||
				record.fencingToken !== lease.fencingToken ||
				record.executionIdentity !== lease.executionIdentity ||
				record.isolatedWorktreeId !== lease.isolatedWorktreeId
			) {
				return { kind: "stale_fence" };
			}
			store.reservations.splice(index, 1);
			if (store.reservations.length === 0) unlinkSync(expectedFilePath);
			else writeStore(expectedFilePath, store);
			notifyAvailability(expectedFilePath);
			return { kind: "released" };
		});
	}

	/** Event-driven cross-process wakeup for queued write admission; caller owns disposal. */
	watchAvailability(workspace: WorkerWriteReservationWorkspace, listener: () => void): () => void {
		const canonical = canonicalWorkspace(workspace);
		const filePath = reservationFile(this.agentDir, canonical.repositoryRoot);
		const listeners = availabilityListeners.get(filePath) ?? new Set<() => void>();
		availabilityListeners.set(filePath, listeners);
		listeners.add(listener);
		const directory = dirname(filePath);
		mkdirSync(directory, { recursive: true });
		let scheduled = false;
		const schedule = () => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(() => {
				scheduled = false;
				listener();
			});
		};
		const watcher = this.watchDirectory(directory, { persistent: false }, (_eventType, fileName) => {
			// Node may omit a filename (notably on Windows), or provide a Buffer when the watcher is
			// configured that way. An unknown filename is conservatively treated as a wake signal: the
			// scheduler re-evaluates durable admission, so this cannot grant access by itself.
			if (fileName === null) {
				schedule();
				return;
			}
			const normalizedName = Buffer.isBuffer(fileName) ? fileName.toString("utf-8") : fileName;
			if (normalizedName === basename(filePath)) schedule();
		});
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) availabilityListeners.delete(filePath);
			watcher.close();
		};
	}

	recover(request: WorkerWriteReservationRecoveryRequest): { outcomes: WorkerWriteReservationRecoveryOutcome[] } {
		const workspace = canonicalWorkspace(request.workspace);
		const filePath = reservationFile(this.agentDir, workspace.repositoryRoot);
		const evidence = new Map<string, WorkerWriteReservationEvidenceState>();
		for (const observation of request.evidence) {
			const reservationId = requireBoundedTrimmedText(
				observation.reservationId,
				MAX_IDENTIFIER_CHARS,
				"Reservation evidence id",
			);
			if (observation.state !== "live" && observation.state !== "not_live" && observation.state !== "unknown") {
				throw new TypeError("Reservation evidence state must be live, not_live, or unknown.");
			}
			if (evidence.has(reservationId)) throw new TypeError("Reservation evidence must not repeat an identity.");
			evidence.set(reservationId, observation.state);
		}
		return withFileLockSync(filePath, () => {
			const store = this.readLocked(filePath, workspace.repositoryRoot);
			const outcomes = store.reservations
				.filter((reservation) => reservation.executionIdentity === workspace.executionIdentity)
				.map((reservation): WorkerWriteReservationRecoveryOutcome => {
					const state = evidence.get(reservation.reservationId);
					return {
						kind: state === "live" ? "active" : state === "not_live" ? "stale" : "inspection_required",
						reservationId: reservation.reservationId,
						lease: leaseFromRecord(filePath, reservation),
					};
				});
			return { outcomes };
		});
	}

	private readLocked(filePath: string, repositoryRoot: string): PersistedReservationStore {
		if (!existsSync(filePath)) return { schemaVersion: SCHEMA_VERSION, repositoryRoot, reservations: [] };
		return parseStore(
			readBoundedTextFileSync(filePath, MAX_FILE_BYTES, "Worker write reservation store"),
			repositoryRoot,
		);
	}
}
