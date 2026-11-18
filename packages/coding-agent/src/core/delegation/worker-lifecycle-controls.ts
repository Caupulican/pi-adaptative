/** Host contracts for transfer and retirement of a durable specialist. */
import type { ModelTransferRecord } from "../orchestration/model-transfer.ts";
import type { WorkerAgentControlScope, WorkerAgentView } from "./worker-agent-control.ts";

export interface WorkerModelHandoffPort {
	handOffWorkerAgent(
		agentId: string,
		targetModelRef: string,
		toolCallId: string,
		scope?: WorkerAgentControlScope,
	): Promise<ModelTransferRecord>;
}

export interface WorkerAgentRetireResult {
	agent: WorkerAgentView;
	retired: true;
	replayed: boolean;
}

export interface WorkerAgentRetireOptions {
	/** Dead-letter the agent's undelivered control messages instead of refusing to retire. */
	discardPending?: boolean;
}
