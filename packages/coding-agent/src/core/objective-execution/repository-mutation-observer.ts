/**
 * One session-owned boundary for every repository-capable tool call.
 * The ledger still owns exact typed paths. This observer owns fingerprints,
 * in-flight calls, and unexplained deltas.
 */
import { randomUUID } from "node:crypto";
import { consumeProcessTreeUntracked } from "../../utils/process-group-wait.ts";
import type { WorkBaseline } from "../system-one/work-diff.ts";
import { normalizeRepoRelativePath, type ObjectiveMutationLedger } from "./objective-mutation-ledger.ts";
import {
	captureRepoDeliveryFingerprint,
	type FingerprintHooks,
	type RepoDeliveryFingerprint,
} from "./repo-delivery-fingerprint.ts";
import type { RepositoryEffect } from "./repository-effect.ts";

export interface RepositoryObservationToken {
	readonly callId: string;
	readonly observationId: string;
	readonly objectiveId: string;
	readonly effect: RepositoryEffect;
	readonly cwd: string;
	repositoryRoot?: string;
	branchAnchor?: string;
	workEvidenceStatus?: "captured" | "unversioned";
	observationOpened?: boolean;
	before?: RepoDeliveryFingerprint;
}

export interface RepositoryWorkEvidenceScope {
	readonly repositoryRoot: string;
	readonly pathScope?: "repository";
	readonly pendingObservationIds?: readonly string[];
	readonly baseline?: WorkBaseline;
	readonly changedPaths: readonly string[];
	readonly observedMutation?: true;
	readonly diagnostic?: string;
}

export interface RepositoryWorkEvidenceJournal {
	/** Synchronous branch fence for volatile evidence retained after a failed append. */
	isCurrentBranchAnchor(branchAnchor: string | undefined): boolean;
	/** Persist the actual dirty-tree baseline once for this goal/objective and repository. */
	ensureBaseline(
		objectiveId: string,
		cwd: string,
	): Promise<{
		readonly repositoryRoot: string;
		readonly created: boolean;
		readonly branchAnchor?: string;
		readonly baselineStatus: "captured" | "unversioned" | "unavailable";
	}>;
	/** Preserve a baseline-capture race or failure so completion cannot treat it as an empty diff. */
	recordBaselineDiagnostic(
		objectiveId: string,
		repositoryRoot: string,
		reason: string,
		branchAnchor?: string,
	): Promise<void>;
	/** Durably admit this host-owned observation before the tool is allowed to execute. */
	openObservation(
		objectiveId: string,
		repositoryRoot: string,
		observationId: string,
		input: { readonly effect: RepositoryEffect; readonly branchAnchor?: string },
	): Promise<void>;
	/** Durably close one observation that produced no repository delta. */
	closeObservation(
		objectiveId: string,
		repositoryRoot: string,
		observationId: string,
		branchAnchor?: string,
	): Promise<void>;
	/** Record observed mutations whether or not the operation itself succeeded. */
	recordObservedChange(
		objectiveId: string,
		repositoryRoot: string,
		changedPaths: readonly string[],
		input: {
			readonly operationSucceeded: boolean;
			readonly effect: RepositoryEffect;
			readonly observedMutation: true;
			readonly observationId?: string;
			readonly diagnostic?: string;
			readonly branchAnchor?: string;
		},
	): Promise<void>;
	/** Recover terminally abandoned markers from the retained baseline; live siblings remain untouched. */
	recoverObservations(objectiveId: string, activeObservationIds: readonly string[]): Promise<void>;
	getWorkEvidence(objectiveId: string): readonly RepositoryWorkEvidenceScope[];
}

export class RepositoryWorkEvidenceUnavailableError extends Error {
	readonly reason: string;

	constructor(reason: string, cause?: unknown) {
		super(`Repository work evidence is unavailable; retry after the session journal recovers (${reason}).`, {
			cause,
		});
		this.name = "RepositoryWorkEvidenceUnavailableError";
		this.reason = reason;
	}
}

interface Waiter {
	readonly objectiveId: string;
	readonly wake: () => void;
}

interface PendingObservationTerminal {
	readonly kind: "change" | "close";
	readonly observationId: string;
	readonly repositoryRoot: string;
	readonly pathScope?: "repository";
	readonly changedPaths: readonly string[];
	readonly operationSucceeded: boolean;
	readonly effect: RepositoryEffect;
	readonly diagnostic?: string;
	readonly branchAnchor?: string;
	readonly baseline?: WorkBaseline;
}

