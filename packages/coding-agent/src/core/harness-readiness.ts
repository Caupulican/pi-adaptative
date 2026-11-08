/**
 * Whether the harness is ready to do the heavy lifting (delegation can start a worker), judged from the host's own admission
 * of a plain worker, and what to tell the owner when it is not. The model is never asked to work this out: a setup the harness
 * cannot serve is the owner's to fix once, at session start.
 */

export type ReadinessFix = "workers_use_session_model" | "enable_delegation";

export interface ReadinessProblem {
	/** What is wrong, in the owner's words. */
	readonly text: string;
	/** The setting change that fixes it, when one change does. */
	readonly fix?: ReadinessFix;
	/** What the fix does, in the owner's words. */
	readonly fixText?: string;
}

/** The owner's words for a skip reason of the worker admission; undefined for a reason that needs no owner action. */
export function describeReadinessProblem(reason: string): ReadinessProblem | undefined {
	if (reason === "worker_delegation_disabled")
		return {
			text: "Delegation is turned off, so the orchestrator cannot start workers.",
			fix: "enable_delegation",
			fixText: "Turn delegation on",
		};
	if (
		reason.startsWith("orchestration_model_policy_no_allowed_model") ||
		reason.startsWith("orchestration_model_required") ||
		reason.startsWith("orchestration_model_unavailable") ||
		reason.startsWith("worker_model_not_allowed")
	)
		return {
			text: "Workers have no model they are allowed to use, so delegated work would fail.",
			fix: "workers_use_session_model",
			fixText: "Let workers use this session's model",
		};
	return undefined;
}
