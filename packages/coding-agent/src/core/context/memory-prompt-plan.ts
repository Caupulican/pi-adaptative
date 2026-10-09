import type { AgentMessage } from "../../kernel/types.ts";

/**
 * The memory records one provider request adds, with the lifecycle of the plan that carries them.
 * Building a plan publishes nothing: diagnostics and the admitted-recall record are written only by
 * `commit`, which the surrounding provider plan calls once it is accepted. A plan built against a
 * different memory state is reported by `isCurrent` so the request is planned again.
 */
export interface MemoryPromptPlan {
	/** The input messages followed by the memory records (evidence block or cleared marker, persona). */
	messages: AgentMessage[];
	/** False once the memory generation, content revision, headroom or composed records no longer match. */
	isCurrent(): boolean;
	/** Publish the inclusion report and admitted-recall record of this plan. Called once, after acceptance. */
	commit(): void;
}
