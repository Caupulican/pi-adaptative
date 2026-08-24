import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { stateFile } from "../agent-paths.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";

export const DURABLE_LEARNING_MEMORY_POLICY_VERSION = "1";
export const DURABLE_LEARNING_STATE_MAX_HISTORY = 32;
export const DURABLE_LEARNING_STATE_MAX_BYTES = 64 * 1024;
export const DURABLE_LEARNING_CLAIM_LEASE_MS = 90 * 60_000;

const STATE_FILE_NAME = "durable-learning-state.json";
const MAX_VERSION_LENGTH = 128;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export interface DurableLearningVersions {
	runtimeVersion: string;
	memoryPolicyVersion: string;
}

export type DurableLearningTransitionReason =
	| "first-observation"
	| "runtime-change"
	| "memory-policy-change"
	| "runtime-and-policy-change"
	| "recovered-corrupt-state";

export interface DurableLearningReviewMetadata {
	reason: DurableLearningTransitionReason;
	previousRuntimeVersion: string | null;
	runtimeVersion: string;
	previousMemoryPolicyVersion: string | null;
	memoryPolicyVersion: string;
}

export interface DurableLearningClaimToken {
	transitionId: string;
	claimId: string;
	ownerId: string;
	runtimeVersion: string;
	memoryPolicyVersion: string;
}

export type DurableLearningCueAttachOutcome = "attached" | "coalesced" | "replaced-stale" | "disabled" | "failed";

export type DurableLearningStateWarningCode =
	| "recovered-corrupt-state"
	| "unsupported-schema"
	| "unknown-keys"
	| "oversize-state"
	| "state-unavailable";

export type DurableLearningReconcileStatus =
	| DurableLearningCueAttachOutcome
	| "busy"
	| "unchanged"
	| "unsupported"
	| "invalid-version"
	| "invalid-owner"
	| "unavailable";

export interface DurableLearningReconcileResult {
	status: DurableLearningReconcileStatus;
	warningCode?: DurableLearningStateWarningCode;
}

interface DurableLearningClaim {
	claimId: string;
	ownerId: string;
	acquiredAt: string;
	expiresAt: string;
}

interface PendingDurableLearningTransition extends DurableLearningReviewMetadata {
	transitionId: string;
	createdAt: string;
	updatedAt: string;
	claim: DurableLearningClaim | null;
}

interface ResolvedDurableLearningTransition extends DurableLearningReviewMetadata {
	transitionId: string;
	createdAt: string;
	resolvedAt: string;
	status: "reviewed" | "superseded";
}

interface DurableLearningStateFileV1 {
	schemaVersion: 1;
	revision: number;
	observedRuntimeVersion: string;
	observedMemoryPolicyVersion: string;
	current: PendingDurableLearningTransition | null;
	history: ResolvedDurableLearningTransition[];
}

export interface DurableLearningStateSnapshot {
	schemaVersion: 1;
	revision: number;
	observedRuntimeVersion: string;
	observedMemoryPolicyVersion: string;
	currentTransitionId: string | null;
	currentClaimOwnerId: string | null;
	resolvedTransitions: number;
}

interface DurableLearningStateOptions {
	now?: () => Date;
	randomId?: () => string;
	leaseMs?: number;
	withLock?: <T>(filePath: string, fn: () => T) => T;
	writeState?: (filePath: string, contents: string) => void;
}

type LoadResult =
	| { kind: "missing" }
	| { kind: "ok"; state: DurableLearningStateFileV1 }
	| { kind: "corrupt" }
	| { kind: "unsupported"; warningCode: DurableLearningStateWarningCode }
	| { kind: "unavailable" };

const TOP_LEVEL_KEYS = [
	"schemaVersion",
	"revision",
	"observedRuntimeVersion",
	"observedMemoryPolicyVersion",
	"current",
	"history",
] as const;
const PENDING_KEYS = [
	"transitionId",
	"reason",
	"previousRuntimeVersion",
	"runtimeVersion",
	"previousMemoryPolicyVersion",
	"memoryPolicyVersion",
	"createdAt",
	"updatedAt",
	"claim",
] as const;
const RESOLVED_KEYS = [
	"transitionId",
	"reason",
	"previousRuntimeVersion",
	"runtimeVersion",
	"previousMemoryPolicyVersion",
	"memoryPolicyVersion",
	"createdAt",
	"resolvedAt",
	"status",
] as const;
const CLAIM_KEYS = ["claimId", "ownerId", "acquiredAt", "expiresAt"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).some((key) => !allowedKeys.has(key));
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).length === allowed.length && !hasUnknownKeys(value, allowed);
}

