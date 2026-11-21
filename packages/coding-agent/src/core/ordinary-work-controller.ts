/** Branch-local ordinary owner work, anchored by its original user entry and recovered from canonical receipts. */

import { randomUUID } from "node:crypto";
import { isOwnerProvenDead, ownProcessOwner } from "../kernel/reliability/owner-identity.ts";
import {
	inspectSessionLifecycle,
	isUnknownRecoveredToolResult,
	type SessionLifecycleInspection,
} from "../kernel/session/lifecycle-ledger.ts";
import type { SessionEntry } from "../kernel/session/session-entries.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import { visitSessionAncestry } from "../kernel/session/session-tree.ts";
import type { TurnOriginRecord } from "../kernel/turn-origin-stamp.ts";
import type { AgentMessage } from "../kernel/types.ts";
import { type OrdinaryWorkStatusSnapshot, ordinaryWorkStatusSnapshot } from "./autonomy-status/ordinary-work.ts";
import { textContentPrefix } from "./context/message-text.ts";
import { getOwnerEvidenceSnapshots, isCompleteOwnerSource, type OwnerWords } from "./learning/owner-evidence-ledger.ts";
import { modelTransferIsPending } from "./orchestration/model-transfer.ts";
import { type TaskRuntimeProjection, terminalAttemptStatus } from "./orchestration/task-runtime-state.ts";
import { ordinaryCompletionReports } from "./ordinary-work-completions.ts";
import { ORDINARY_REPORTING_RESERVATION, type OrdinaryReportingRequirements } from "./ordinary-work-policy.ts";
import {
	ORDINARY_WORK_LOOKUP_BATCH,
	type OrdinaryWorkRecord,
	type OrdinaryWorkStatus,
	type OrdinaryWorkStore,
	ordinaryWorkIsTerminal,
} from "./ordinary-work-store.ts";
import { isCompatibleOwnerSourceEntry, isOwnerSpokenInputId, type OwnerInputDelivery } from "./owner-input-ledger.ts";
import { ownerRequestForJudge } from "./security/owner-paste-boundary.ts";
import { entryTurnOrigin, isDecisiveOrigin } from "./turn-origin.ts";

export type { OrdinaryWorkRecord, OrdinaryWorkStatus } from "./ordinary-work-store.ts";

export type OrdinaryWorkAbortIntent = "cancel" | "preserve" | "hold" | "transfer";
export interface OrdinaryWorkAbortOptions {
	readonly ordinaryWork?: OrdinaryWorkAbortIntent;
}

export interface OrdinaryWorkEvidence {
	readonly record: OrdinaryWorkRecord;
	readonly request: string;
	readonly opening: AgentMessage;
	readonly entries: readonly SessionEntry[];
	readonly messages: readonly AgentMessage[];
	readonly lifecycle: SessionLifecycleInspection;
	readonly unresolvedToolCallIds: readonly string[];
	readonly ownerInputs: readonly {
		readonly entryId: string;
		readonly sourceId?: string;
		readonly words: OwnerWords;
	}[];
	readonly unavailableAttachmentEntryIds: readonly string[];
}

interface OrdinaryWorkControllerDeps {
	reportingRequirements?(): OrdinaryReportingRequirements;
	getSessionManager(): SessionManager;
	getStore(): OrdinaryWorkStore | undefined;
	peekStore?(): OrdinaryWorkStore | undefined;
	isEnabled(): boolean;
	hasActiveGoal?(): boolean;
	/** Read only after `isEnabled` allowed the review, so it need not repeat that gate. */
	mayReview?(): boolean;
	warn?(message: string): void;
	now?: () => number;
	/** The durable task runtime, when this session has loaded one; the source of the launched-work fact. */
	getTaskRuntimeSnapshot?(): TaskRuntimeProjection | undefined;
}

