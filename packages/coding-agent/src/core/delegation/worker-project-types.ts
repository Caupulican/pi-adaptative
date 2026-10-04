import type { SpecialistContextOwner } from "../orchestration/specialist-context-ownership.ts";

export interface WorkerProjectAllocation {
	specializationKey: string;
	allocationId: string;
	owner: SpecialistContextOwner;
}

export interface WorkerProjectPreparation {
	logicalAgentId: string;
	controlMessageId: string;
}