function isVersion(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_VERSION_LENGTH &&
		value.trim() === value &&
		VERSION_RE.test(value)
	);
}

function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_RE.test(value);
}

function isTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 64) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isReason(value: unknown): value is DurableLearningTransitionReason {
	return (
		value === "first-observation" ||
		value === "runtime-change" ||
		value === "memory-policy-change" ||
		value === "runtime-and-policy-change" ||
		value === "recovered-corrupt-state"
	);
}

function isNullableVersion(value: unknown): value is string | null {
	return value === null || isVersion(value);
}

export function isDurableLearningClaimToken(value: unknown): value is DurableLearningClaimToken {
	if (!isRecord(value)) return false;
	return (
		Object.keys(value).length === 5 &&
		isUuid(value.transitionId) &&
		isUuid(value.claimId) &&
		isUuid(value.ownerId) &&
		isVersion(value.runtimeVersion) &&
		isVersion(value.memoryPolicyVersion)
	);
}

export function isDurableLearningReviewMetadata(value: unknown): value is DurableLearningReviewMetadata {
	if (!isRecord(value)) return false;
	return (
		Object.keys(value).length === 5 &&
		isReason(value.reason) &&
		isNullableVersion(value.previousRuntimeVersion) &&
		isVersion(value.runtimeVersion) &&
		isNullableVersion(value.previousMemoryPolicyVersion) &&
		isVersion(value.memoryPolicyVersion)
	);
}

function inspectUnknownKeys(value: Record<string, unknown>): boolean {
	if (hasUnknownKeys(value, TOP_LEVEL_KEYS)) return true;
	const current = value.current;
	if (isRecord(current)) {
		if (hasUnknownKeys(current, PENDING_KEYS)) return true;
		if (isRecord(current.claim) && hasUnknownKeys(current.claim, CLAIM_KEYS)) return true;
	}
	if (Array.isArray(value.history)) {
		for (const entry of value.history) {
			if (isRecord(entry) && hasUnknownKeys(entry, RESOLVED_KEYS)) return true;
		}
	}
	return false;
}

function isClaim(value: unknown): value is DurableLearningClaim {
	if (!isRecord(value) || !hasExactKeys(value, CLAIM_KEYS)) return false;
	return (
		isUuid(value.claimId) &&
		isUuid(value.ownerId) &&
		isTimestamp(value.acquiredAt) &&
		isTimestamp(value.expiresAt) &&
		value.expiresAt > value.acquiredAt
	);
}

function hasValidTransitionIdentity(value: Record<string, unknown>): boolean {
	return (
		isUuid(value.transitionId) &&
		isReason(value.reason) &&
		isNullableVersion(value.previousRuntimeVersion) &&
		isVersion(value.runtimeVersion) &&
		isNullableVersion(value.previousMemoryPolicyVersion) &&
		isVersion(value.memoryPolicyVersion) &&
		isTimestamp(value.createdAt)
	);
}

function isPendingTransition(value: unknown): value is PendingDurableLearningTransition {
	if (!isRecord(value) || !hasExactKeys(value, PENDING_KEYS)) return false;
	return (
		hasValidTransitionIdentity(value) &&
		isTimestamp(value.updatedAt) &&
		(value.claim === null || isClaim(value.claim))
	);
}

function isResolvedTransition(value: unknown): value is ResolvedDurableLearningTransition {
	if (!isRecord(value) || !hasExactKeys(value, RESOLVED_KEYS)) return false;
	return (
		hasValidTransitionIdentity(value) &&
		isTimestamp(value.resolvedAt) &&
		(value.status === "reviewed" || value.status === "superseded")
	);
}

