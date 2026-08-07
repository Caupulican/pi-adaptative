import type {
	AcceptanceCriterion,
	AgentBindingContract,
	AgentResumeContext,
	ApprovalOutcome,
	ApprovalRequestContract,
	ApprovalResolutionContract,
	AttemptCheckpoint,
	AttemptLease,
	AttemptRetryState,
	AttemptStatus,
	EvidenceContract,
	ExecutionGrant,
	ObjectiveContract,
	ObjectiveStatus,
	OrchestrationDispatchRequest,
	RiskBudget,
	TaskContract,
	WorkerResultContract,
} from "./contracts.ts";

export interface ObjectiveRuntimeState {
	objective: ObjectiveContract;
	taskIds: readonly string[];
	evidence: readonly EvidenceContract[];
}

export interface TaskRuntimeState {
	task: TaskContract;
	attemptIds: readonly string[];
	verification?: {
		verifierTaskId: string;
		verifierAttemptId: string;
		verdict: "accepted" | "rejected" | "inconclusive";
		reasonCode: string;
		completedAt: string;
	};
}

export interface AttemptRuntimeState {
	attemptId: string;
	taskId: string;
	dispatch: OrchestrationDispatchRequest;
	status: AttemptStatus;
	reasonCode?: string;
	grantId?: string;
	/** Full compiled authority for new attempts; grantId alone is retained only when replaying legacy events. */
	grant?: ExecutionGrant;
	agentId?: string;
	lease?: AttemptLease;
	/** Omitted for legacy attempts and attempts that have never entered the host retry ladder. */
	retry?: AttemptRetryState;
	checkpointIds: readonly string[];
	result?: WorkerResultContract;
	createdAt: string;
	updatedAt: string;
}

export interface NotificationRuntimeState {
	notificationId: string;
	objectiveId: string;
	attemptId?: string;
	status: "pending" | "delivered";
	message: string;
	createdAt: string;
	deliveredAt?: string;
}

export interface ApprovalRuntimeState {
	request: ApprovalRequestContract;
	status: "pending" | ApprovalOutcome;
	resolution?: ApprovalResolutionContract;
}

export interface TaskRuntimeProjection {
	lastOrdinal: number;
	agents: Readonly<Record<string, AgentBindingContract>>;
	objectives: Readonly<Record<string, ObjectiveRuntimeState>>;
	tasks: Readonly<Record<string, TaskRuntimeState>>;
	attempts: Readonly<Record<string, AttemptRuntimeState>>;
	checkpoints: Readonly<Record<string, AttemptCheckpoint>>;
	approvals: Readonly<Record<string, ApprovalRuntimeState>>;
	notifications: Readonly<Record<string, NotificationRuntimeState>>;
}

export interface OrchestrationProjectionSlotCounts {
	agents: number;
	objectives: number;
	tasks: number;
	attempts: number;
	checkpoints: number;
	approvals: number;
	notifications: number;
	evidence: number;
}

export interface OrchestrationProjectionCapacity {
	counts: OrchestrationProjectionSlotCounts;
	limits: OrchestrationProjectionSlotCounts;
	headroom: OrchestrationProjectionSlotCounts;
}

export type OrchestrationProjectionHeadroomRequest = Partial<OrchestrationProjectionSlotCounts>;

export type AttemptDispatchReadiness =
	| {
			state: "ready";
			attemptId: string;
			taskId: string;
	  }
	| {
			state: "waiting";
			reasonCode: "dependencies_incomplete";
			attemptId: string;
			taskId: string;
			dependencyTaskIds: readonly string[];
	  }
	| {
			state: "waiting";
			reasonCode: "objective_paused";
			attemptId: string;
			taskId: string;
			objectiveStatus: "paused";
	  }
	| {
			state: "blocked";
			reasonCode: "dependency_failed_or_cancelled";
			attemptId: string;
			taskId: string;
			dependencyTaskIds: readonly string[];
			failedDependencyTaskIds: readonly string[];
			cancelledDependencyTaskIds: readonly string[];
	  }
	| {
			state: "blocked";
			reasonCode: "objective_inactive";
			attemptId: string;
			taskId: string;
			objectiveStatus: ObjectiveStatus;
	  };

export interface CreateObjectiveInput {
	objectiveId?: string;
	title: string;
	description: string;
	constraints?: readonly string[];
	acceptanceCriteria?: readonly AcceptanceCriterion[];
	riskBudget?: RiskBudget;
}

export interface CreateTaskInput {
	taskId?: string;
	objectiveId: string;
	title: string;
	description: string;
	role: TaskContract["role"];
	dependsOn?: readonly string[];
	requiredCapabilities?: TaskContract["requiredCapabilities"];
	acceptanceCriterionIds?: readonly string[];
	verificationOfTaskId?: string;
	riskBudget?: RiskBudget;
}

export interface PreparedTaskAttempt {
	task: TaskContract;
	attempt: AttemptRuntimeState;
}

export interface RegisterAgentInput {
	agentId?: string;
	parentAgentId?: string;
	role: AgentBindingContract["role"];
	resumeContext: AgentResumeContext;
}

export class DurableTaskRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DurableTaskRuntimeError";
	}
}

export function terminalAttemptStatus(status: AttemptStatus): boolean {
	return ["completed", "partial", "blocked", "failed", "cancelled", "expired"].includes(status);
}

export function missingTrustedCriteria(result: WorkerResultContract, criterionIds: readonly string[]): string[] {
	const proven = new Set(
		result.evidence.flatMap((evidence) => (evidence.trusted && evidence.criterionId ? [evidence.criterionId] : [])),
	);
	return criterionIds.filter((criterionId) => !proven.has(criterionId));
}
