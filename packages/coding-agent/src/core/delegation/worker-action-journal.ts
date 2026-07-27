import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { workerActionJournalFile } from "../agent-paths.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import { requireBoundedTrimmedText } from "../util/bounded-value.ts";

const JOURNAL_SCHEMA_VERSION = 1;
const MAX_IDENTIFIER_CHARS = 256;
const MAX_TARGET_CHARS = 2048;
const MAX_REASON_CHARS = 512;
const MAX_EVIDENCE_POINTER_CHARS = 512;
const MAX_ENTRIES = 64;
const MAX_JOURNAL_BYTES = 256 * 1024;

export type WorkerActionJournalState = "not_started" | "unknown" | "succeeded" | "failed";

export interface WorkerActionJournalScope {
	agentDir: string;
	parentSessionId: string;
	taskId: string;
	attemptId: string;
	fencingToken: number;
}

export interface WorkerActionJournalAction {
	op: "write" | "edit";
	path: string;
	content?: string;
	old?: string;
	new?: string;
}

export interface BeginWorkerActionInput {
	index: number;
	action: WorkerActionJournalAction;
	/** Realpath-resolved target used by the executor, never model-provided text alone. */
	targetPath: string;
}

export interface WorkerActionExecutionPermit {
	kind: "execute";
	state: "not_started";
	actionId: string;
	actionDigest: string;
	normalizedTarget: string;
}

export interface WorkerActionInspectionRequired {
	kind: "inspection_required";
	state: Exclude<WorkerActionJournalState, "not_started">;
	actionId: string;
	actionDigest: string;
	normalizedTarget: string;
	reasonCode: string;
	evidencePointer?: string;
}

export type BeginWorkerActionResult = WorkerActionExecutionPermit | WorkerActionInspectionRequired;

export interface WorkerActionJournalInspection {
	state: WorkerActionJournalState;
	actionId: string;
	actionDigest?: string;
	normalizedTarget?: string;
	reasonCode?: string;
	evidencePointer?: string;
}

interface PersistedJournalEntry {
	actionId: string;
	actionDigest: string;
	index: number;
	attemptId: string;
	fencingToken: number;
	operation: "write" | "edit";
	normalizedTarget: string;
	status: "intent" | "succeeded" | "failed";
	createdAt: string;
	updatedAt: string;
	reasonCode?: string;
	evidencePointer?: string;
}

interface PersistedJournal {
	schemaVersion: number;
	scope: WorkerActionJournalIdentity;
	entries: PersistedJournalEntry[];
}

interface WorkerActionJournalIdentity {
	parentSessionId: string;
	taskId: string;
}

function safeFencingToken(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new TypeError("Worker action journal fencing token must be a positive safe integer.");
	return value;
}

function validateScope(scope: WorkerActionJournalScope): Omit<WorkerActionJournalScope, "agentDir"> {
	return {
		parentSessionId: requireBoundedTrimmedText(scope.parentSessionId, MAX_IDENTIFIER_CHARS, "Parent session id"),
		taskId: requireBoundedTrimmedText(scope.taskId, MAX_IDENTIFIER_CHARS, "Task id"),
		attemptId: requireBoundedTrimmedText(scope.attemptId, MAX_IDENTIFIER_CHARS, "Attempt id"),
		fencingToken: safeFencingToken(scope.fencingToken),
	};
}

function journalIdentity(scope: Omit<WorkerActionJournalScope, "agentDir">): WorkerActionJournalIdentity {
	return { parentSessionId: scope.parentSessionId, taskId: scope.taskId };
}

function scopeDigest(scope: WorkerActionJournalIdentity): string {
	return createHash("sha256")
		.update("pi-worker-action-journal-scope-v1")
		.update("\0")
		.update(scope.parentSessionId)
		.update("\0")
		.update(scope.taskId)
		.update("\0")
		.digest("hex");
}

