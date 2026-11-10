import { harnessLog } from "../kernel/harness-log.ts";
import type { CustomMessage } from "../kernel/index.ts";
import type { WorkerHostVerdict } from "./autonomy/contracts.ts";
import type { LaneTerminalStatus } from "./autonomy/lane-tracker.ts";
import {
	type BackgroundToolTaskRecord,
	type BackgroundToolTerminalDeliveryReceipt,
	type BackgroundToolTerminalIdentity,
	projectBackgroundToolTerminalDelivery,
	sameBackgroundToolTerminal,
} from "./background-tool-task-controller.ts";
import { COMMS_RECORD_VERSION, renderCommsStateLine } from "./comms/comms-records.ts";
import type { WorkerClaimSnapshotPayload } from "./delegation/session-worker-claim.ts";
import {
	fenceWorkerClaimValues,
	handoffClaimLine,
	handoffClaimValue,
	handoffReasonCode,
	workerClaimSettlementLines,
} from "./delegation/worker-claim.ts";
import {
	deriveWorkerNextStepFromProjections,
	type WorkerNextStep,
	workerDispositionAdviceFromStep,
	workerDispositionGuidance,
	workerLaneStateCodes,
} from "./delegation/worker-disposition.ts";
import { FANOUT_LINE_MAX_CHARS, type FanoutGroupReport, fanoutNoteForLane } from "./delegation/worker-fanout.ts";
import { selectedWorkerAttempt } from "./delegation/worker-lane-projection.ts";
import {
	type WorkerTerminalHandoffRecord,
	workerTerminalGenerationIdentity,
} from "./delegation/worker-notification-coordinator.ts";
import {
	describeOutcomeForHandoff,
	nextActionPhrase,
	type Outcome,
	projectOutcome,
	sameOutcomeAttempt,
} from "./delegation/worker-outcome.ts";
import { taskOutcomeId } from "./delegation/worker-outcome-codec.ts";
import { workerTerminalOutputArtifact } from "./delegation/worker-terminal-output-artifact.ts";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import { type GoalState, isGoalExecutionActive } from "./goals/goal-state.ts";
import { conversationTurnOrigin } from "./orchestration/attempt-agent-identity.ts";
import type { ArtifactContract, WorkerResultContract } from "./orchestration/contracts.ts";
import type { TaskRuntimeProjection } from "./orchestration/task-runtime-state.ts";
import {
	BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE,
	PROOF_SHEET_BATCH_MAX_BYTES,
	PROOF_SHEET_DETAILS_KEY,
	PROOF_SHEET_FAILURES_DETAILS_KEY,
	PROOF_SHEET_MAX_BYTES,
	type ProofSheetRecord,
	proofSheetUnavailableLine,
} from "./proof/proof-sheet.ts";
import { buildWorkerProofSheet } from "./proof/worker-proof-sheet.ts";
import type { CommsStateCode } from "./provider-prompt-contracts.ts";
import { wrapUntrustedText } from "./security/untrusted-boundary.ts";
import { boundedUtf8Text } from "./util/bounded-line.ts";

export type BackgroundActivitySummaryKind = "agent" | "task";
export type BackgroundActivitySummaryStatus = "success" | "attention" | "failed" | "canceled";

export interface BackgroundActivitySummaryItem {
	id: string;
	status: BackgroundActivitySummaryStatus;
}

/** Provider-neutral counts retained when the detailed handoff is bounded. */
export interface BackgroundActivitySummaryContract {
	kind: BackgroundActivitySummaryKind;
	totalCount: number;
	attentionCount: number;
	failedCount: number;
	canceledCount: number;
}

export function createBackgroundActivitySummaryContract(
	kind: BackgroundActivitySummaryKind,
	items: readonly BackgroundActivitySummaryItem[],
): BackgroundActivitySummaryContract {
	return {
		kind,
		totalCount: items.length,
		attentionCount: items.filter((item) => item.status === "attention").length,
		failedCount: items.filter((item) => item.status === "failed").length,
		canceledCount: items.filter((item) => item.status === "canceled").length,
	};
}

export function isBackgroundActivitySummaryContract(value: unknown): value is BackgroundActivitySummaryContract {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const summary = value as Record<string, unknown>;
	const counts = ["totalCount", "attentionCount", "failedCount", "canceledCount"] as const;
	if (summary.kind !== "agent" && summary.kind !== "task") return false;
	if (
		counts.some(
			(field) =>
				typeof summary[field] !== "number" ||
				!Number.isSafeInteger(summary[field]) ||
				(summary[field] as number) < 0,
		)
	) {
		return false;
	}
	const totalCount = summary.totalCount as number;
	return (
		totalCount > 0 &&
		(summary.attentionCount as number) + (summary.failedCount as number) + (summary.canceledCount as number) <=
			totalCount
	);
}

