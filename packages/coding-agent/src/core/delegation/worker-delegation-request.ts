/** Runtime-owned task correlation retained with a durable worker dispatch. Never model-settable. */
export interface WorkerDelegationTaskContext {
	requirementIds: readonly string[];
	dependsOnTaskIds: readonly string[];
	acceptanceCriterionIds: readonly string[];
	/**
	 * Optional runtime narrowing of the owner-admitted profile resources. An empty list does not
	 * suppress owner resources: admission expands it to the immutable profile pointer set and
	 * persists that exact selection with the attempt.
	 */
	resourcePointerIds: readonly string[];
}

/**
 * The foreground orchestrator may select an owner-authored profile and provide task context. It
 * cannot select or override a model, thinking level, budget, tool surface, or concurrency policy.
 */
export interface WorkerDelegationRequest {
	instructions: string;
	profileId?: string;
	/** Runtime-owned correlation for an automatically dispatched verifier; never model-settable. */
	verificationOfTaskId?: string;
	/** Runtime-owned durable task correlation; the delegate tool schema intentionally omits this. */
	taskContext?: WorkerDelegationTaskContext;
}