export class OrdinaryWorkController {
	private reportingReservation?: { record: OrdinaryWorkRecord; snapshot: OrdinaryReportingRequirements; text: string };
	private readonly deps: OrdinaryWorkControllerDeps;
	private readonly lease = { id: randomUUID(), ...ownProcessOwner() };
	private pendingOpening: { sessionId: string; entryId: string } | undefined;
	private cachedStore: OrdinaryWorkStore | undefined;
	private warnedUnavailableSession: string | undefined;
	private storageReadFailed = false;
	private anchor:
		| {
				manager: SessionManager;
				sessionId: string;
				openingEntryId: string;
				frontierEntryId: string;
				opening: SessionEntry | undefined;
				ownerInputId: string | undefined;
				assertBranch: () => void;
		  }
		| undefined;

	constructor(deps: OrdinaryWorkControllerDeps) {
		this.deps = deps;
	}

	mayReview(): boolean {
		return this.deps.isEnabled() && !this.deps.hasActiveGoal?.() && this.deps.mayReview?.() !== false;
	}

	current(): OrdinaryWorkRecord | undefined {
		if (!this.deps.isEnabled() || !this.deps.getSessionManager().isPersisted()) return undefined;
		try {
			const current = this.readCurrent();
			this.storageReadFailed = false;
			return current;
		} catch {
			this.storageReadFailed = true;
			this.noteUnavailable();
			return undefined;
		}
	}

	readStatus(
		matchesOpening?: (sessionId: string, origin: TurnOriginRecord | undefined) => boolean,
	): OrdinaryWorkStatusSnapshot {
		if (!this.deps.isEnabled()) return { state: "disabled" };
		if (!this.deps.getSessionManager().isPersisted()) return { state: "ephemeral" };
		try {
			const store = this.cachedStore ?? this.deps.peekStore?.();
			if (!store)
				return {
					state: "unavailable",
					reason:
						this.storageReadFailed ||
						this.warnedUnavailableSession === this.deps.getSessionManager().getSessionId()
							? "storage_unavailable"
							: "storage_not_loaded",
				};
			const record = this.readCurrent(store, true);
			if (record && matchesOpening) {
				const opening = this.deps.getSessionManager().getEntry(record.openingEntryId);
				if (!opening || !matchesOpening(record.sessionId, entryTurnOrigin(opening))) return { state: "none" };
			}
			return ordinaryWorkStatusSnapshot(record);
		} catch {
			return { state: "unavailable", reason: "storage_unavailable" };
		}
	}

	private readCurrent(store = this.readStore(), includeTerminal = false): OrdinaryWorkRecord | undefined {
		const manager = this.deps.getSessionManager();
		if (!store) return undefined;
		const anchor = this.anchor;
		if (anchor?.manager === manager && anchor.sessionId === manager.getSessionId()) {
			try {
				anchor.assertBranch();
				const opening = manager.getEntry(anchor.openingEntryId);
				if (
					opening !== anchor.opening ||
					opening?.type !== "message" ||
					opening.ownerInputId !== anchor.ownerInputId ||
					!isCompatibleOwnerSourceEntry(opening)
				)
					return undefined;
				const record = store.get(anchor.sessionId, anchor.openingEntryId);
				if (
					!record ||
					record.sessionId !== anchor.sessionId ||
					record.openingEntryId !== anchor.openingEntryId ||
					(!includeTerminal && ordinaryWorkIsTerminal(record))
				)
					return undefined;
				if (!this.containsFrontier(record.frontierEntryId)) return undefined;
				anchor.frontierEntryId = record.frontierEntryId;
				return record;
			} catch {
				this.anchor = undefined;
			}
		}
		const sessionId = manager.getSessionId();
		const candidates = store.openingCandidates(sessionId);
		if (!candidates.length) return undefined;
		const known = candidates.length <= ORDINARY_WORK_LOOKUP_BATCH ? new Set(candidates) : undefined;
		const positions = new Map<string, number>();
		const pending: string[] = [];
		let checkedNearest = false;
		let located: OrdinaryWorkRecord | undefined;
		const flush = () => {
			const records = new Map(
				store.forOpenings(sessionId, pending).map((record) => [record.openingEntryId, record]),
			);
			located = pending.map((id) => records.get(id)).find((record) => record !== undefined);
			pending.length = 0;
		};
		visitSessionAncestry(
			manager.getLeafEntry(),
			{ size: manager.getEntryCount(), get: (id) => manager.getEntry(id) },
			(entry) => {
				positions.set(entry.id, positions.size);
				if (!isCompatibleOwnerSourceEntry(entry)) return;
				if (known) {
					if (known.has(entry.id)) located = store.get(sessionId, entry.id);
				} else if (!checkedNearest) {
					checkedNearest = true;
					located = store.get(sessionId, entry.id);
				} else {
					pending.push(entry.id);
					if (pending.length === ORDINARY_WORK_LOOKUP_BATCH) flush();
				}
				if (located) return false;
			},
		);
		if (!located && pending.length) flush();
		if (!located) return undefined;
		const frontier = positions.get(located.frontierEntryId);
		if (frontier === undefined || frontier > positions.get(located.openingEntryId)!) return undefined;
		this.remember(located);
		return !includeTerminal && ordinaryWorkIsTerminal(located) ? undefined : located;
	}