function workerSummaryStatus(
	record: Pick<WorkerTerminalHandoffRecord, "status">,
	claimNeedsReview: boolean,
): BackgroundActivitySummaryStatus {
	if (record.status === "failed" || record.status === "timeout" || record.status === "budget_exhausted") {
		return "failed";
	}
	if (record.status === "canceled") return "canceled";
	if (claimNeedsReview || record.status === "partial" || record.status === "blocked") return "attention";
	return "success";
}

interface ForegroundTerminalHandoffControllerDeps {
	foreground: ForegroundRecoveryController;
	isDisposed(): boolean;
	getGoalStateSnapshot():
		| (Pick<GoalState, "goalId" | "status"> & Partial<Pick<GoalState, "requirements">>)
		| undefined;
	/** The orchestration projection the recommended disposition reads; absent leaves open-task facts unknown. */
	getTaskRuntimeSnapshot?(): TaskRuntimeProjection | undefined;
	/** The claim of the exact generation when `attemptId` is given; never another generation's. */
	getWorkerClaimSnapshot?(laneId: string, attemptId?: string): WorkerClaimSnapshotPayload | undefined;
	/** The result of the exact generation when `attemptId` is given; never another generation's. */
	getWorkerResult?(laneId: string, attemptId?: string): Pick<WorkerResultContract, "artifacts"> | undefined;
	/** The fan-out groups of this session's lanes: a block of a grouped lane names its coverage and its race winner. */
	getWorkerFanoutGroups?(): readonly FanoutGroupReport[];
	/** The bot whose runtime a lane is, by id and the name its record shows; undefined for a lane that is no bot's. */
	getWorkerBot?(laneId: string): { agentId: string; displayName?: string } | undefined;
	startCustomMessageTurn(
		message: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">,
		lease: ForegroundSubmissionLease,
		goalId?: string,
	): Promise<{ completion: Promise<void> }>;
	enqueueCustomMessageTurn(
		message: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">,
	): Promise<void>;
	sendCustomMessage(
		message: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">,
		options: { triggerTurn: false; deliverAs: "followUp" },
		lease: ForegroundSubmissionLease,
	): Promise<void>;
	/** Owner items buffered while no foreground turn ran; a handoff that wakes no turn flushes them under its lease. */
	flushOwnerItems(lease: ForegroundSubmissionLease): Promise<void>;
	warn(message: string): void;
	/** The embedder's interposition on each worker terminal delivery; absent delivers directly. */
	interposeWorkerDelivery?: WorkerTerminalDeliveryInterposer;
}

/**
 * Runs around one worker terminal delivery: `deliver` performs it and settles once the parent has it. Rejecting without
 * calling `deliver` is a failed handoff; the worker notification outbox keeps the records and retries them on its backoff.
 */
export type WorkerTerminalDeliveryInterposer = (
	records: readonly WorkerTerminalHandoffRecord[],
	deliver: () => Promise<void>,
) => Promise<void>;

type TerminalCustomMessage = Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">;

interface TerminalDeliveryPlan {
	message: TerminalCustomMessage;
	wakeParent: boolean;
	goalId?: string;
	/**
	 * Foreground submission epoch that owned every record in this delivery, or undefined when that
	 * is not established (no records carry one, or they disagree). `flushProviderBoundary` folds
	 * only when this equals the CURRENT submission's epoch -- see `resolveWake`.
	 */
	ownerEpoch?: number;
	/** Exact background tool revisions whose output this plan's message carries in full. */
	deliveredTerminals?: readonly BackgroundToolTerminalIdentity[];
}

/** Terminal revisions read by a delivery; a plan that delivered no tool output reports none. */
type DeliveryReceipt = readonly BackgroundToolTerminalIdentity[];

export interface ForegroundTerminalHandoffResourceSnapshot {
	readonly pendingDeliveries: number;
	readonly activeDeliveryIdentities: number;
}

interface PendingTerminalDelivery {
	prepare(): TerminalDeliveryPlan | undefined;
	resolve(receipt: DeliveryReceipt): void;
	reject(error: unknown): void;
}

const NOTHING_DELIVERED: DeliveryReceipt = [];

const MAX_DELIVERED_TERMINAL_IDENTITIES = 512;
const ATTENTION_CLAIM_STATUSES: ReadonlySet<LaneTerminalStatus> = new Set(["blocked", "partial"]);
const MAX_ATTENTION_CLAIM_SUMMARY_BYTES = 16 * 1024;

