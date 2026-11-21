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
import type { TaskRuntimeProjection } from "./orchestration/task-runtime-state.ts";
import { ordinaryCompletionReports } from "./ordinary-work-completions.ts";
import { type OrdinaryLateAnswer, readOrdinaryLateAnswer } from "./ordinary-work-late-answer.ts";
import { ORDINARY_REPORTING_RESERVATION, type OrdinaryReportingRequirements } from "./ordinary-work-policy.ts";
import {
	ORDINARY_WORK_LOOKUP_BATCH,
	type OrdinaryWorkRecord,
	type OrdinaryWorkStatus,
	type OrdinaryWorkStore,
	ordinaryWorkIsTerminal,
} from "./ordinary-work-store.ts";
import {
	awaitsLaunchedWork,
	ORDINARY_WORK_WAIT_RECHECK_MS,
	ordinaryWorkerWaitDeadline,
	pendingLaunchedAttempts,
} from "./ordinary-work-wait.ts";
import { isCompatibleOwnerSourceEntry, isOwnerSpokenInputId, type OwnerInputDelivery } from "./owner-input-ledger.ts";
import { ownerRequestForJudge } from "./security/owner-paste-boundary.ts";
import { entryTurnOrigin, isDecisiveOrigin } from "./turn-origin.ts";
import { alarmAt, SYSTEM_TIMER_PORT, type TimerPort, type TimerSource, type WallAlarm } from "./util/timer-port.ts";

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

/** The reason a request handed to explicit goal `goalId` waits with; the goal's end settles exactly these. */
function goalHandoffReason(goalId: string): string {
	return `explicit_goal_owns_request:${goalId}`;
}

interface OrdinaryWorkControllerDeps {
	reportingRequirements?(): OrdinaryReportingRequirements;
	getSessionManager(): SessionManager;
	getStore(): OrdinaryWorkStore | undefined;
	peekStore?(): OrdinaryWorkStore | undefined;
	isEnabled(): boolean;
	/** The goal that owns work started now (an active explicit goal), which takes over the ordinary request. */
	ownershipGoalId?(): string | undefined;
	/** Read only after `isEnabled` allowed the review, so it need not repeat that gate. */
	mayReview?(): boolean;
	warn?(message: string): void;
	now?: () => number;
	/** The durable task runtime, when this session has loaded one; the source of the launched-work fact. */
	getTaskRuntimeSnapshot?(): TaskRuntimeProjection | undefined;
	/** The session's timers: the `ordinary-work` clock stamps records and arms the wait alarm. */
	timers?: TimerSource;
	/** A request's wait on the work it launched ran out: review it now (`ordinary-work-wait.ts`). */
	onWorkerWaitExpired?(): void;
}

export class OrdinaryWorkController {
	private reportingReservation?: { record: OrdinaryWorkRecord; snapshot: OrdinaryReportingRequirements; text: string };
	private readonly deps: OrdinaryWorkControllerDeps;
	private readonly lease = { id: randomUUID(), ...ownProcessOwner() };
	private pendingOpening: { sessionId: string; entryId: string } | undefined;
	private cachedStore: OrdinaryWorkStore | undefined;
	private warnedUnavailableSession: string | undefined;
	private storageReadFailed = false;
	private waitAlarm: WallAlarm | undefined;
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
		return this.deps.isEnabled() && !this.deps.ownershipGoalId?.() && this.deps.mayReview?.() !== false;
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

	/**
	 * What the request opened by owner batch `ref` of `channel` still owes that chat after the answer at `afterEntryId`
	 * was sent (`ordinary-work-late-answer.ts`). Undefined when this session cannot tell: ordinary work is off or not
	 * persisted, its store is not loaded, or the batch's opening is not on this session's branch.
	 */
	lateAnswer(channel: string, ref: string, afterEntryId: string): OrdinaryLateAnswer | undefined {
		const manager = this.deps.getSessionManager();
		if (!this.deps.isEnabled() || !manager.isPersisted()) return undefined;
		const store = this.cachedStore ?? this.deps.peekStore?.();
		if (!store) return undefined;
		const branch = manager.getBranch();
		const index = branch.findIndex((entry) => {
			const origin = entryTurnOrigin(entry);
			return origin?.k === "owner-channel" && origin.channel === channel && origin.ref === ref;
		});
		if (index === -1) return undefined;
		// Read with payloads, as the stop evidence is (a cold answer's text is not on the plain branch), and only from the
		// sent answer on, once the request settled.
		return readOrdinaryLateAnswer(
			this.requestContaining(store, manager.getSessionId(), branch, index),
			() => manager.getFullHistoryChainWithPayloads(undefined, afterEntryId),
			afterEntryId,
		);
	}

	/**
	 * The request whose turns hold the owner input at `branch[index]`: the one it opened, or the nearest earlier request it
	 * joined as a follow-up (that request's frontier reached it). An input no request took (an explicit goal owned the
	 * work) has none.
	 */
	private requestContaining(
		store: OrdinaryWorkStore,
		sessionId: string,
		branch: readonly SessionEntry[],
		index: number,
	): OrdinaryWorkRecord | undefined {
		for (let i = index; i >= 0; i--) {
			const entry = branch[i]!;
			if (!isCompatibleOwnerSourceEntry(entry)) continue;
			const record = store.get(sessionId, entry.id);
			if (!record) continue;
			if (i === index) return record;
			return branch.findIndex((candidate) => candidate.id === record.frontierEntryId) >= index ? record : undefined;
		}
		return undefined;
	}

