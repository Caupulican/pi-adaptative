import type { CustomMessage } from "@caupulican/pi-agent-core";
import type { LaneTerminalStatus } from "./autonomy/lane-tracker.ts";
import {
	type BackgroundToolTaskRecord,
	createBackgroundToolTerminalMessage,
} from "./background-tool-task-controller.ts";
import type { WorkerClaimSnapshotPayload } from "./delegation/session-worker-claim.ts";
import type { WorkerTerminalHandoffRecord } from "./delegation/worker-notification-coordinator.ts";
import { WORKER_COMPLETION_ERROR_CAVEMAN_GUIDANCE } from "./delegation/worker-terminal-handoff-coordinator.ts";
import { workerTerminalOutputArtifact } from "./delegation/worker-terminal-output-artifact.ts";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import { type GoalState, isGoalExecutionActive } from "./goals/goal-state.ts";
import type { ArtifactContract, WorkerResultContract } from "./orchestration/contracts.ts";
import { wrapUntrustedText } from "./security/untrusted-boundary.ts";
import { utf8PrefixByBytes } from "./util/bounded-value.ts";

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
	getGoalStateSnapshot(): Pick<GoalState, "goalId" | "status"> | undefined;
	getWorkerClaimSnapshot?(laneId: string): WorkerClaimSnapshotPayload | undefined;
	getWorkerResult?(laneId: string): Pick<WorkerResultContract, "artifacts"> | undefined;
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
	warn(message: string): void;
}

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
}

interface PendingTerminalDelivery {
	prepare(): TerminalDeliveryPlan | undefined;
	resolve(): void;
	reject(error: unknown): void;
}

const MAX_DELIVERED_TERMINAL_IDENTITIES = 512;
const ATTENTION_CLAIM_STATUSES: ReadonlySet<LaneTerminalStatus> = new Set(["blocked", "partial"]);
const MAX_ATTENTION_CLAIM_SUMMARY_BYTES = 16 * 1024;