	noteOwnerInput(delivery: OwnerInputDelivery): OrdinaryWorkRecord | undefined {
		if (!this.deps.isEnabled() || !this.deps.getSessionManager().isPersisted() || !isOwnerSpokenInputId(delivery.id))
			return undefined;
		this.pendingOpening = { sessionId: this.deps.getSessionManager().getSessionId(), entryId: delivery.entryId };
		return this.enrollCurrentOwner();
	}

	/** Provider admission calls this again so a failure-isolated delivery listener cannot silently lose durability. */
	enrollCurrentOwner(): OrdinaryWorkRecord | undefined {
		if (!this.deps.isEnabled() || !this.deps.getSessionManager().isPersisted()) return undefined;
		const current = this.current();
		if (this.storageReadFailed) return undefined;
		const pending = this.pendingOpening;
		if (this.deps.hasActiveGoal?.()) {
			this.pendingOpening = undefined;
			if (current) this.checkpoint(current, { status: "waiting", reason: "explicit_goal_owns_request" });
			return undefined;
		}
		if (!pending) return current?.status === "active" && current.leaseId === this.lease.id ? current : undefined;
		const manager = this.deps.getSessionManager();
		const entry = manager.getBranch(undefined, pending.entryId)[0];
		if (pending.sessionId !== manager.getSessionId() || !isCompatibleOwnerSourceEntry(entry)) {
			this.pendingOpening = undefined;
			return current;
		}
		const store = this.readStore();
		if (!store) {
			this.noteUnavailable();
			return undefined;
		}
		manager.flushBufferedEntries();
		if (current && !this.mayAcquire(current))
			throw new Error("Ordinary owner work is leased by another live session process.");
		let record: OrdinaryWorkRecord | undefined;
		try {
			if (current?.status === "active" && current.leaseId === this.lease.id)
				record =
					current.frontierEntryId === pending.entryId
						? current
						: store.addOwnerInput(current, pending.entryId, this.now());
			else record = store.open(manager.getSessionId(), pending.entryId, this.now());
		} catch {
			this.noteUnavailable();
			return undefined;
		}
		if (!record) throw new Error("Ordinary owner work changed while its owner input was being enrolled.");
		this.remember(record, pending.entryId);
		try {
			record = this.claim(record);
		} catch {
			this.noteUnavailable();
			return undefined;
		}
		if (!record) {
			if (this.storageReadFailed) return undefined;
			throw new Error("Ordinary owner work could not acquire its current execution lease.");
		}
		this.pendingOpening = undefined;
		return record;
	}

