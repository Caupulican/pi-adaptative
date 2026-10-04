export interface HumanInputRequest {
	requestId: string;
	source: HumanInputSource;
	toolCallId?: string;
	toolName?: string;
	workerRequestId?: string;
	/**
	 * Objective this question belongs to, when one was executing at ask time. Optional: snapshots
	 * persisted before objective correlation existed carry none and decode unchanged.
	 */
	objectiveId?: string;
	category?: HumanInputCategory;
	questions: readonly HumanInputQuestion[];
	acceptsImages: boolean;
	createdAt: string;
}

export interface HumanInputQuestion {
	id: string;
	header: string;
	question: string;
	options: readonly HumanInputOption[];
	multiSelect?: boolean;
}

export type HumanInputSource = "tool" | "worker";

/**
 * What the owner is being asked for. Clarification is INFORMATION: none of these values grants
 * authority, and `blocked_by_user_decision` records that the objective is waiting on a decision the
 * owner alone owns -- never that the answer expands what the execution charter allows.
 */
export type HumanInputCategory = "information" | "ambiguous_requirement" | "blocked_by_user_decision";

export interface HumanInputOption {
	label: string;
	description: string;
}
