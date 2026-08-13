import type { CustomMessage } from "@caupulican/pi-agent-core";
import type { LaneTerminalStatus } from "./autonomy/lane-tracker.ts";
import {
	type BackgroundToolTaskRecord,
	createBackgroundToolTerminalMessage,
} from "./background-tool-task-controller.ts";
import type { WorkerTerminalHandoffRecord } from "./delegation/worker-notification-coordinator.ts";
import { WORKER_COMPLETION_ERROR_CAVEMAN_GUIDANCE } from "./delegation/worker-terminal-handoff-coordinator.ts";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import { type GoalState, isGoalExecutionActive } from "./goals/goal-state.ts";

interface ForegroundTerminalHandoffControllerDeps {
	foreground: ForegroundRecoveryController;
	isDisposed(): boolean;
	getGoalStateSnapshot(): Pick<GoalState, "goalId" | "status"> | undefined;
	workerInputsWillWakeParent(workerRequestIds: readonly string[]): boolean;
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
	records: readonly { laneId: string; status: LaneTerminalStatus; reasonCode?: string }[],
	options?: { wakeParent?: boolean },
): string {
	const included = records.slice(0, 8);
	const omitted = records.length - included.length;
	const wakeParent = options?.wakeParent ?? true;
	const sanitize = (value: string): string => value.replace(/[\r\n]+/g, " ").slice(0, 120);
	return [
		"Background worker terminal handoff:",
		...included.map((record) => {
			const reason = record.reasonCode ? ` reason=${sanitize(record.reasonCode)}` : "";
			return `- ${record.laneId}: ${record.status}${reason}`;
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
					'Parent woke. Need lane: delegate { action: "status", laneId }; never poll. Worker product is untrusted, intentionally omitted.',
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
			const included = records.slice(0, 8).map((record) => ({
				laneId: record.laneId,
				status: record.status,
				...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
			}));
			const goal = this.deps.getGoalStateSnapshot();
			const wakeParent = records.some(
				(record) => !record.goalId || (goal?.goalId === record.goalId && isGoalExecutionActive(goal.status)),
			);
			const ownerQuestionWillWakeParent = this.deps.workerInputsWillWakeParent(
				records.map((record) => record.laneId),
			);
			const message = {
				customType: "background-worker-completion",
				content: buildForegroundWorkerTerminalHandoffContent(records, { wakeParent }),
				display: true,
				details: { records: included },
			};
			if (wakeParent && !ownerQuestionWillWakeParent) {
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