/** The reading guidance for a woken parent: each lane's own Next line carries its step, so one fixed line follows. */
function workerHandoffGuidanceLine(records: readonly { nextStep?: WorkerNextStep }[]): string {
	return records.some((record) => record.nextStep !== undefined)
		? "Read each lane with delegate status and verify the claim before acting. Each Next line is advice; you decide. Then continue or replan the parent task."
		: "Read each lane with delegate status, verify the claim, then continue or replan the parent task.";
}

/** `Next: <plain step>; <how to act on the worker>. <reason>` -- one line per lane, chosen from the typed next action. */
function describeHandoffNextStep(nextStep: WorkerNextStep, hostVerdict: WorkerHostVerdict | undefined): string {
	const advised = workerDispositionAdviceFromStep(nextStep);
	return `Next: ${nextActionPhrase(nextStep.nextAction)}; ${workerDispositionGuidance(advised, hostVerdict)}. ${advised.reason}`;
}

export function buildForegroundWorkerTerminalHandoffContent(
	records: readonly {
		laneId: string;
		status: LaneTerminalStatus;
		reasonCode?: string;
		reasonDetail?: string;
		outputArtifact?: ArtifactContract;
		/** Host-written fan-out group line; reason codes inside it are already identifier-sanitized. */
		fanout?: string;
		/** The bot this lane is the runtime of, when a persistent bot owns it: the root asked that bot, so it is named. */
		bot?: { agentId: string; displayName?: string };
		/** The host's judgment of the claim against the receipts; names the missing proof a follow-up asks for. */
		hostVerdict?: WorkerHostVerdict;
		/** The host-computed outcome of this exact attempt. */
		outcome?: Outcome;
		/** The typed next step for the worker; the root decides. */
		nextStep?: WorkerNextStep;
		/** Host state codes for this lane (see `workerHandoffStateCodes`); the glossary lives in the root prompt. */
		h?: readonly CommsStateCode[];
		claim?: {
			summary?: string;
			status?: string;
			changedFiles?: readonly string[];
			blockers?: readonly string[];
			inconclusive?: readonly string[];
			systemOneSettled?: readonly string[];
			ownerFollowUp?: string;
			parentReviewRequired?: boolean;
			verification?: { subjectTaskId: string; verdict: "accepted" | "rejected"; reasonCodes: readonly string[] };
		};
	}[],
	options?: { wakeParent?: boolean; totalCount?: number },
): string {
	const included = records.slice(0, 8);
	const omitted = Math.max(0, (options?.totalCount ?? records.length) - included.length);
	const wakeParent = options?.wakeParent ?? true;
	return [
		"Background worker terminal handoff:",
		...included.flatMap((record) => {
			// A verifier's reason codes ride in the lane reason, so only identifier characters pass: the header
			// line cannot carry free text a worker chose.
			const reason = record.reasonCode ? ` reason=${handoffReasonCode(record.reasonCode)}` : "";
			const lines = [`- ${record.laneId}: ${record.status}${reason}`];
			// The bot's own id is an identifier; its display name is free text the caller chose, so it stays on one line and bounded.
			if (record.bot) {
				const name = boundedUtf8Text(record.bot.displayName?.replace(/[\r\n]+/g, " ").trim() ?? "", 80);
				lines.push(`  Bot: ${record.bot.agentId}${name && name !== record.bot.agentId ? ` (${name})` : ""}`);
			}
			if (record.reasonDetail)
				lines.push(
					`  Diagnostic (untrusted):\n${wrapUntrustedText(record.reasonDetail, `worker-diagnostic:${record.laneId}`)}`,
				);
			if (record.fanout)
				lines.push(`  Fan-out: ${record.fanout.replace(/[\r\n]+/g, " ").slice(0, FANOUT_LINE_MAX_CHARS)}`);
			if (record.outputArtifact) {
				lines.push(
					`  Full Output: ${record.outputArtifact.uri}${record.outputArtifact.sizeBytes === undefined ? "" : ` (${record.outputArtifact.sizeBytes} bytes)`}`,
				);
			}
			if (record.outcome) lines.push(`  ${describeOutcomeForHandoff(record.outcome)}`);
			if (record.claim?.summary) {
				const source = `worker-claim:${record.laneId}`;
				// A verifier's rejection is the finding the receiving agent must reproduce: it is carried
				// as fully as a blocked or partial claim, never cut to the one-line success form.
				const summary =
					ATTENTION_CLAIM_STATUSES.has(record.status) || record.claim.verification?.verdict === "rejected"
						? boundedUtf8Text(record.claim.summary, MAX_ATTENTION_CLAIM_SUMMARY_BYTES)
						: handoffClaimLine(record.claim.summary);
				lines.push(`  Claim Summary (untrusted worker evidence):\n${wrapUntrustedText(summary, source)}`);
				// Every worker-supplied value is data: each list sits in its own nonce fence, bounded per value.
				const fence = (values: readonly string[], path = false): string =>
					fenceWorkerClaimValues(values, handoffClaimValue, source, undefined, path);
				if (record.claim.changedFiles && record.claim.changedFiles.length > 0) {
					lines.push(`  Changed Files (untrusted worker evidence):\n${fence(record.claim.changedFiles, true)}`);
				}
				if (record.claim.blockers && record.claim.blockers.length > 0) {
					lines.push(`  Blockers (untrusted worker evidence):\n${fence(record.claim.blockers)}`);
				}
				if (record.claim.verification) {
					const { subjectTaskId, verdict, reasonCodes } = record.claim.verification;
					lines.push(
						`  Verification verdict: ${verdict} (subject and reason codes, untrusted worker evidence):\n${fence([subjectTaskId, ...reasonCodes])}`,
					);
				}
				for (const line of workerClaimSettlementLines(record.claim, handoffClaimValue, source))
					lines.push(`  ${line}`);
			}
			if (record.nextStep) lines.push(`  ${describeHandoffNextStep(record.nextStep, record.hostVerdict)}`);
			else if (record.outcome) lines.push(`  Next: ${nextActionPhrase(record.outcome.nextAction)}.`);
			const stateLine = renderCommsStateLine(record.h ?? []);
			if (stateLine) lines.push(`  ${stateLine}`);
			return lines;
		}),
		...(omitted > 0 ? [`- ${omitted} additional terminal worker(s) omitted.`] : []),
		"h DELIVERED",
		...(wakeParent
			? [workerHandoffGuidanceLine(included)]
			: [
					"The owning parent is no longer eligible for automatic continuation. Persist this handoff, but do not continue or replan automatically.",
				]),
		...(wakeParent
			? [
					'Parent woke. Evaluated terminal claim payload above. Use delegate { action: "status", laneId } for deep view if needed.',
				]
			: ["Parent was not woken. Wait for explicit user input before reading a lane or starting more work."]),
	].join("\n");
}

