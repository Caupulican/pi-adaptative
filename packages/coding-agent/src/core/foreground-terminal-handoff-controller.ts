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
	sendCustomMessage(
		message: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">,
		options: { triggerTurn: false; deliverAs: "followUp" },
		lease: ForegroundSubmissionLease,
	): Promise<void>;
	warn(message: string): void;
}

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
				lines.push(`  Claim Summary: ${sanitize(record.claim.summary)}`);
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

	constructor(deps: ForegroundTerminalHandoffControllerDeps) {
		this.deps = deps;
	}

	async notifyWorkers(records: readonly WorkerTerminalHandoffRecord[]): Promise<void> {
		if (records.every((record) => record.observedAt !== undefined)) return;
		this.assertLive("worker terminal handoff was persisted");
		const lease = await this.deps.foreground.acquireSubmission();
		let releaseLease = true;
		try {
			this.assertLive("worker terminal handoff was persisted");
			const unread = records.filter((record) => record.observedAt === undefined);
			if (unread.length === 0) return;
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
									summary: claim.summary.slice(0, 1000),
									changedFiles: claim.changedFiles,
									...(claim.blockers ? { blockers: claim.blockers } : {}),
									...(claim.parentReviewRequired ? { parentReviewRequired: true } : {}),
								},
							}
						: {}),
				};
			});
			const included = prepared.slice(0, 8).map(({ summaryItem: _summaryItem, ...record }) => record);
			const goal = this.deps.getGoalStateSnapshot();
			const wakeParent = unread.some(
				(record) => !record.goalId || (goal?.goalId === record.goalId && isGoalExecutionActive(goal.status)),
			);
			const message = {
				customType: "background-worker-completion",
				content: buildForegroundWorkerTerminalHandoffContent(included, {
					wakeParent,
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
			};
			if (wakeParent) {
				const goalId = unread.find((record) => record.goalId === goal?.goalId)?.goalId;
				const started = await this.deps.startCustomMessageTurn(message, lease, goalId);
				this.releaseAfterTurn(started.completion, lease, "worker terminal handoff turn");
				releaseLease = false;
			} else {
				await this.deps.sendCustomMessage(message, { triggerTurn: false, deliverAs: "followUp" }, lease);
			}
		} finally {
			if (releaseLease) this.deps.foreground.releaseSubmission(lease);
		}
	}

	async notifyTools(records: readonly BackgroundToolTaskRecord[], wakeParent: boolean): Promise<void> {
		if (!wakeParent || records.every((record) => record.observedAt !== undefined)) return;
		this.assertLive("background tool terminal handoff was delivered");
		const lease = await this.deps.foreground.acquireSubmission();
		let releaseLease = true;
		try {
			this.assertLive("background tool terminal handoff was delivered");
			const unread = records.filter((record) => record.observedAt === undefined);
			if (unread.length === 0) return;
			const toolMessage = createBackgroundToolTerminalMessage(unread);
			const message = {
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
			};
			const started = await this.deps.startCustomMessageTurn(message, lease);
			this.releaseAfterTurn(started.completion, lease, "background tool terminal handoff turn");
			releaseLease = false;
		} finally {
			if (releaseLease) this.deps.foreground.releaseSubmission(lease);
		}
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
