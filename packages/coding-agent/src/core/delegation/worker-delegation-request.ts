/**
 * The foreground orchestrator may select an owner-authored profile and provide task context. It
 * cannot select or override a model, thinking level, budget, tool surface, or concurrency policy.
 */
export interface WorkerDelegationRequest {
	instructions: string;
	profileId?: string;
}
