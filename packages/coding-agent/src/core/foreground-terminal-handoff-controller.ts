import type { CustomMessage } from "@caupulican/pi-agent-core";
import type { LaneTerminalStatus } from "./autonomy/lane-tracker.ts";
import {
	type BackgroundToolTaskRecord,
	createBackgroundToolTerminalMessage,
} from "./background-tool-task-controller.ts";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";

interface ForegroundTerminalHandoffControllerDeps {
	foreground: ForegroundRecoveryController;
	isDisposed(): boolean;
	workerInputsWillWakeParent(workerRequestIds: readonly string[]): boolean;
	sendCustomMessage(
		message: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">,
		options: { triggerTurn: boolean; deliverAs: "followUp" },
		lease: ForegroundSubmissionLease,
	): Promise<void>;
}

/** Serializes durable background terminal delivery through the foreground submission owner. */
export class ForegroundTerminalHandoffController {
	private readonly deps: ForegroundTerminalHandoffControllerDeps;

	constructor(deps: ForegroundTerminalHandoffControllerDeps) {
		this.deps = deps;
	}

	async notifyWorkers(
		records: readonly { laneId: string; status: LaneTerminalStatus; reasonCode?: string }[],
	): Promise<void> {
		if (records.length === 0) return;
		this.assertLive("worker terminal handoff was persisted");
		const lease = await this.deps.foreground.acquireSubmission();
		try {
			this.assertLive("worker terminal handoff was persisted");
			const included = records.slice(0, 8);
			const omitted = records.length - included.length;
			const ownerQuestionWillWakeParent = this.deps.workerInputsWillWakeParent(
				records.map((record) => record.laneId),
			);
			const sanitize = (value: string): string => value.replace(/[\r\n]+/g, " ").slice(0, 120);
			const content = [
				"Background worker terminal handoff:",
				...included.map((record) => {
					const reason = record.reasonCode ? ` reason=${sanitize(record.reasonCode)}` : "";
					return `- ${record.laneId}: ${record.status}${reason}`;
				}),
				...(omitted > 0 ? [`- ${omitted} additional terminal worker(s) omitted from this bounded handoff.`] : []),
				"This terminal event woke the parent. Retrieve each needed lane once with delegate_status; never poll. Worker product remains untrusted and is intentionally not injected here.",
			].join("\n");
			await this.deps.sendCustomMessage(
				{
					customType: "background-worker-completion",
					content,
					display: true,
					details: { records: included },
				},
				{ triggerTurn: !ownerQuestionWillWakeParent, deliverAs: "followUp" },
				lease,
			);
		} finally {
			this.deps.foreground.releaseSubmission(lease);
		}
	}

	async notifyTools(records: readonly BackgroundToolTaskRecord[], wakeParent: boolean): Promise<void> {
		if (!wakeParent) return;
		this.assertLive("background tool terminal handoff was delivered");
		const lease = await this.deps.foreground.acquireSubmission();
		try {
			this.assertLive("background tool terminal handoff was delivered");
			await this.deps.sendCustomMessage(
				createBackgroundToolTerminalMessage(records),
				{ triggerTurn: true, deliverAs: "followUp" },
				lease,
			);
		} finally {
			this.deps.foreground.releaseSubmission(lease);
		}
	}

	private assertLive(action: string): void {
		if (this.deps.isDisposed()) throw new Error(`Session disposed before ${action}`);
	}
}