	claim(expected: OrdinaryWorkRecord): OrdinaryWorkRecord | undefined {
		if (!this.isCurrent(expected) || !this.mayAcquire(expected)) return undefined;
		if (expected.leaseId === this.lease.id) return expected;
		return this.requiredStore().claim(expected, this.lease, this.now(), "acquire");
	}

	reportingRequirements(): OrdinaryReportingRequirements | undefined {
		try {
			const snapshot = this.deps.reportingRequirements?.();
			if (!snapshot) return;
			return {
				...snapshot,
				isCurrent: () => {
					try {
						return snapshot.isCurrent();
					} catch {
						return false;
					}
				},
			};
		} catch {
			return { complete: false, requirements: [], isCurrent: () => false };
		}
	}

	reportingRevision(record: OrdinaryWorkRecord | undefined): string | undefined {
		if (record?.reason !== ORDINARY_REPORTING_RESERVATION) return;
		const saved = this.reportingReservation;
		if (
			saved &&
			saved.record.sessionId === record.sessionId &&
			saved.record.openingEntryId === record.openingEntryId &&
			saved.record.generation === record.generation &&
			saved.record.revision === record.revision &&
			this.isCurrent(record) &&
			saved.snapshot.isCurrent()
		)
			return saved.text;
		return undefined;
	}

	reserveContinuation(
		expected: OrdinaryWorkRecord,
		responseMode?: "answer_only",
		reporting?: { snapshot: OrdinaryReportingRequirements; text: string },
	): OrdinaryWorkRecord | undefined {
		if (
			!this.isCurrent(expected) ||
			expected.status !== "active" ||
			expected.reason !== "stop_review_in_progress" ||
			expected.leaseId !== this.lease.id ||
			(reporting && responseMode !== "answer_only")
		)
			return undefined;
		const record = this.requiredStore().claim(
			expected,
			this.lease,
			this.now(),
			reporting ? { reporting: reporting.snapshot } : (responseMode ?? "continue"),
		);
		if (record) this.reportingReservation = reporting ? { record, ...reporting } : undefined;
		return record;
	}

	beginReview(expected: OrdinaryWorkRecord): OrdinaryWorkRecord | undefined {
		if (expected.reason === "stop_review_in_progress") return undefined;
		const owned = this.claim(expected);
		const review = owned ? this.requiredStore().beginReview(owned, this.now()) : undefined;
		if (review) this.reportingReservation = undefined;
		return review;
	}

	checkpoint(
		expected: OrdinaryWorkRecord,
		input: {
			readonly status: OrdinaryWorkStatus;
			readonly frontierEntryId?: string;
			readonly reason?: string;
			readonly reporting?: OrdinaryReportingRequirements;
		},
	): OrdinaryWorkRecord | undefined {
		if (!this.isCurrent(expected) || !this.mayAcquire(expected)) return undefined;
		const manager = this.deps.getSessionManager();
		const frontierEntryId = input.frontierEntryId ?? manager.getLeafId();
		if (!frontierEntryId || !this.containsFrontier(frontierEntryId)) return undefined;
		manager.flushBufferedEntries();
		return this.requiredStore().checkpoint(expected, { ...input, frontierEntryId }, this.now());
	}

	cancelCurrent(reason: string): void {
		this.pendingOpening = undefined;
		this.reportingReservation = undefined;
		const current = this.current();
		if (current) this.checkpoint(current, { status: "cancelled", reason });
	}