export function buildForegroundWorkerTerminalHandoffContent(
	records: readonly {
		laneId: string;
		status: LaneTerminalStatus;
		reasonCode?: string;
		outputArtifact?: ArtifactContract;
		claim?: {
			summary?: string;
			status?: string;
			changedFiles?: readonly string[];
			blockers?: readonly string[];
			parentReviewRequired?: boolean;
		};
	}[],
	options?: { wakeParent?: boolean; totalCount?: number },
): string {
	const included = records.slice(0, 8);
	const omitted = Math.max(0, (options?.totalCount ?? records.length) - included.length);
	const wakeParent = options?.wakeParent ?? true;
	const sanitize = (value: string): string => value.replace(/[\r\n]+/g, " ").slice(0, 120);
	return [
		"Background worker terminal handoff:",
		...included.flatMap((record) => {
			const reason = record.reasonCode ? ` reason=${sanitize(record.reasonCode)}` : "";
			const lines = [`- ${record.laneId}: ${record.status}${reason}`];
			if (record.outputArtifact) {
				lines.push(
					`  Full Output: ${record.outputArtifact.uri}${record.outputArtifact.sizeBytes === undefined ? "" : ` (${record.outputArtifact.sizeBytes} bytes)`}`,
				);
			}
			if (record.claim?.summary) {
				lines.push(`  Claim Status: ${record.claim.status || record.status}`);
				const summary = ATTENTION_CLAIM_STATUSES.has(record.status)
					? utf8PrefixByBytes(record.claim.summary, MAX_ATTENTION_CLAIM_SUMMARY_BYTES)
					: sanitize(record.claim.summary);
				lines.push(
					`  Claim Summary (untrusted worker evidence):\n${wrapUntrustedText(summary, `worker-claim:${record.laneId}`)}`,
				);
				if (record.claim.changedFiles && record.claim.changedFiles.length > 0) {
					lines.push(`  Changed Files: ${record.claim.changedFiles.map((f) => sanitize(f)).join(", ")}`);
				}
				if (record.claim.blockers && record.claim.blockers.length > 0) {
					lines.push(`  Blockers: ${record.claim.blockers.map((b) => sanitize(b)).join("; ")}`);
				}
			}
			return lines;
		}),
		...(omitted > 0 ? [`- ${omitted} additional terminal worker(s) omitted.`] : []),
		"CAVEMAN MODE - MANDATORY: this event proves terminal persistence and delivery. Do not report missed completion or lost worker state from these records.",
		...(wakeParent
			? ["Read each lane with delegate status, verify the claim, then continue or replan the parent task."]
			: [
					"The owning parent is no longer eligible for automatic continuation. Persist this handoff, but do not continue or replan automatically.",
				]),
		...(records.some((record) => record.reasonCode === "worker_blocked")
			? ["worker_blocked is a task claim with blockers, not harness failure."]
			: []),
		...(records.some((record) => record.status === "budget_exhausted")
			? [
					"CAVEMAN MODE - MANDATORY: budget_exhausted means an admitted limit ended work, not harness failure. Terminal reason is authoritative; never replace it with earlier transcript errors. Read evidence, then replan only within remaining authority.",
				]
			: []),
		...(records.some((record) => record.reasonCode === "completion_error")
			? [WORKER_COMPLETION_ERROR_CAVEMAN_GUIDANCE]
			: []),
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
	private readonly terminalDeliveries = new Map<string, Promise<void>>();
	private readonly deliveredTerminalIdentities = new Set<string>();

	constructor(deps: ForegroundTerminalHandoffControllerDeps) {
		this.deps = deps;
	}

	async notifyWorkers(records: readonly WorkerTerminalHandoffRecord[]): Promise<void> {
		if (records.every((record) => record.observedAt !== undefined)) return;
		this.assertLive("worker terminal handoff was persisted");
		await this.scheduleUnique(
			records,
			(record) =>
				["worker", record.laneId, record.completedAt ?? "", record.status, record.reasonCode ?? ""].join("\0"),
			(uniqueRecords) => this.prepareWorkerDelivery(uniqueRecords),
		);
	}

	async notifyTools(records: readonly BackgroundToolTaskRecord[], wakeParent: boolean): Promise<void> {
		if (!wakeParent || records.every((record) => record.observedAt !== undefined)) return;
		this.assertLive("background tool terminal handoff was delivered");
		await this.scheduleUnique(
			records,
			(record) => ["tool", record.sessionId, record.taskId, record.completedAt ?? "", record.status].join("\0"),
			(uniqueRecords) => this.prepareToolDelivery(uniqueRecords),
		);
	}

	/** Deliver queued terminals immediately before the agent loop polls its steering inbox. */
	flushProviderBoundary(): void {
		for (const pending of [...this.pending]) {
			try {
				this.assertLive("terminal handoff reached a provider boundary");
				const plan = pending.prepare();
				if (!plan) {
					this.pending.delete(pending);
					pending.resolve();
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
				void this.deps.enqueueCustomMessageTurn(plan.message).then(pending.resolve, pending.reject);
			} catch (error) {
				this.pending.delete(pending);
				pending.reject(error);
			}
		}
	}

	private schedule(prepare: () => TerminalDeliveryPlan | undefined): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const pending: PendingTerminalDelivery = { prepare, resolve, reject };
			this.pending.add(pending);
			void this.deliverWhenIdle(pending);
		});
	}

	private async scheduleUnique<T>(
		records: readonly T[],
		identity: (record: T) => string,
		prepare: (records: readonly T[]) => TerminalDeliveryPlan | undefined,
	): Promise<void> {
		const receipts = new Set<Promise<void>>();
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
		await Promise.all(receipts);
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
				await this.deps.foreground.waitForIdle();
				if (!this.pending.has(pending)) return;
				this.assertLive("terminal handoff was waiting for foreground idle");
				const lease = this.deps.foreground.tryAcquireSubmission();
				if (!lease) continue;
				if (!this.pending.delete(pending)) {
					this.deps.foreground.releaseSubmission(lease);
					return;
				}
				try {
					await this.deliverWithLease(pending.prepare(), lease);
					pending.resolve();
				} catch (error) {
					pending.reject(error);
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
		} finally {
			if (releaseLease) this.deps.foreground.releaseSubmission(lease);
		}
	}

	private prepareWorkerDelivery(records: readonly WorkerTerminalHandoffRecord[]): TerminalDeliveryPlan | undefined {
		const unread = records.filter((record) => record.observedAt === undefined);
		if (unread.length === 0) return undefined;
		const prepared = unread.map((record, index) => {
			const snapshot = this.deps.getWorkerClaimSnapshot?.(record.laneId);
			const claim = snapshot?.claim;
			const outputArtifact =
				index < 8 ? workerTerminalOutputArtifact(this.deps.getWorkerResult?.(record.laneId)) : undefined;
			return {
				summaryItem: {
					id: record.laneId,
					status: workerSummaryStatus(record, claim?.parentReviewRequired === true),
				},
				laneId: record.laneId,
				status: record.status,
				...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
				...(outputArtifact ? { outputArtifact } : {}),
				...(claim
					? {
							claim: {
								status: claim.status,
								summary: utf8PrefixByBytes(
									claim.summary,
									ATTENTION_CLAIM_STATUSES.has(record.status) ? MAX_ATTENTION_CLAIM_SUMMARY_BYTES : 1000,
								),
								changedFiles: claim.changedFiles,
								...(claim.blockers ? { blockers: claim.blockers } : {}),
								...(claim.parentReviewRequired ? { parentReviewRequired: true } : {}),
							},
						}
					: {}),
			};
		});
		const included = prepared.slice(0, 8).map(({ summaryItem: _summaryItem, ...record }) => record);
		const wake = this.resolveWake(unread);
		return {
			message: {
				customType: "background-worker-completion",
				content: buildForegroundWorkerTerminalHandoffContent(included, {
					wakeParent: wake.wakeParent,
					totalCount: unread.length,
				}),
				display: true,
				details: {
					records: included,
					summary: createBackgroundActivitySummaryContract(
						"agent",
						prepared.map((entry) => entry.summaryItem),
					),
				},
			},
			...wake,
		};
	}

	private prepareToolDelivery(records: readonly BackgroundToolTaskRecord[]): TerminalDeliveryPlan | undefined {
		const unread = records.filter((record) => record.observedAt === undefined);
		if (unread.length === 0) return undefined;
		const wake = this.resolveWake(unread);
		const toolMessage = createBackgroundToolTerminalMessage(unread, { wakeParent: wake.wakeParent });
		return {
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
		records: readonly { goalId?: string; ownerEpoch?: number }[],
	): Pick<TerminalDeliveryPlan, "wakeParent" | "goalId" | "ownerEpoch"> {
		const goal = this.deps.getGoalStateSnapshot();
		const wakeParent = records.some(
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
