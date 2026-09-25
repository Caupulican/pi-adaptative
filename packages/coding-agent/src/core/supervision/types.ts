export type WorkerSupervisionAction =
	| "continue"
	| "steer_once"
	| "steer_now"
	| "request_verifier"
	| "stop_and_reroute"
	| "request_specialist"
	| "request_capability"
	| "mark_external_block";

export interface WorkerSupervisionSignal {
	readonly schema_version: "1.0";
	readonly signal_id: string;
	readonly objective_id: string;
	readonly task_id: string;
	readonly attempt_id: string;
	readonly action: WorkerSupervisionAction;
	readonly certificate_id: string;
	readonly reason_codes?: readonly string[];
	readonly created_at: string;
	readonly explanation?: string;
	readonly summaryEvent?: string;
}

export interface LiveWorkerAttempt {
	readonly objectiveId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly role: string;
	readonly mission: string;
	readonly toolCalls: number;
	readonly elapsedMs: number;
	readonly outputTail?: string;
	readonly recentFailures?: readonly string[];
	readonly recentToolNames?: readonly string[];
	readonly changedFiles?: readonly string[];
	readonly isRepeating?: boolean;
	readonly isStalled?: boolean;
	readonly evidenceRevision?: number;
}

export interface SupervisionObservationState {
	readonly objectiveId: string;
	readonly taskId: string;
	readonly attemptId: string;
	/** What the worker is for; progress is judged against it (an explorer changes no files). */
	readonly role: string;
	readonly mission: string;
	readonly elapsedMs: number;
	readonly toolCalls: number;
	/** The last few tools it ran, oldest first. */
	readonly recentToolNames: readonly string[];
	readonly outputTail: string;
	readonly changedFiles: readonly string[];
	readonly recentFailures: readonly string[];
	readonly evidenceRevision: number;
	readonly priorSteeringCount: number;
	readonly isStalled: boolean;
	readonly isRepeating: boolean;
}