interface TypedObservationReport {
	readonly changedPaths: readonly string[];
	readonly declaredPaths: readonly string[];
	readonly operationSucceeded: boolean;
}

interface TypedObservationGroup {
	readonly objectiveId: string;
	readonly repositoryRoot: string;
	readonly branchAnchor?: string;
	readonly activeObservationIds: Set<string>;
	readonly declaredPaths: Set<string>;
	readonly observedPaths: Set<string>;
	readonly successfulDeclaredPaths: Set<string>;
}

export class RepositoryMutationObserver {
	private readonly inflight = new Map<string, RepositoryObservationToken>();
	private readonly reasons = new Map<string, string>();
	private readonly waiters = new Set<Waiter>();
	private readonly ledger: ObjectiveMutationLedger;
	private readonly hooks: FingerprintHooks | undefined;
	private workEvidenceJournal?: RepositoryWorkEvidenceJournal;
	private readonly volatileEvidence = new Map<string, Map<string, PendingObservationTerminal>>();
	private readonly typedObservationGroups = new Map<string, TypedObservationGroup>();
	private readonly typedObservationGroupById = new Map<string, TypedObservationGroup>();

	constructor(ledger: ObjectiveMutationLedger, hooks?: FingerprintHooks) {
		this.ledger = ledger;
		this.hooks = hooks;
	}

	setWorkEvidenceJournal(journal: RepositoryWorkEvidenceJournal | undefined): void {
		this.workEvidenceJournal = journal;
	}