function usesWindowsPath(value: string): boolean {
	return /^[a-zA-Z]:([\\/]|$)/.test(value) || value.startsWith("\\\\") || value.startsWith("//");
}

/** Canonical lexical identity for an already-authorized real target, including native Windows paths. */
export function normalizeWorkerActionTarget(cwd: string, targetPath: string): string {
	const pathApi = usesWindowsPath(cwd) || usesWindowsPath(targetPath) ? path.win32 : path.posix;
	const normalized = pathApi.resolve(cwd, targetPath);
	return pathApi === path.win32 ? normalized.toLowerCase() : normalized;
}

function actionDigest(input: BeginWorkerActionInput, normalizedTarget: string): string {
	const hash = createHash("sha256");
	hash.update("pi-worker-action-v1");
	hash.update("\0");
	hash.update(input.action.op);
	hash.update("\0");
	hash.update(normalizedTarget);
	hash.update("\0");
	if (input.action.op === "write") {
		hash.update(input.action.content ?? "");
	} else {
		hash.update(input.action.old ?? "");
		hash.update("\0");
		hash.update(input.action.new ?? "");
	}
	return hash.digest("hex");
}

function actionId(scope: Omit<WorkerActionJournalScope, "agentDir">, index: number, digest: string): string {
	return createHash("sha256")
		.update("pi-worker-action-id-v1")
		.update("\0")
		.update(scope.attemptId)
		.update("\0")
		.update(String(scope.fencingToken))
		.update("\0")
		.update(String(index))
		.update("\0")
		.update(digest)
		.digest("hex")
		.slice(0, 40);
}