/** Serializes durable background terminal delivery through the foreground submission owner. */
export class ForegroundTerminalHandoffController {
	private readonly deps: ForegroundTerminalHandoffControllerDeps;
	private readonly pending = new Set<PendingTerminalDelivery>();
	private readonly terminalDeliveries = new Map<string, Promise<DeliveryReceipt>>();
	private readonly deliveredTerminalIdentities = new Set<string>();

	constructor(deps: ForegroundTerminalHandoffControllerDeps) {
		this.deps = deps;
	}

	/** Pending records and actual delivery lifetime differ; the bounded replay cache is intentionally retained. */
	getResourceSnapshot(): ForegroundTerminalHandoffResourceSnapshot {
		return {
			pendingDeliveries: this.pending.size,
			activeDeliveryIdentities: this.terminalDeliveries.size,
		};
	}

	async notifyWorkers(records: readonly WorkerTerminalHandoffRecord[]): Promise<void> {
		if (records.every((record) => record.observedAt !== undefined)) return;
		this.assertLive("worker terminal handoff was persisted");
		const deliver = async (): Promise<void> => {
			await this.scheduleUnique(
				records,
				(record) => ["worker", workerTerminalGenerationIdentity(record)].join("\0"),
				(uniqueRecords) => this.prepareWorkerDelivery(uniqueRecords),
			);
		};
		await (this.deps.interposeWorkerDelivery ? this.deps.interposeWorkerDelivery(records, deliver) : deliver());
	}

	/**
	 * Resolves with the receipt of what the delivered wake-up read: the ids whose output it carried
	 * in full, restricted to this call's own records. The message is built from the records still
	 * unread at delivery time, so the receipt reflects the delivery, never the request.
	 */
	async notifyTools(
		records: readonly BackgroundToolTaskRecord[],
		wakeParent: boolean,
	): Promise<BackgroundToolTerminalDeliveryReceipt> {
		if (!wakeParent || records.every((record) => record.observedAt !== undefined)) {
			return { deliveredTaskIds: [], deliveredTerminals: [] };
		}
		this.assertLive("background tool terminal handoff was delivered");
		const delivered = await this.scheduleUnique(
			records,
			(record) => ["tool", record.sessionId, record.taskId, record.completedAt ?? "", record.status].join("\0"),
			(uniqueRecords) => this.prepareToolDelivery(uniqueRecords),
		);
		const deliveredTerminals = delivered.filter((terminal) =>
			records.some((record) => sameBackgroundToolTerminal(record, terminal)),
		);
		return { deliveredTaskIds: deliveredTerminals.map((record) => record.taskId), deliveredTerminals };
	}

