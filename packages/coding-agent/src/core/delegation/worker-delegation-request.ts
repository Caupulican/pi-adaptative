/**
 * The foreground orchestrator may select an owner-authored profile and provide task context. It
 * cannot select or override a model, thinking level, budget, tool surface, or concurrency policy.
 */
export interface WorkerDelegationRequest {
	instructions: string;
	profileId?: string;
	/** Model-provided replacement for the worker role prompt; the level-0 safety core still remains. */
	systemPrompt?: string;
	/** Request bounded read-only memory. The selected profile remains authoritative. */
	memoryRead?: boolean;
}