function stringValue(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
		throw new Error(`Worker action journal ${label} is invalid.`);
	}
	return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Worker action journal ${label} is invalid.`);
	return value as Record<string, unknown>;
}

function parseEntry(value: unknown): PersistedJournalEntry {
	const entry = objectValue(value, "entry");
	const index = entry.index;
	if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
		throw new Error("Worker action journal entry index is invalid.");
	const parsedIndex = index;
	const operation = entry.operation;
	const status = entry.status;
	if (
		(operation !== "write" && operation !== "edit") ||
		(status !== "intent" && status !== "succeeded" && status !== "failed")
	) {
		throw new Error("Worker action journal entry shape is invalid.");
	}
	const reasonCode = entry.reasonCode;
	const evidencePointer = entry.evidencePointer;
	if (reasonCode !== undefined && (typeof reasonCode !== "string" || reasonCode.length > MAX_REASON_CHARS)) {
		throw new Error("Worker action journal entry reason is invalid.");
	}
	if (
		evidencePointer !== undefined &&
		(typeof evidencePointer !== "string" || evidencePointer.length > MAX_EVIDENCE_POINTER_CHARS)
	) {
		throw new Error("Worker action journal entry evidence pointer is invalid.");
	}
	return {
		actionId: stringValue(entry.actionId, "entry action id", 128),
		actionDigest: stringValue(entry.actionDigest, "entry action digest", 128),
		index: parsedIndex,
		attemptId: stringValue(entry.attemptId, "entry attempt id", MAX_IDENTIFIER_CHARS),
		fencingToken: safeFencingToken(entry.fencingToken),
		operation,
		normalizedTarget: stringValue(entry.normalizedTarget, "entry target", MAX_TARGET_CHARS),
		status,
		createdAt: stringValue(entry.createdAt, "entry created time", 128),
		updatedAt: stringValue(entry.updatedAt, "entry updated time", 128),
		...(reasonCode ? { reasonCode } : {}),
		...(evidencePointer ? { evidencePointer } : {}),
	};
}

function parseJournal(value: unknown, expectedScope: WorkerActionJournalIdentity): PersistedJournal {
	const journal = objectValue(value, "document");
	if (journal.schemaVersion !== JOURNAL_SCHEMA_VERSION)
		throw new Error("Worker action journal schema is unsupported.");
	const scope = objectValue(journal.scope, "scope");
	const parsedScope = {
		parentSessionId: stringValue(scope.parentSessionId, "scope parent session", MAX_IDENTIFIER_CHARS),
		taskId: stringValue(scope.taskId, "scope task", MAX_IDENTIFIER_CHARS),
	};
	if (parsedScope.parentSessionId !== expectedScope.parentSessionId || parsedScope.taskId !== expectedScope.taskId) {
		throw new Error("Worker action journal scope conflicts with the current fenced attempt.");
	}
	if (!Array.isArray(journal.entries) || journal.entries.length > MAX_ENTRIES) {
		throw new Error("Worker action journal entries are invalid.");
	}
	const entries = journal.entries.map(parseEntry);
	if (new Set(entries.map((entry) => entry.actionId)).size !== entries.length) {
		throw new Error("Worker action journal contains duplicate action identities.");
	}
	return { schemaVersion: JOURNAL_SCHEMA_VERSION, scope: parsedScope, entries };
}

function now(): string {
	return new Date().toISOString();
}

/**
 * Durable intent/receipt journal for model-emitted structured mutations. It deliberately records
 * only action digests and normalized targets; operation payloads can contain source text or secrets
 * and must never leave the model result in persisted orchestration state.
 */
export class WorkerActionJournal {
	readonly agentDir: string;
	readonly filePath: string;
	private readonly scope: Omit<WorkerActionJournalScope, "agentDir">;
	private readonly identity: WorkerActionJournalIdentity;

	constructor(scope: WorkerActionJournalScope) {
		this.agentDir = requireBoundedTrimmedText(scope.agentDir, MAX_TARGET_CHARS, "Agent directory");
		this.scope = validateScope(scope);
		this.identity = journalIdentity(this.scope);
		this.filePath = workerActionJournalFile(this.agentDir, this.scope.parentSessionId, scopeDigest(this.identity));
	}

	inspect(actionIdentity: string): WorkerActionJournalInspection {
		const actionId = requireBoundedTrimmedText(actionIdentity, 128, "Worker action id");
		return withFileLockSync(this.filePath, () => {
			const entry = this.readLocked().entries.find((candidate) => candidate.actionId === actionId);
			if (!entry) return { state: "not_started", actionId };
			return this.inspectionFor(entry);
		});
	}

	begin(input: BeginWorkerActionInput): BeginWorkerActionResult {
		if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= MAX_ENTRIES) {
			throw new TypeError(`Worker action index must be a safe integer from 0 through ${MAX_ENTRIES - 1}.`);
		}
		const normalizedTarget = normalizeWorkerActionTarget(this.agentDir, input.targetPath);
		if (normalizedTarget.length > MAX_TARGET_CHARS) throw new TypeError("Worker action target is too long.");
		const digest = actionDigest(input, normalizedTarget);
		const id = actionId(this.scope, input.index, digest);
		return withFileLockSync(this.filePath, () => {
			const journal = this.readLocked();
			const existing = journal.entries.find((entry) => entry.actionId === id);
			if (existing) {
				if (existing.actionDigest !== digest) throw new Error("Worker action journal action identity collision.");
				return this.inspectionFor(existing);
			}
			const previousFence = journal.entries.find(
				(entry) =>
					entry.actionDigest === digest &&
					entry.operation === input.action.op &&
					entry.normalizedTarget === normalizedTarget,
			);
			if (previousFence) return this.inspectionFor(previousFence, true);
			const timestamp = now();
			journal.entries.push({
				actionId: id,
				actionDigest: digest,
				index: input.index,
				attemptId: this.scope.attemptId,
				fencingToken: this.scope.fencingToken,
				operation: input.action.op,
				normalizedTarget,
				status: "intent",
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			this.writeLocked(journal);
			return { kind: "execute", state: "not_started", actionId: id, actionDigest: digest, normalizedTarget };
		});
	}

	recordSucceeded(permit: WorkerActionExecutionPermit, options: { evidencePointer?: string } = {}): void {
		this.recordTerminal(permit, "succeeded", "worker_action_applied", options.evidencePointer);
	}

	recordFailed(
		permit: WorkerActionExecutionPermit,
		reasonCode: string,
		options: { evidencePointer?: string } = {},
	): void {
		this.recordTerminal(
			permit,
			"failed",
			requireBoundedTrimmedText(reasonCode, MAX_REASON_CHARS, "Worker action failure reason"),
			options.evidencePointer,
		);
	}

	private recordTerminal(
		permit: WorkerActionExecutionPermit,
		status: "succeeded" | "failed",
		reasonCode: string,
		evidencePointer: string | undefined,
	): void {
		const boundedEvidence = evidencePointer
			? requireBoundedTrimmedText(evidencePointer, MAX_EVIDENCE_POINTER_CHARS, "Worker action evidence pointer")
			: undefined;
		withFileLockSync(this.filePath, () => {
			const journal = this.readLocked();
			const entry = journal.entries.find((candidate) => candidate.actionId === permit.actionId);
			if (
				!entry ||
				entry.actionDigest !== permit.actionDigest ||
				entry.normalizedTarget !== permit.normalizedTarget ||
				entry.attemptId !== this.scope.attemptId ||
				entry.fencingToken !== this.scope.fencingToken
			) {
				throw new Error("Worker action journal receipt does not match a persisted intent.");
			}
			if (entry.status !== "intent") throw new Error("Worker action journal intent already has a terminal receipt.");
			entry.status = status;
			entry.reasonCode = reasonCode;
			entry.updatedAt = now();
			if (boundedEvidence) entry.evidencePointer = boundedEvidence;
			this.writeLocked(journal);
		});
	}

	private readLocked(): PersistedJournal {
		if (!existsSync(this.filePath)) {
			return { schemaVersion: JOURNAL_SCHEMA_VERSION, scope: structuredClone(this.identity), entries: [] };
		}
		const content = readBoundedTextFileSync(this.filePath, MAX_JOURNAL_BYTES, "Worker action journal");
		let raw: unknown;
		try {
			raw = JSON.parse(content);
		} catch {
			throw new Error("Worker action journal is unreadable; refusing mutation replay.");
		}
		return parseJournal(raw, this.identity);
	}

	private writeLocked(journal: PersistedJournal): void {
		const serialized = `${JSON.stringify(journal)}\n`;
		if (Buffer.byteLength(serialized, "utf-8") > MAX_JOURNAL_BYTES) {
			throw new Error("Worker action journal would exceed its byte limit.");
		}
		writeFileAtomicSync(this.filePath, serialized, { mode: 0o600 });
	}

	private inspectionFor(entry: PersistedJournalEntry, fromPreviousFence = false): WorkerActionInspectionRequired {
		if (entry.status === "intent") {
			return {
				kind: "inspection_required",
				state: "unknown",
				actionId: entry.actionId,
				actionDigest: entry.actionDigest,
				normalizedTarget: entry.normalizedTarget,
				reasonCode: fromPreviousFence
					? "worker_action_prior_fence_requires_inspection"
					: "worker_action_outcome_unknown",
				...(entry.evidencePointer ? { evidencePointer: entry.evidencePointer } : {}),
			};
		}
		return {
			kind: "inspection_required",
			state: entry.status,
			actionId: entry.actionId,
			actionDigest: entry.actionDigest,
			normalizedTarget: entry.normalizedTarget,
			reasonCode: fromPreviousFence
				? "worker_action_prior_fence_requires_inspection"
				: entry.status === "succeeded"
					? "worker_action_already_succeeded"
					: "worker_action_previously_failed",
			...(entry.evidencePointer ? { evidencePointer: entry.evidencePointer } : {}),
		};
	}
}