	/**
	 * The goal that took over a request settles it when the goal ends: a completed goal fulfills it (the goal's own
	 * completion gate verified the work), a cancelled one cancels it. A goal stopped by a block, a limit or a pause keeps
	 * it, since that goal resumes on its own.
	 */
	settleGoalHandoff(goal: { readonly goalId: string; readonly status: string }): void {
		if (goal.status !== "completed" && goal.status !== "cancelled") return;
		const manager = this.deps.getSessionManager();
		if (!this.deps.isEnabled() || !manager.isPersisted()) return;
		const completed = goal.status === "completed";
		const reason = goalHandoffReason(goal.goalId);
		try {
			const store = this.readStore();
			if (!store) return;
			for (const record of store.forSession(manager.getSessionId())) {
				if (record.status !== "waiting" || record.reason !== reason) continue;
				store.checkpoint(
					record,
					{
						status: completed ? "fulfilled" : "cancelled",
						frontierEntryId: record.frontierEntryId,
						reason: completed ? "goal_completed" : "goal_cancelled",
					},
					this.now(),
				);
			}
		} catch (error) {
			this.deps.warn?.(
				`The goal ended, but the request it took over could not be settled: ${error instanceof Error ? error.message : String(error)}`,
			);
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
		const goalId = this.deps.ownershipGoalId?.();
		if (goalId !== undefined) {
			this.pendingOpening = undefined;
			// Only a request still working is handed over; one already settled or held keeps its own outcome.
			if (current?.status === "active" || (current !== undefined && awaitsLaunchedWork(current)))
				this.checkpoint(current, { status: "waiting", reason: goalHandoffReason(goalId) });
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
		// A follow-up joins the request still active, or waiting on work it launched (also once its automatic checks on that
		// work ran out): that work stays in the request's scope, so its result settles the request the follow-up became part of.
		const joins =
			(current?.status === "active" && current.leaseId === this.lease.id) ||
			(current !== undefined && awaitsLaunchedWork(current));
		try {
			if (current && joins)
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

	/** The session closes: its wait alarm stops, and its work is released (`release`). */
	dispose(): void {
		this.waitAlarm?.stop();
		this.waitAlarm = undefined;
		this.release();
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
		// The request's turns start mid-branch: a compaction among them may keep a tail that starts before its opening.
		let earlier: Set<string> | undefined;
		const lifecycle = inspectSessionLifecycle(entries, undefined, (entryId) => {
			if (!earlier) {
				earlier = new Set();
				const ids = earlier;
				visitSessionAncestry(
					manager.getEntry(opening.id),
					{ size: manager.getEntryCount(), get: (id) => manager.getEntry(id) },
					(entry) => {
						if (entry.id !== opening.id) ids.add(entry.id);
					},
				);
			}
			return earlier.has(entryId);
		});
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
	 * How many worker attempts dispatched from this request's own turns still owe their result
	 * (`pendingLaunchedAttempts`). Undefined when the session has no task runtime loaded: the count is then unknown, not
	 * zero.
	 */
	pendingLaunchedWork(evidence: OrdinaryWorkEvidence): number | undefined {
		const snapshot = this.deps.getTaskRuntimeSnapshot?.();
		return snapshot && pendingLaunchedAttempts(snapshot, evidence.record.sessionId, evidence.entries).length;
	}

	/** The request of `evidence` waits on work it launched and its wait has run out (`ordinary-work-wait.ts`). */
	workerWaitExpired(evidence: OrdinaryWorkEvidence): boolean {
		const deadline = this.workerWaitDeadline(evidence.record, evidence.entries);
		return deadline !== undefined && this.now() >= deadline;
	}

	/**
	 * Arm the one alarm for when `record`, waiting on the work its turns (`entries`) launched, runs out of wait. The alarm
	 * asks for a review, and asks again every `ORDINARY_WORK_WAIT_RECHECK_MS` while the record has not moved (the session
	 * could not review yet); a review that took moves it and ends the alarm.
	 */
	armWorkerWait(record: OrdinaryWorkRecord, entries: readonly SessionEntry[]): void {
		this.waitAlarm?.stop();
		this.waitAlarm = undefined;
		const deadline = this.deps.onWorkerWaitExpired && this.workerWaitDeadline(record, entries);
		if (deadline === undefined) return;
		const clock = this.clock();
		const fire = (): void => {
			this.waitAlarm = undefined;
			if (!this.deps.isEnabled() || !this.isCurrent(record)) return;
			this.waitAlarm = alarmAt(clock, clock.now() + ORDINARY_WORK_WAIT_RECHECK_MS, fire);
			this.deps.onWorkerWaitExpired?.();
		};
		this.waitAlarm = alarmAt(clock, deadline, fire);
	}

	private workerWaitDeadline(record: OrdinaryWorkRecord, entries: readonly SessionEntry[]): number | undefined {
		const snapshot = this.deps.getTaskRuntimeSnapshot?.();
		if (!snapshot) return undefined;
		const orchestration = this.deps.timers?.port("orchestration") ?? SYSTEM_TIMER_PORT;
		const pending = pendingLaunchedAttempts(snapshot, record.sessionId, entries);
		return ordinaryWorkerWaitDeadline(record, pending, this.now(), orchestration.now());
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
		if (current && awaitsLaunchedWork(current)) {
			const evidence = this.evidence(current);
			if (!evidence) return undefined;
			if (ordinaryCompletionReports(evidence).fresh || this.workerWaitExpired(evidence)) return evidence;
			this.armWorkerWait(current, evidence.entries);
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

	private clock(): TimerPort {
		return this.deps.timers?.port("ordinary-work") ?? SYSTEM_TIMER_PORT;
	}

	private now(): number {
		return this.deps.now?.() ?? this.clock().now();
	}
}