	/** Deliver queued terminals immediately before the agent loop polls its steering inbox. */
	flushProviderBoundary(): void {
		for (const pending of [...this.pending]) {
			try {
				this.assertLive("terminal handoff reached a provider boundary");
				const plan = pending.prepare();
				if (!plan) {
					this.pending.delete(pending);
					pending.resolve(NOTHING_DELIVERED);
					continue;
				}
				if (!plan.wakeParent) continue;
				// Fold only into a request belonging to the submission that started the task. An
				// absent owner epoch (legacy/resumed/cross-process record, or a batch whose records
				// disagree) must NEVER satisfy this check, even when no submission is currently held
				// either -- checked as its own guard, ahead of and independent of the equality
				// comparison, so `undefined === undefined` can never read as a match by construction.
				// A rejected delivery is left exactly as `!plan.wakeParent` already leaves one: still
				// in `this.pending`, still eligible for the idle route on its own turn.
				if (plan.ownerEpoch === undefined || plan.ownerEpoch !== this.deps.foreground.getCurrentSubmissionEpoch()) {
					continue;
				}
				this.pending.delete(pending);
				void this.deps
					.enqueueCustomMessageTurn(plan.message)
					.then(() => pending.resolve(plan.deliveredTerminals ?? NOTHING_DELIVERED), pending.reject);
			} catch (error) {
				this.pending.delete(pending);
				pending.reject(error);
			}
		}
	}

	private schedule(prepare: () => TerminalDeliveryPlan | undefined): Promise<DeliveryReceipt> {
		return new Promise<DeliveryReceipt>((resolve, reject) => {
			const pending: PendingTerminalDelivery = { prepare, resolve, reject };
			this.pending.add(pending);
			void this.deliverWhenIdle(pending);
		});
	}

	private async scheduleUnique<T>(
		records: readonly T[],
		identity: (record: T) => string,
		prepare: (records: readonly T[]) => TerminalDeliveryPlan | undefined,
	): Promise<DeliveryReceipt> {
		const receipts = new Set<Promise<DeliveryReceipt>>();
		const uniqueRecords: T[] = [];
		const uniqueIdentities: string[] = [];
		for (const record of records) {
			const key = identity(record);
			if (this.deliveredTerminalIdentities.has(key)) continue;
			const inFlight = this.terminalDeliveries.get(key);
			if (inFlight) {
				receipts.add(inFlight);
				continue;
			}
			uniqueRecords.push(record);
			uniqueIdentities.push(key);
		}
		if (uniqueRecords.length > 0) {
			const delivery = this.schedule(() => prepare(uniqueRecords));
			for (const key of uniqueIdentities) this.terminalDeliveries.set(key, delivery);
			receipts.add(delivery);
			void delivery.then(
				() => {
					for (const key of uniqueIdentities) {
						if (this.terminalDeliveries.get(key) === delivery) this.terminalDeliveries.delete(key);
						this.rememberDeliveredTerminal(key);
					}
				},
				() => {
					for (const key of uniqueIdentities) {
						if (this.terminalDeliveries.get(key) === delivery) this.terminalDeliveries.delete(key);
					}
				},
			);
		}
		return (await Promise.all(receipts)).flat();
	}

	private rememberDeliveredTerminal(identity: string): void {
		this.deliveredTerminalIdentities.delete(identity);
		this.deliveredTerminalIdentities.add(identity);
		while (this.deliveredTerminalIdentities.size > MAX_DELIVERED_TERMINAL_IDENTITIES) {
			const oldest = this.deliveredTerminalIdentities.values().next().value;
			if (oldest === undefined) break;
			this.deliveredTerminalIdentities.delete(oldest);
		}
	}

	private async deliverWhenIdle(pending: PendingTerminalDelivery): Promise<void> {
		try {
			while (this.pending.has(pending)) {
				const lease = await this.deps.foreground.acquireSubmission();
				let transferred = false;
				try {
					if (!this.pending.delete(pending)) return;
					this.assertLive("terminal handoff was waiting for foreground admission");
					const plan = pending.prepare();
					transferred = true;
					await this.deliverWithLease(plan, lease);
					pending.resolve(plan?.deliveredTerminals ?? NOTHING_DELIVERED);
				} catch (error) {
					pending.reject(error);
				} finally {
					if (!transferred) this.deps.foreground.releaseSubmission(lease);
				}
				return;
			}
		} catch (error) {
			if (this.pending.delete(pending)) pending.reject(error);
		}
	}