	onAbort(reason: string, intent: OrdinaryWorkAbortIntent = "cancel"): void {
		try {
			if (intent === "cancel") this.cancelCurrent(reason);
			else if (intent === "preserve") this.release();
			else if (intent === "transfer") {
				const current = this.current();
				if (current?.status === "active" && current.leaseId === this.lease.id)
					this.requiredStore().addOwnerInput(current, current.frontierEntryId, this.now());
			} else {
				const current = this.current();
				if (current) this.checkpoint(current, { status: "unverified", reason: `system_bound: ${reason}` });
			}
		} catch (error) {
			this.deps.warn?.(
				`The turn stopped, but its ordinary work state could not be saved: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** A graceful process close retains work and drops only this controller's lease. */
	release(): void {
		this.reportingReservation = undefined;
		if (!this.cachedStore) return;
		const current = this.current();
		if (current?.leaseId === this.lease.id)
			this.checkpoint(current, {
				status: "unverified",
				reason:
					current.reason === ORDINARY_REPORTING_RESERVATION
						? "reporting_unverified"
						: current.reason === "stop_review_in_progress"
							? current.reason
							: "process_interrupted",
			});
	}

	evidence(expected: OrdinaryWorkRecord): OrdinaryWorkEvidence | undefined {
		if (!this.isCurrent(expected)) return undefined;
		const manager = this.deps.getSessionManager();
		const branch = manager.getFullHistoryChainWithPayloads(undefined, expected.openingEntryId);
		const opening = branch[0];
		if (opening?.type !== "message" || opening.message.role !== "user") return undefined;
		let ownerAuthority = true;
		const entries = branch.filter((entry) => {
			const origin = entryTurnOrigin(entry);
			if (origin && isDecisiveOrigin(origin)) ownerAuthority = origin.thirdParty !== true;
			return ownerAuthority;
		});
		if (!ownerAuthority || entries[0]?.id !== opening.id) return undefined;
		const lifecycle = inspectSessionLifecycle(entries);
		const unresolvedToolCallIds = [
			...lifecycle.unknownToolOutcomes.map((entry) => entry.callId),
			...lifecycle.unmatchedToolStarts.map((entry) => entry.callId),
			...entries.flatMap((entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				isUnknownRecoveredToolResult(entry.message)
					? [entry.message.toolCallId]
					: [],
			),
		];
		const originals = new Map(getOwnerEvidenceSnapshots(branch).map((record) => [record.entryId, record]));
		const ownerInputs = entries.flatMap((entry) => {
			if (
				entry.type !== "message" ||
				entry.message.role !== "user" ||
				!isCompatibleOwnerSourceEntry(entry) ||
				(entry.id !== opening.id && (!entry.ownerInputId || !isOwnerSpokenInputId(entry.ownerInputId)))
			)
				return [];
			const text = textContentPrefix(entry.message.content);
			const original = originals.get(entry.id);
			return [
				{
					entryId: entry.id,
					...(isCompleteOwnerSource(original) ? { sourceId: original.sourceId } : {}),
					words: original ? { text: original.text, pasted: original.pasted } : { text },
				},
			];
		});
		const request = ownerInputs
			.map(({ words }) => ownerRequestForJudge(words))
			.filter(Boolean)
			.join("\n\n");
		const unavailableAttachmentEntryIds = entries.flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user" || typeof entry.message.content === "string")
				return [];
			const content = entry.message.content;
			return content.some((part) => part.type !== "text") &&
				!content.some((part) => part.type === "text" && part.text.trim())
				? [entry.id]
				: [];
		});
		return {
			record: expected,
			request,
			opening: opening.message,
			entries,
			messages: entries.filter((entry) => entry.type === "message").map((entry) => entry.message),
			lifecycle,
			unresolvedToolCallIds: [...new Set(unresolvedToolCallIds)],
			ownerInputs,
			unavailableAttachmentEntryIds,
		};
	}

	/**
	 * How many worker attempts dispatched from this request's own turns have not reached a terminal status, read from the
	 * durable task runtime by each attempt's receipt origin (a model-transfer successor inherits it). A suspended attempt
	 * counts: every suspension (restart, retry, interrupt, model transfer) parks work its lane still owes. So does a source
	 * a model transfer cancelled before its reserved successor was admitted. Undefined when the session has no task
	 * runtime loaded: the count is then unknown, not zero.
	 */
	pendingLaunchedWork(evidence: OrdinaryWorkEvidence): number | undefined {
		const snapshot = this.deps.getTaskRuntimeSnapshot?.();
		if (!snapshot) return undefined;
		const scope = new Set(evidence.entries.map((entry) => entry.id));
		let pending = 0;
		for (const attempt of Object.values(snapshot.attempts)) {
			const origin = attempt.dispatch.receiptOrigin;
			if (
				origin?.sessionId === evidence.record.sessionId &&
				scope.has(origin.leafId) &&
				(!terminalAttemptStatus(attempt.status) || modelTransferIsPending(attempt.modelTransfer))
			)
				pending++;
		}
		return pending;
	}

	/** Recovery reads an existing DB record. It never enrolls historical owner messages or executes a recorded tool. */
	recover(): OrdinaryWorkEvidence | undefined {
		this.anchor = undefined;
		const current = this.current();
		if (current?.reason === ORDINARY_REPORTING_RESERVATION) {
			if (current.status === "active" && !this.reportingRevision(current))
				this.checkpoint(current, { status: "unverified", reason: "reporting_unverified" });
			return undefined;
		}
		if (current?.reason === "stop_review_in_progress") {
			if (current.status === "active") this.checkpoint(current, { status: "unverified", reason: current.reason });
			return undefined;
		}
		if (
			current?.status === "active" ||
			(current?.status === "unverified" && current.reason === "process_interrupted")
		)
			return this.evidence(current);
		if (current?.status === "waiting" && current.reason === "waiting") {
			const evidence = this.evidence(current);
			if (evidence && ordinaryCompletionReports(evidence).fresh) return evidence;
		}
		return undefined;
	}

	isCurrent(expected: OrdinaryWorkRecord): boolean {
		const current = this.current();
		return (
			current?.sessionId === expected.sessionId &&
			current.openingEntryId === expected.openingEntryId &&
			current.generation === expected.generation &&
			current.revision === expected.revision
		);
	}

	private mayAcquire(record: OrdinaryWorkRecord): boolean {
		return (
			record.leaseId === undefined ||
			record.leaseId === this.lease.id ||
			(record.leaseOwner !== undefined && isOwnerProvenDead(record.leaseOwner))
		);
	}

	private containsFrontier(frontierEntryId: string): boolean {
		const anchor = this.anchor!;
		const manager = anchor.manager;
		if (frontierEntryId === anchor.frontierEntryId || frontierEntryId === manager.getLeafId()) return true;
		let found = false;
		visitSessionAncestry(
			manager.getLeafEntry(),
			{ size: manager.getEntryCount(), get: (id) => manager.getEntry(id) },
			(entry) => {
				if (entry.id === frontierEntryId) found = true;
				if (found || entry.id === anchor.openingEntryId) return false;
			},
		);
		return found;
	}

	private remember(record: OrdinaryWorkRecord, frontierEntryId = record.frontierEntryId): void {
		const manager = this.deps.getSessionManager();
		const opening = manager.getEntry(record.openingEntryId);
		this.anchor = {
			manager,
			sessionId: record.sessionId,
			openingEntryId: record.openingEntryId,
			frontierEntryId,
			opening,
			ownerInputId: opening?.type === "message" ? opening.ownerInputId : undefined,
			assertBranch: manager.captureBranchContext(),
		};
	}

	private requiredStore(): OrdinaryWorkStore {
		const store = this.readStore();
		if (!store)
			throw new Error("Ordinary owner work requires the session decision database before provider dispatch.");
		return store;
	}

	private readStore(): OrdinaryWorkStore | undefined {
		this.cachedStore ??= this.deps.getStore();
		return this.cachedStore;
	}

	private noteUnavailable(): void {
		const sessionId = this.deps.getSessionManager().getSessionId();
		if (this.warnedUnavailableSession === sessionId) return;
		this.warnedUnavailableSession = sessionId;
		this.deps.warn?.(
			"Automatic request recovery is unavailable because the session database could not be opened. This request will run once.",
		);
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}
}