function validateState(value: unknown): LoadResult {
	if (!isRecord(value)) return { kind: "corrupt" };
	if (value.schemaVersion !== 1) return { kind: "unsupported", warningCode: "unsupported-schema" };
	if (inspectUnknownKeys(value)) return { kind: "unsupported", warningCode: "unknown-keys" };
	if (!hasExactKeys(value, TOP_LEVEL_KEYS)) return { kind: "corrupt" };
	if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return { kind: "corrupt" };
	if (!isVersion(value.observedRuntimeVersion) || !isVersion(value.observedMemoryPolicyVersion)) {
		return { kind: "corrupt" };
	}
	if (value.current !== null && !isPendingTransition(value.current)) return { kind: "corrupt" };
	if (
		!Array.isArray(value.history) ||
		value.history.length > DURABLE_LEARNING_STATE_MAX_HISTORY ||
		value.history.some((entry) => !isResolvedTransition(entry))
	) {
		return { kind: "corrupt" };
	}
	const current = value.current as PendingDurableLearningTransition | null;
	if (
		current &&
		(current.runtimeVersion !== value.observedRuntimeVersion ||
			current.memoryPolicyVersion !== value.observedMemoryPolicyVersion)
	) {
		return { kind: "corrupt" };
	}
	const ids = [
		current?.transitionId,
		...(value.history as ResolvedDurableLearningTransition[]).map((entry) => entry.transitionId),
	].filter((id): id is string => !!id);
	if (new Set(ids).size !== ids.length) return { kind: "corrupt" };
	return { kind: "ok", state: value as unknown as DurableLearningStateFileV1 };
}

function exactTokenMatches(
	current: PendingDurableLearningTransition | null,
	token: DurableLearningClaimToken,
): boolean {
	const claim = current?.claim;
	return (
		!!current &&
		!!claim &&
		current.transitionId === token.transitionId &&
		claim.claimId === token.claimId &&
		claim.ownerId === token.ownerId &&
		current.runtimeVersion === token.runtimeVersion &&
		current.memoryPolicyVersion === token.memoryPolicyVersion
	);
}

function metadataFromTransition(current: PendingDurableLearningTransition): DurableLearningReviewMetadata {
	return {
		reason: current.reason,
		previousRuntimeVersion: current.previousRuntimeVersion,
		runtimeVersion: current.runtimeVersion,
		previousMemoryPolicyVersion: current.previousMemoryPolicyVersion,
		memoryPolicyVersion: current.memoryPolicyVersion,
	};
}

function tokenFromTransition(current: PendingDurableLearningTransition): DurableLearningClaimToken {
	if (!current.claim) throw new Error("Durable learning transition has no claim");
	return {
		transitionId: current.transitionId,
		claimId: current.claim.claimId,
		ownerId: current.claim.ownerId,
		runtimeVersion: current.runtimeVersion,
		memoryPolicyVersion: current.memoryPolicyVersion,
	};
}

export class DurableLearningState {
	private readonly filePath: string;
	private readonly now: () => Date;
	private readonly randomId: () => string;
	private readonly leaseMs: number;
	private readonly withLock: <T>(filePath: string, fn: () => T) => T;
	private readonly writeState: (filePath: string, contents: string) => void;