	private async deliverWithLease(
		plan: TerminalDeliveryPlan | undefined,
		lease: ForegroundSubmissionLease,
	): Promise<void> {
		let releaseLease = true;
		try {
			if (!plan) return;
			if (plan.wakeParent) {
				const started = await this.deps.startCustomMessageTurn(plan.message, lease, plan.goalId);
				this.releaseAfterTurn(started.completion, lease, "background terminal handoff turn");
				releaseLease = false;
				return;
			}
			await this.deps.sendCustomMessage(plan.message, { triggerTurn: false, deliverAs: "followUp" }, lease);
			// No turn follows this handoff, so no turn end will flush the owner items its workers buffered.
			try {
				await this.deps.flushOwnerItems(lease);
			} catch (error) {
				this.deps.warn(
					`Owner items could not be delivered after a background handoff: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} finally {
			if (releaseLease) this.deps.foreground.releaseSubmission(lease);
		}
	}

	private prepareWorkerDelivery(records: readonly WorkerTerminalHandoffRecord[]): TerminalDeliveryPlan | undefined {
		const unread = records.filter((record) => record.observedAt === undefined);
		if (unread.length === 0) return undefined;
		const prepared = unread.map((record, index) => {
			const snapshot = this.deps.getWorkerClaimSnapshot?.(record.laneId, record.attemptId);
			const claim = snapshot?.claim;
			const outputArtifact =
				index < 8
					? workerTerminalOutputArtifact(this.deps.getWorkerResult?.(record.laneId, record.attemptId))
					: undefined;
			const groups = index < 8 ? this.deps.getWorkerFanoutGroups?.() : undefined;
			const fanout = groups ? fanoutNoteForLane(groups, record.laneId) : undefined;
			const bot = index < 8 ? this.deps.getWorkerBot?.(record.laneId) : undefined;
			const outcome = index < 8 ? this.terminalOutcome(record.laneId, record.attemptId, claim) : undefined;
			const nextStep = index < 8 && claim ? this.nextStep(claim, record.laneId, record.attemptId) : undefined;
			return {
				summaryItem: {
					id: record.laneId,
					status: workerSummaryStatus(
						record,
						claim?.parentReviewRequired === true || claim?.verification?.verdict === "rejected",
					),
				},
				laneId: record.laneId,
				...(record.attemptId ? { attemptId: record.attemptId } : {}),
				status: record.status,
				...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
				...(record.reasonDetail ? { reasonDetail: record.reasonDetail } : {}),
				...(outputArtifact ? { outputArtifact } : {}),
				...(fanout ? { fanout } : {}),
				...(bot ? { bot } : {}),
				...(claim?.hostVerdict ? { hostVerdict: claim.hostVerdict } : {}),
				...(outcome ? { outcome } : {}),
				...(nextStep ? { nextStep } : {}),
				h: workerLaneStateCodes(record, claim),
				...(claim
					? {
							claim: {
								status: claim.status,
								summary: boundedUtf8Text(
									claim.summary,
									ATTENTION_CLAIM_STATUSES.has(record.status) || claim.verification?.verdict === "rejected"
										? MAX_ATTENTION_CLAIM_SUMMARY_BYTES
										: 1000,
								),
								changedFiles: claim.changedFiles,
								...(claim.blockers ? { blockers: claim.blockers } : {}),
								...(claim.inconclusive ? { inconclusive: claim.inconclusive } : {}),
								...(claim.systemOneSettled ? { systemOneSettled: claim.systemOneSettled } : {}),
								...(claim.ownerFollowUp ? { ownerFollowUp: claim.ownerFollowUp } : {}),
								...(claim.parentReviewRequired ? { parentReviewRequired: true } : {}),
								...(claim.verification ? { verification: claim.verification } : {}),
							},
						}
					: {}),
			};
		});
		const included = prepared.slice(0, 8).map(({ summaryItem: _summaryItem, ...record }) => record);
		// The stored message keeps the outcome's verdict fields; the whole outcome stays in the orchestration journal.
		const detailRecords = included.map(({ outcome, nextStep, ...record }) => ({
			...record,
			...(outcome
				? {
						outcome: {
							outcomeId: outcome.outcomeId,
							status: outcome.status,
							blocker: outcome.blocker,
							assurance: outcome.assurance,
							nextAction: outcome.nextAction.kind,
						},
					}
				: {}),
			...(nextStep ? { recommendedDisposition: workerDispositionAdviceFromStep(nextStep) } : {}),
		}));
		const wake = this.resolveWake(unread);
		// A report of work a third party's words reached opens a third-party run (`customTurnOrigin`).
		const snapshot = this.deps.getTaskRuntimeSnapshot?.();
		const sheetBytes = Math.min(
			PROOF_SHEET_MAX_BYTES,
			Math.floor(PROOF_SHEET_BATCH_MAX_BYTES / Math.max(1, included.length)),
		);
		// Each result's sheet is built on its own: a sheet that cannot be built leaves its result delivered without one, with a plain line.
		const proofSheets: ProofSheetRecord[] = [];
		const proofSheetFailures: string[] = [];
		for (const record of included) {
			try {
				proofSheets.push(this.workerProofSheet(record, snapshot, sheetBytes));
			} catch (error) {
				harnessLog.warn("proof", "a worker result's proof sheet could not be built; it is delivered without one", {
					laneId: record.laneId,
					...(record.attemptId !== undefined ? { attemptId: record.attemptId } : {}),
				});
				const attempt = record.attemptId !== undefined ? snapshot?.attempts[record.attemptId] : undefined;
				const title = attempt ? snapshot?.tasks[attempt.taskId]?.task?.title : undefined;
				proofSheetFailures.push(proofSheetUnavailableLine(error, title));
			}
		}
		const thirdParty =
			snapshot !== undefined &&
			Object.values(snapshot.attempts).some(
				(attempt) =>
					unread.some((record) =>
						record.attemptId ? attempt.attemptId === record.attemptId : attempt.taskId === record.laneId,
					) && conversationTurnOrigin(snapshot, attempt)?.thirdParty === true,
			);
		return {
			message: {
				customType: BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE,
				content: buildForegroundWorkerTerminalHandoffContent(included, {
					wakeParent: wake.wakeParent,
					totalCount: unread.length,
				}),
				display: true,
				details: {
					v: COMMS_RECORD_VERSION,
					records: detailRecords,
					summary: createBackgroundActivitySummaryContract(
						"agent",
						prepared.map((entry) => entry.summaryItem),
					),
					...(thirdParty ? { thirdParty: true } : {}),
					// Owner-facing only: the sheets quote worker-written strings, so they stay out of the model's content.
					...(proofSheets.length > 0 ? { [PROOF_SHEET_DETAILS_KEY]: proofSheets } : {}),
					...(proofSheetFailures.length > 0 ? { [PROOF_SHEET_FAILURES_DETAILS_KEY]: proofSheetFailures } : {}),
				},
			},
			...wake,
		};
	}

	/** The proof sheet of one included worker result, from its claim, outcome and dispatch. */
	private workerProofSheet(
		record: {
			laneId: string;
			attemptId?: string;
			outcome?: Outcome;
			outputArtifact?: ArtifactContract;
		},
		snapshot: TaskRuntimeProjection | undefined,
		maxTextBytes: number,
	): ProofSheetRecord {
		const claim = this.deps.getWorkerClaimSnapshot?.(record.laneId, record.attemptId)?.claim;
		const attempt = record.attemptId !== undefined ? snapshot?.attempts[record.attemptId] : undefined;
		const task = attempt ? snapshot?.tasks[attempt.taskId]?.task : undefined;
		return buildWorkerProofSheet({
			laneId: record.laneId,
			title: task?.title ?? record.laneId,
			...(claim ? { claim } : {}),
			...(record.outcome ? { outcome: record.outcome } : {}),
			...(attempt?.dispatch.brief ? { brief: attempt.dispatch.brief } : {}),
			...(attempt?.dispatch.requirementIds ? { requirementIds: attempt.dispatch.requirementIds } : {}),
			...(record.outputArtifact ? { outputUri: record.outputArtifact.uri } : {}),
			maxTextBytes,
		}).record;
	}

	/**
	 * The recorded outcome of this exact attempt. The lifecycle records it before the notification is enqueued, so a
	 * missing one is computed from the same facts here (never written) and logged as a recording gap.
	 */
	private terminalOutcome(
		laneId: string,
		attemptId: string | undefined,
		claim: WorkerClaimSnapshotPayload["claim"] | undefined,
	): Outcome | undefined {
		const snapshot = this.deps.getTaskRuntimeSnapshot?.();
		const attempt = attemptId !== undefined ? snapshot?.attempts[attemptId] : undefined;
		if (!snapshot || !attempt) return undefined;
		const stored = snapshot.tasks[attempt.taskId]?.outcome;
		const recorded = sameOutcomeAttempt(stored, attempt.attemptId);
		if (recorded) return recorded;
		const generation = (stored?.generation ?? 0) + 1;
		const computed = projectOutcome({
			snapshot,
			attemptId: attempt.attemptId,
			...(claim ? { claim } : {}),
			generation,
			outcomeId: taskOutcomeId(attempt.taskId, generation),
			...(stored ? { previous: stored } : {}),
			recordedAt: new Date().toISOString(),
		});
		if (computed && selectedWorkerAttempt(snapshot, attempt.taskId)?.attemptId === attempt.attemptId) {
			harnessLog.warn("outcomes", "a terminal handoff found no recorded outcome for its attempt", () => ({
				laneId,
				attemptId: attempt.attemptId,
			}));
		}
		return computed;
	}

	/** The next step for one worker's end; an unreachable host fact stays unknown and keeps the worker. */
	private nextStep(
		claim: WorkerClaimSnapshotPayload["claim"],
		laneId: string,
		attemptId: string | undefined,
	): WorkerNextStep {
		const goal = this.deps.getGoalStateSnapshot();
		return deriveWorkerNextStepFromProjections({
			claim,
			snapshot: this.deps.getTaskRuntimeSnapshot?.(),
			goal: goal?.requirements ? { requirements: goal.requirements } : undefined,
			laneId,
			...(attemptId !== undefined ? { attemptId } : {}),
		});
	}

	private prepareToolDelivery(records: readonly BackgroundToolTaskRecord[]): TerminalDeliveryPlan | undefined {
		const unread = records.filter((record) => record.observedAt === undefined);
		if (unread.length === 0) return undefined;
		const wake = this.resolveWake(unread);
		const { message: toolMessage, receipt } = projectBackgroundToolTerminalDelivery(unread, {
			wakeParent: wake.wakeParent,
		});
		return {
			deliveredTerminals: receipt.deliveredTerminals,
			message: {
				...toolMessage,
				details: {
					...toolMessage.details,
					summary: createBackgroundActivitySummaryContract(
						"task",
						unread.map((record) => ({
							id: record.taskId,
							status:
								record.status === "failed"
									? ("failed" as const)
									: record.status === "canceled"
										? ("canceled" as const)
										: ("success" as const),
						})),
					),
				},
			},
			...wake,
		};
	}

	private resolveWake(
		records: readonly {
			goalId?: string;
			ownerEpoch?: number;
			ownerDirect?: true;
			status?: string;
		}[],
	): Pick<TerminalDeliveryPlan, "wakeParent" | "goalId" | "ownerEpoch"> {
		const goal = this.deps.getGoalStateSnapshot();
		// What the owner asked a bot in its own chat is answered there: the root reads it with its next turn but is not
		// woken to redo, widen or route around it (a bot that refused a write by its role stays refused). A turn that
		// failed for a harness reason still wakes it.
		const ownersOwn =
			records.length > 0 && records.every((record) => record.ownerDirect === true && record.status !== "failed");
		const wakeParent =
			!ownersOwn &&
			records.some(
				(record) => !record.goalId || (goal?.goalId === record.goalId && isGoalExecutionActive(goal.status)),
			);
		// A batch's owner epoch is established only when every record in it agrees -- mixed or
		// partially-unknown ownership must fall back to the safe idle route for the whole batch
		// rather than fold on a majority or a first-seen value. See rule 4 of the delivery-boundary
		// spec: absent ownership must never be treated as a match.
		const firstEpoch = records[0]?.ownerEpoch;
		const ownerEpoch =
			firstEpoch !== undefined && records.every((record) => record.ownerEpoch === firstEpoch)
				? firstEpoch
				: undefined;
		return {
			wakeParent,
			...(wakeParent ? { goalId: records.find((record) => record.goalId === goal?.goalId)?.goalId } : {}),
			...(ownerEpoch !== undefined ? { ownerEpoch } : {}),
		};
	}

	private releaseAfterTurn(completion: Promise<void>, lease: ForegroundSubmissionLease, label: string): void {
		void completion.then(
			() => this.deps.foreground.releaseSubmission(lease),
			(error: unknown) => {
				this.deps.foreground.releaseSubmission(lease);
				this.deps.warn(
					`${label} failed after durable delivery: ${error instanceof Error ? error.message : String(error)}`,
				);
			},
		);
	}

	private assertLive(action: string): void {
		if (this.deps.isDisposed()) throw new Error(`Session disposed before ${action}`);
	}
}