	getWorkEvidence(objectiveId: string): readonly RepositoryWorkEvidenceScope[] {
		this.discardStaleVolatileEvidence(objectiveId);
		let durable: readonly RepositoryWorkEvidenceScope[] = [];
		let journalUnavailable: RepositoryWorkEvidenceScope | undefined;
		try {
			durable = this.workEvidenceJournal?.getWorkEvidence(objectiveId) ?? [];
		} catch (error) {
			journalUnavailable = {
				repositoryRoot: "unknown",
				changedPaths: [],
				observedMutation: true,
				diagnostic:
					`work_evidence_journal_unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(
						0,
						512,
					),
			};
		}
		const volatile = this.volatileEvidence.get(objectiveId);
		if (!volatile) return journalUnavailable ? [...durable, journalUnavailable] : durable;
		const merged = new Map(durable.map((scope) => [scope.repositoryRoot, scope]));
		for (const local of volatile.values()) {
			if (local.kind !== "change") continue;
			const persisted = merged.get(local.repositoryRoot);
			merged.set(local.repositoryRoot, {
				repositoryRoot: local.repositoryRoot,
				...(persisted?.pathScope ? { pathScope: persisted.pathScope } : {}),
				baseline: persisted?.baseline ?? local.baseline,
				changedPaths: [...new Set([...(persisted?.changedPaths ?? []), ...local.changedPaths])],
				observedMutation: true,
				diagnostic: `work_evidence_persistence_failed${local.diagnostic ? `: ${local.diagnostic}` : ""}`.slice(
					0,
					512,
				),
			});
		}
		return [...merged.values(), ...(journalUnavailable ? [journalUnavailable] : [])];
	}

	async begin(input: {
		readonly callId: string;
		readonly objectiveId: string;
		readonly cwd: string;
		readonly effect: RepositoryEffect;
	}): Promise<RepositoryObservationToken> {
		const previous = this.inflight.get(input.callId);
		if (previous) await this.abort(previous);
		if (input.effect !== "none") await this.recoverWorkEvidence(input.objectiveId);
		const token: RepositoryObservationToken = {
			callId: input.callId,
			observationId: randomUUID(),
			objectiveId: input.objectiveId,
			effect: input.effect,
			cwd: input.cwd,
		};
		if (input.effect === "none") return token;
		this.inflight.set(input.callId, token);
		try {
			token.before = await captureRepoDeliveryFingerprint(input.cwd, this.hooks);
			if (token.before.ok) token.repositoryRoot = token.before.repositoryRoot;
		} catch {
			token.before = { ok: false, reason: "repository_fingerprint_unavailable" };
		}
		try {
			await this.captureWorkBaseline(token);
			if (token.workEvidenceStatus === "captured" && token.repositoryRoot && this.workEvidenceJournal) {
				token.observationOpened = true;
				await this.workEvidenceJournal.openObservation(
					token.objectiveId,
					token.repositoryRoot,
					token.observationId,
					{
						effect: token.effect,
						branchAnchor: token.branchAnchor,
					},
				);
			}
			if (token.effect === "typed_owned_write" && token.repositoryRoot) this.openTypedObservationGroup(token);
		} catch (error) {
			if (token.observationOpened && token.repositoryRoot && this.workEvidenceJournal) {
				await this.closeObservationToken(token);
			}
			if (this.inflight.get(token.callId) === token) this.inflight.delete(token.callId);
			this.notify(input.objectiveId);
			throw error instanceof RepositoryWorkEvidenceUnavailableError
				? error
				: new RepositoryWorkEvidenceUnavailableError("work_evidence_persistence_failed", error);
		}
		return token;
	}

	private async captureWorkBaseline(token: RepositoryObservationToken): Promise<void> {
		const journal = this.workEvidenceJournal;
		if (!journal) return;
		let repositoryRoot = token.repositoryRoot ?? token.cwd;
		let baselineStatus: "captured" | "unversioned" | "unavailable";
		let createdBaseline: boolean;
		try {
			const baseline = await journal.ensureBaseline(token.objectiveId, token.cwd);
			repositoryRoot = baseline.repositoryRoot;
			token.repositoryRoot = repositoryRoot;
			token.branchAnchor = baseline.branchAnchor;
			baselineStatus = baseline.baselineStatus;
			createdBaseline = baseline.created;
		} catch (error) {
			throw new RepositoryWorkEvidenceUnavailableError("baseline_persistence_failed", error);
		}
		if (baselineStatus === "unavailable")
			throw new RepositoryWorkEvidenceUnavailableError("repository_work_baseline_unavailable");
		token.workEvidenceStatus = baselineStatus;
		if (baselineStatus === "unversioned") return;

		if (!token.before?.ok) {
			const reason = token.before?.reason ?? "baseline_fence_unavailable";
			try {
				await journal.recordBaselineDiagnostic(token.objectiveId, repositoryRoot, reason, token.branchAnchor);
			} catch (error) {
				throw new RepositoryWorkEvidenceUnavailableError("baseline_diagnostic_persistence_failed", error);
			}
			throw new RepositoryWorkEvidenceUnavailableError(reason);
		}
		if (!createdBaseline) return;
		let after: RepoDeliveryFingerprint;
		try {
			after = await captureRepoDeliveryFingerprint(token.cwd, this.hooks);
		} catch {
			after = { ok: false, reason: "repository_fingerprint_unavailable" };
		}
		if (!after.ok) {
			try {
				await journal.recordBaselineDiagnostic(token.objectiveId, repositoryRoot, after.reason, token.branchAnchor);
			} catch (error) {
				throw new RepositoryWorkEvidenceUnavailableError("baseline_diagnostic_persistence_failed", error);
			}
			throw new RepositoryWorkEvidenceUnavailableError(after.reason);
		}
		if (after.repositoryRoot !== token.before.repositoryRoot || after.digest !== token.before.digest) {
			try {
				await journal.recordBaselineDiagnostic(
					token.objectiveId,
					repositoryRoot,
					"baseline_capture_unstable",
					token.branchAnchor,
				);
			} catch (error) {
				throw new RepositoryWorkEvidenceUnavailableError("baseline_diagnostic_persistence_failed", error);
			}
			throw new RepositoryWorkEvidenceUnavailableError("baseline_capture_unstable");
		}
	}

	async finish(input: {
		readonly token: RepositoryObservationToken;
		readonly declaredOwnedPaths?: readonly string[];
		readonly operationSucceeded: boolean;
	}): Promise<void> {
		const token = input.token;
		const tracked = this.inflight.get(token.callId) === token;
		if (!tracked || token.effect === "none") return;
		let typedReport: TypedObservationReport | undefined;
		try {
			if (!this.isCurrentBranch(token)) return;
			if (consumeProcessTreeUntracked(token.cwd)) this.mark(token.objectiveId, "process_tree_untracked");
			if (token.workEvidenceStatus === "unversioned") return;
			let after: RepoDeliveryFingerprint;
			try {
				after = await captureRepoDeliveryFingerprint(token.cwd, this.hooks);
			} catch {
				after = { ok: false, reason: "repository_fingerprint_unavailable" };
			}
			const repositoryRoot = token.repositoryRoot ?? (after.ok ? after.repositoryRoot : token.cwd);
			if (!token.before?.ok) {
				if (!this.isCurrentBranch(token)) return;
				const reason = token.before?.reason ?? "repository_fingerprint_unavailable";
				this.mark(token.objectiveId, reason);
				await this.recordObservedChange(token, repositoryRoot, [], {
					operationSucceeded: input.operationSucceeded,
					diagnostic: reason,
				});
				return;
			}
			if (!after.ok) {
				if (!this.isCurrentBranch(token)) return;
				this.mark(token.objectiveId, after.reason);
				await this.recordObservedChange(token, repositoryRoot, [], {
					operationSucceeded: input.operationSucceeded,
					diagnostic: after.reason,
				});
				return;
			}
			if (!this.isCurrentBranch(token)) return;
			if (after.digest === token.before.digest) {
				await this.closeObservationToken(token);
				if (token.effect === "typed_owned_write") {
					typedReport = {
						changedPaths: [],
						declaredPaths: this.normalizeDeclaredPaths(repositoryRoot, input.declaredOwnedPaths),
						operationSucceeded: input.operationSucceeded,
					};
				}
				return;
			}
			const changed = changedPaths(token.before.entries, after.entries);
			if (token.effect === "typed_owned_write") {
				typedReport = {
					changedPaths: changed,
					declaredPaths: this.normalizeDeclaredPaths(repositoryRoot, input.declaredOwnedPaths),
					operationSucceeded: input.operationSucceeded,
				};
			}
			await this.recordObservedChange(token, repositoryRoot, changed, {
				operationSucceeded: input.operationSucceeded,
			});
			if (!this.isCurrentBranch(token)) return;
			if (token.effect === "typed_owned_write") return;
			this.mark(token.objectiveId, "shell_mutation_unattributed");
		} finally {
			if (tracked) {
				if (token.effect === "typed_owned_write") this.completeTypedObservation(token, typedReport);
				if (this.inflight.get(token.callId) === token) this.inflight.delete(token.callId);
				this.notify(token.objectiveId);
			}
		}
	}

	private normalizeDeclaredPaths(repositoryRoot: string, declaredPaths: readonly string[] | undefined): string[] {
		return [
			...new Set(
				(declaredPaths ?? [])
					.map((filePath) => normalizeRepoRelativePath(repositoryRoot, filePath))
					.filter((filePath): filePath is string => Boolean(filePath)),
			),
		];
	}

	private openTypedObservationGroup(token: RepositoryObservationToken): void {
		const repositoryRoot = token.repositoryRoot;
		if (!repositoryRoot || !this.isCurrentBranch(token)) return;
		const groupKey = JSON.stringify([token.objectiveId, repositoryRoot]);
		let group = this.typedObservationGroups.get(groupKey);
		if (group && !this.isCurrentBranchAnchor(group.branchAnchor)) {
			for (const observationId of group.activeObservationIds) {
				if (this.typedObservationGroupById.get(observationId) === group)
					this.typedObservationGroupById.delete(observationId);
			}
			this.typedObservationGroups.delete(groupKey);
			group = undefined;
		}
		if (!group) {
			group = {
				objectiveId: token.objectiveId,
				repositoryRoot,
				...(token.branchAnchor ? { branchAnchor: token.branchAnchor } : {}),
				activeObservationIds: new Set(),
				declaredPaths: new Set(),
				observedPaths: new Set(),
				successfulDeclaredPaths: new Set(),
			};
			this.typedObservationGroups.set(groupKey, group);
		}
		group.activeObservationIds.add(token.observationId);
		this.typedObservationGroupById.set(token.observationId, group);
	}

	private completeTypedObservation(
		token: RepositoryObservationToken,
		report: TypedObservationReport | undefined,
	): void {
		const group = this.typedObservationGroupById.get(token.observationId);
		if (!group) return;
		this.typedObservationGroupById.delete(token.observationId);
		if (!this.isCurrentBranch(token)) {
			for (const observationId of group.activeObservationIds) {
				if (this.typedObservationGroupById.get(observationId) === group)
					this.typedObservationGroupById.delete(observationId);
			}
			const groupKey = JSON.stringify([group.objectiveId, group.repositoryRoot]);
			if (this.typedObservationGroups.get(groupKey) === group) this.typedObservationGroups.delete(groupKey);
			return;
		}
		group.activeObservationIds.delete(token.observationId);
		if (report) {
			for (const filePath of report.declaredPaths) group.declaredPaths.add(filePath);
			for (const filePath of report.changedPaths) group.observedPaths.add(filePath);
			if (report.operationSucceeded) {
				const changedByReport = new Set(report.changedPaths);
				for (const filePath of report.declaredPaths) {
					if (changedByReport.has(filePath)) group.successfulDeclaredPaths.add(filePath);
				}
			}
		}
		if (group.activeObservationIds.size > 0) return;
		const groupKey = JSON.stringify([group.objectiveId, group.repositoryRoot]);
		if (this.typedObservationGroups.get(groupKey) === group) this.typedObservationGroups.delete(groupKey);
		if ([...group.observedPaths].some((filePath) => !group.declaredPaths.has(filePath))) {
			this.mark(group.objectiveId, "shell_mutation_unattributed");
			return;
		}
		for (const filePath of group.successfulDeclaredPaths) {
			if (group.observedPaths.has(filePath))
				this.ledger.recordOwnedWrite(group.objectiveId, group.repositoryRoot, filePath);
		}
	}

	private async recordObservedChange(
		token: RepositoryObservationToken,
		repositoryRoot: string,
		changedPaths: readonly string[],
		input: { readonly operationSucceeded: boolean; readonly diagnostic?: string },
	): Promise<void> {
		try {
			await this.workEvidenceJournal?.recordObservedChange(token.objectiveId, repositoryRoot, changedPaths, {
				...input,
				effect: token.effect,
				observedMutation: true,
				observationId: token.observationId,
				branchAnchor: token.branchAnchor,
			});
			this.clearPendingObservation(token.objectiveId, token.observationId);
			token.observationOpened = false;
		} catch (_error) {
			if (!this.isCurrentBranch(token)) return;
			let persisted: RepositoryWorkEvidenceScope | undefined;
			try {
				persisted = this.workEvidenceJournal
					?.getWorkEvidence(token.objectiveId)
					.find((scope) => scope.repositoryRoot === repositoryRoot);
			} catch {
				// The volatile diagnostic below is the completion-visible evidence when the journal itself is unavailable.
			}
			const pending = this.volatileEvidence.get(token.objectiveId) ?? new Map<string, PendingObservationTerminal>();
			const previous = pending.get(token.observationId);
			pending.set(token.observationId, {
				kind: "change",
				observationId: token.observationId,
				repositoryRoot,
				...(persisted?.pathScope ? { pathScope: persisted.pathScope } : {}),
				baseline: persisted?.baseline ?? previous?.baseline,
				changedPaths: [
					...new Set([...(previous?.kind === "change" ? previous.changedPaths : []), ...changedPaths]),
				],
				operationSucceeded: input.operationSucceeded,
				effect: token.effect,
				...(input.diagnostic
					? { diagnostic: input.diagnostic }
					: previous?.diagnostic
						? { diagnostic: previous.diagnostic }
						: {}),
				...(token.branchAnchor ? { branchAnchor: token.branchAnchor } : {}),
			});
			this.volatileEvidence.set(token.objectiveId, pending);
		}
	}

	private async closeObservationToken(token: RepositoryObservationToken): Promise<void> {
		const journal = this.workEvidenceJournal;
		const repositoryRoot = token.repositoryRoot;
		if (!journal || !repositoryRoot || !token.observationOpened) return;
		try {
			await journal.closeObservation(token.objectiveId, repositoryRoot, token.observationId, token.branchAnchor);
			token.observationOpened = false;
			this.clearPendingObservation(token.objectiveId, token.observationId);
		} catch {
			if (!this.isCurrentBranch(token)) return;
			const pending = this.volatileEvidence.get(token.objectiveId) ?? new Map<string, PendingObservationTerminal>();
			pending.set(token.observationId, {
				kind: "close",
				observationId: token.observationId,
				repositoryRoot,
				changedPaths: [],
				operationSucceeded: false,
				effect: token.effect,
				...(token.branchAnchor ? { branchAnchor: token.branchAnchor } : {}),
			});
			this.volatileEvidence.set(token.objectiveId, pending);
		}
	}

	private clearPendingObservation(objectiveId: string, observationId: string): void {
		const pending = this.volatileEvidence.get(objectiveId);
		if (!pending) return;
		pending.delete(observationId);
		if (pending.size === 0) this.volatileEvidence.delete(objectiveId);
	}

	private isCurrentBranch(token: RepositoryObservationToken): boolean {
		return this.isCurrentBranchAnchor(token.branchAnchor);
	}

	private isCurrentBranchAnchor(branchAnchor: string | undefined): boolean {
		if (!this.workEvidenceJournal) return true;
		try {
			return this.workEvidenceJournal.isCurrentBranchAnchor(branchAnchor);
		} catch {
			return false;
		}
	}

	private discardStaleVolatileEvidence(objectiveId: string): void {
		const pending = this.volatileEvidence.get(objectiveId);
		if (!pending) return;
		for (const [root, evidence] of pending) {
			let current = false;
			try {
				current = this.workEvidenceJournal?.isCurrentBranchAnchor(evidence.branchAnchor) ?? false;
			} catch {
				current = false;
			}
			if (!current) pending.delete(root);
		}
		if (pending.size === 0) this.volatileEvidence.delete(objectiveId);
	}

	private async replayPendingEvidence(objectiveId: string): Promise<void> {
		const journal = this.workEvidenceJournal;
		const pending = this.volatileEvidence.get(objectiveId);
		if (!journal || !pending) return;
		this.discardStaleVolatileEvidence(objectiveId);
		for (const [observationId, evidence] of pending) {
			try {
				if (evidence.kind === "close") {
					await journal.closeObservation(
						objectiveId,
						evidence.repositoryRoot,
						observationId,
						evidence.branchAnchor,
					);
				} else {
					await journal.recordObservedChange(objectiveId, evidence.repositoryRoot, evidence.changedPaths, {
						observationId,
						operationSucceeded: evidence.operationSucceeded,
						effect: evidence.effect,
						observedMutation: true,
						...(evidence.diagnostic ? { diagnostic: evidence.diagnostic } : {}),
						branchAnchor: evidence.branchAnchor,
					});
				}
				pending.delete(observationId);
			} catch (error) {
				throw new RepositoryWorkEvidenceUnavailableError("observed_change_recovery_failed", error);
			}
		}
		if (pending.size === 0) this.volatileEvidence.delete(objectiveId);
	}

	async recoverWorkEvidence(objectiveId: string): Promise<void> {
		await this.replayPendingEvidence(objectiveId);
		const journal = this.workEvidenceJournal;
		if (!journal) return;
		const activeObservationIds = [...this.inflight.values()]
			.filter((token) => token.objectiveId === objectiveId && token.observationOpened)
			.map((token) => token.observationId);
		await journal.recoverObservations(objectiveId, activeObservationIds);
	}

	async abort(token: RepositoryObservationToken): Promise<void> {
		if (this.inflight.get(token.callId) !== token) return;
		await this.closeObservationToken(token);
		if (token.effect === "typed_owned_write") this.completeTypedObservation(token, undefined);
		if (this.inflight.get(token.callId) === token) this.inflight.delete(token.callId);
		this.notify(token.objectiveId);
	}

	hasInFlight(objectiveId: string): boolean {
		for (const token of this.inflight.values()) {
			if (token.objectiveId === objectiveId) return true;
		}
		return false;
	}

	waitForQuiescence(objectiveId: string, signal?: AbortSignal): Promise<void> {
		if (!this.hasInFlight(objectiveId)) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				objectiveId,
				wake: () => {
					if (this.hasInFlight(objectiveId)) return;
					cleanup();
					resolve();
				},
			};
			const onAbort = (): void => {
				cleanup();
				reject(signal?.reason ?? new Error("repository quiescence aborted"));
			};
			const cleanup = (): void => {
				this.waiters.delete(waiter);
				signal?.removeEventListener("abort", onAbort);
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			this.waiters.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	deliveryBlockReason(objectiveId: string): string | undefined {
		if (this.hasInFlight(objectiveId)) return "repository_mutation_in_flight";
		this.discardStaleVolatileEvidence(objectiveId);
		if (this.volatileEvidence.has(objectiveId)) return "work_evidence_persistence_failed";
		return this.reasons.get(objectiveId) ?? this.ledger.deliveryBlockReason(objectiveId);
	}

	private mark(objectiveId: string, reason: string): void {
		if (!this.reasons.has(objectiveId)) this.reasons.set(objectiveId, reason);
		this.ledger.markShellUnsafe(objectiveId);
	}

	private notify(objectiveId: string): void {
		for (const waiter of this.waiters) {
			if (waiter.objectiveId === objectiveId) waiter.wake();
		}
	}
}

function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
	const paths = new Set<string>([...before.keys(), ...after.keys()]);
	const changed: string[] = [];
	for (const filePath of paths) {
		if (before.get(filePath) !== after.get(filePath)) changed.push(filePath);
	}
	return changed;
}
