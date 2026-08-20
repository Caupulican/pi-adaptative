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
	options?: { wakeParent?: boolean },
): string {
	const included = records.slice(0, 8);
	const omitted = records.length - included.length;
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
		if (records.length === 0) return;
		this.assertLive("worker terminal handoff was persisted");
		const lease = await this.deps.foreground.acquireSubmission();
		let releaseLease = true;
		try {
			this.assertLive("worker terminal handoff was persisted");
			const included = records.slice(0, 8).map((record) => {
				const snapshot = this.deps.getWorkerClaimSnapshot?.(record.laneId);
				const claim = snapshot?.claim;
				const outputArtifact = workerTerminalOutputArtifact(this.deps.getWorkerResult?.(record.laneId));
				return {
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
			const goal = this.deps.getGoalStateSnapshot();
			const wakeParent = records.some(
				(record) => !record.goalId || (goal?.goalId === record.goalId && isGoalExecutionActive(goal.status)),
			);
			const message = {
				customType: "background-worker-completion",
				content: buildForegroundWorkerTerminalHandoffContent(included, { wakeParent }),
				display: true,
				details: { records: included },
			};
			if (wakeParent) {
				const goalId = records.find((record) => record.goalId === goal?.goalId)?.goalId;
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
		if (!wakeParent) return;
		this.assertLive("background tool terminal handoff was delivered");
		const lease = await this.deps.foreground.acquireSubmission();
		let releaseLease = true;
		try {
			this.assertLive("background tool terminal handoff was delivered");
			const started = await this.deps.startCustomMessageTurn(createBackgroundToolTerminalMessage(records), lease);
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