	constructor(filePath: string, options: DurableLearningStateOptions = {}) {
		this.filePath = filePath;
		this.now = options.now ?? (() => new Date());
		this.randomId = options.randomId ?? randomUUID;
		this.leaseMs = options.leaseMs ?? DURABLE_LEARNING_CLAIM_LEASE_MS;
		this.withLock = options.withLock ?? ((path, fn) => withFileLockSync(path, fn));
		this.writeState =
			options.writeState ?? ((path, contents) => writeFileAtomicSync(path, contents, { mode: 0o600 }));
		if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) {
			throw new TypeError("Durable learning claim lease must be a positive safe integer");
		}
	}

	static forAgentDir(agentDir: string, options: DurableLearningStateOptions = {}): DurableLearningState {
		return new DurableLearningState(stateFile(agentDir, STATE_FILE_NAME), options);
	}

	private currentDate(): Date {
		const current = this.now();
		if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
			throw new Error("Durable learning clock returned an invalid date");
		}
		return current;
	}

	private nextId(): string {
		const id = this.randomId();
		if (!isUuid(id)) throw new Error("Durable learning random ID source returned an invalid UUID");
		return id;
	}

	private load(): LoadResult {
		try {
			if (!existsSync(this.filePath)) return { kind: "missing" };
			if (statSync(this.filePath).size > DURABLE_LEARNING_STATE_MAX_BYTES) {
				return { kind: "unsupported", warningCode: "oversize-state" };
			}
			const contents = readFileSync(this.filePath, "utf-8");
			if (Buffer.byteLength(contents, "utf-8") > DURABLE_LEARNING_STATE_MAX_BYTES) {
				return { kind: "unsupported", warningCode: "oversize-state" };
			}
			try {
				return validateState(JSON.parse(contents));
			} catch {
				return { kind: "corrupt" };
			}
		} catch {
			return { kind: "unavailable" };
		}
	}

	private save(state: DurableLearningStateFileV1): void {
		if (state.history.length > DURABLE_LEARNING_STATE_MAX_HISTORY) {
			state.history = state.history.slice(-DURABLE_LEARNING_STATE_MAX_HISTORY);
		}
		const contents = `${JSON.stringify(state, null, "\t")}\n`;
		if (Buffer.byteLength(contents, "utf-8") > DURABLE_LEARNING_STATE_MAX_BYTES) {
			throw new Error("Durable learning state exceeds its byte bound");
		}
		this.writeState(this.filePath, contents);
	}

	private newClaim(ownerId: string, now: Date): DurableLearningClaim {
		return {
			claimId: this.nextId(),
			ownerId,
			acquiredAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
		};
	}

	private newTransition(
		versions: DurableLearningVersions,
		reason: DurableLearningTransitionReason,
		previousRuntimeVersion: string | null,
		previousMemoryPolicyVersion: string | null,
		ownerId: string,
		now: Date,
	): PendingDurableLearningTransition {
		const at = now.toISOString();
		return {
			transitionId: this.nextId(),
			reason,
			previousRuntimeVersion,
			runtimeVersion: versions.runtimeVersion,
			previousMemoryPolicyVersion,
			memoryPolicyVersion: versions.memoryPolicyVersion,
			createdAt: at,
			updatedAt: at,
			claim: this.newClaim(ownerId, now),
		};
	}

	private resolveCurrent(
		state: DurableLearningStateFileV1,
		status: ResolvedDurableLearningTransition["status"],
		now: Date,
	): void {
		const current = state.current;
		if (!current) return;
		state.history.push({
			transitionId: current.transitionId,
			reason: current.reason,
			previousRuntimeVersion: current.previousRuntimeVersion,
			runtimeVersion: current.runtimeVersion,
			previousMemoryPolicyVersion: current.previousMemoryPolicyVersion,
			memoryPolicyVersion: current.memoryPolicyVersion,
			createdAt: current.createdAt,
			resolvedAt: now.toISOString(),
			status,
		});
		if (state.history.length > DURABLE_LEARNING_STATE_MAX_HISTORY) {
			state.history = state.history.slice(-DURABLE_LEARNING_STATE_MAX_HISTORY);
		}
		state.current = null;
	}

	private initialState(
		versions: DurableLearningVersions,
		ownerId: string,
		now: Date,
		reason: "first-observation" | "recovered-corrupt-state",
	): DurableLearningStateFileV1 {
		return {
			schemaVersion: 1,
			revision: 1,
			observedRuntimeVersion: versions.runtimeVersion,
			observedMemoryPolicyVersion: versions.memoryPolicyVersion,
			current: this.newTransition(versions, reason, null, null, ownerId, now),
			history: [],
		};
	}

	private changedReason(
		state: DurableLearningStateFileV1,
		versions: DurableLearningVersions,
	): DurableLearningTransitionReason | undefined {
		const runtimeChanged = state.observedRuntimeVersion !== versions.runtimeVersion;
		const policyChanged = state.observedMemoryPolicyVersion !== versions.memoryPolicyVersion;
		if (runtimeChanged && policyChanged) return "runtime-and-policy-change";
		if (runtimeChanged) return "runtime-change";
		if (policyChanged) return "memory-policy-change";
		return undefined;
	}

	reconcileClaimAndAttach(
		versions: DurableLearningVersions,
		ownerId: string,
		attachCue: (
			token: DurableLearningClaimToken,
			metadata: DurableLearningReviewMetadata,
		) => DurableLearningCueAttachOutcome,
	): DurableLearningReconcileResult {
		if (!isVersion(versions.runtimeVersion) || !isVersion(versions.memoryPolicyVersion)) {
			return { status: "invalid-version" };
		}
		if (!isUuid(ownerId)) return { status: "invalid-owner" };
		const preflight = this.load();
		if (preflight.kind === "unsupported") return { status: "unsupported", warningCode: preflight.warningCode };
		if (preflight.kind === "unavailable") return { status: "unavailable", warningCode: "state-unavailable" };

		try {
			return this.withLock(this.filePath, () => {
				const loaded = this.load();
				if (loaded.kind === "unsupported") {
					return { status: "unsupported", warningCode: loaded.warningCode };
				}
				if (loaded.kind === "unavailable") {
					return { status: "unavailable", warningCode: "state-unavailable" };
				}
				const now = this.currentDate();
				let warningCode: DurableLearningStateWarningCode | undefined;
				let state: DurableLearningStateFileV1;
				if (loaded.kind === "missing") {
					state = this.initialState(versions, ownerId, now, "first-observation");
				} else if (loaded.kind === "corrupt") {
					state = this.initialState(versions, ownerId, now, "recovered-corrupt-state");
					warningCode = "recovered-corrupt-state";
				} else {
					state = loaded.state;
					const reason = this.changedReason(state, versions);
					if (reason) {
						const previousRuntimeVersion = state.observedRuntimeVersion;
						const previousMemoryPolicyVersion = state.observedMemoryPolicyVersion;
						this.resolveCurrent(state, "superseded", now);
						state.observedRuntimeVersion = versions.runtimeVersion;
						state.observedMemoryPolicyVersion = versions.memoryPolicyVersion;
						state.current = this.newTransition(
							versions,
							reason,
							previousRuntimeVersion,
							previousMemoryPolicyVersion,
							ownerId,
							now,
						);
						state.revision += 1;
					} else if (!state.current) {
						return { status: "unchanged" };
					} else {
						const claim = state.current.claim;
						const live = !!claim && new Date(claim.expiresAt).getTime() > now.getTime();
						if (live && claim.ownerId !== ownerId) return { status: "busy" };
						if (live) {
							claim.expiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
							state.current.updatedAt = now.toISOString();
							state.revision += 1;
						} else {
							state.current.claim = this.newClaim(ownerId, now);
							state.current.updatedAt = now.toISOString();
							state.revision += 1;
						}
					}
				}

				const current = state.current;
				if (!current?.claim) throw new Error("Durable learning reconciliation produced no claim");
				this.save(state);
				const token = tokenFromTransition(current);
				let outcome: DurableLearningCueAttachOutcome;
				try {
					outcome = attachCue(token, metadataFromTransition(current));
				} catch {
					outcome = "failed";
				}
				if (outcome === "disabled" || outcome === "failed") {
					const settlingCurrent = state.current;
					if (settlingCurrent && exactTokenMatches(settlingCurrent, token)) {
						settlingCurrent.claim = null;
						settlingCurrent.updatedAt = this.currentDate().toISOString();
						state.revision += 1;
						this.save(state);
					}
				}
				return warningCode ? { status: outcome, warningCode } : { status: outcome };
			});
		} catch {
			return { status: "unavailable", warningCode: "state-unavailable" };
		}
	}

	private mutateExactClaim(
		token: DurableLearningClaimToken,
		mutate: (state: DurableLearningStateFileV1, current: PendingDurableLearningTransition) => boolean,
	): boolean {
		if (!this.validToken(token)) return false;
		const preflight = this.load();
		if (preflight.kind !== "ok") return false;
		try {
			return this.withLock(this.filePath, () => {
				const loaded = this.load();
				if (loaded.kind !== "ok") return false;
				const current = loaded.state.current;
				if (!current || !exactTokenMatches(current, token) || !mutate(loaded.state, current)) return false;
				loaded.state.revision += 1;
				this.save(loaded.state);
				return true;
			});
		} catch {
			return false;
		}
	}

	renewClaim(token: DurableLearningClaimToken): boolean {
		return this.mutateExactClaim(token, (_state, current) => {
			const now = this.currentDate();
			if (!current.claim || new Date(current.claim.expiresAt).getTime() <= now.getTime()) return false;
			current.claim.expiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
			current.updatedAt = now.toISOString();
			return true;
		});
	}

	releaseClaim(token: DurableLearningClaimToken): boolean {
		return this.mutateExactClaim(token, (_state, current) => {
			current.claim = null;
			current.updatedAt = this.currentDate().toISOString();
			return true;
		});
	}

	completeReview(token: DurableLearningClaimToken): boolean {
		return this.mutateExactClaim(token, (state) => {
			this.resolveCurrent(state, "reviewed", this.currentDate());
			return true;
		});
	}

	readSnapshot(): DurableLearningStateSnapshot | undefined {
		const loaded = this.load();
		if (loaded.kind !== "ok") return undefined;
		return {
			schemaVersion: 1,
			revision: loaded.state.revision,
			observedRuntimeVersion: loaded.state.observedRuntimeVersion,
			observedMemoryPolicyVersion: loaded.state.observedMemoryPolicyVersion,
			currentTransitionId: loaded.state.current?.transitionId ?? null,
			currentClaimOwnerId: loaded.state.current?.claim?.ownerId ?? null,
			resolvedTransitions: loaded.state.history.length,
		};
	}

	private validToken(token: DurableLearningClaimToken): boolean {
		return isDurableLearningClaimToken(token);
	}
}
