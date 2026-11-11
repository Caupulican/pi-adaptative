/**
 * The two things a `delegate start` on a named worker owes the operator when its options do not fit
 * that worker: a sentence saying what happened, and a reroute onto a worker that can take the work.
 */

const REUSE_INCOMPATIBLE = "worker_reuse_overrides_incompatible";

/** A refused reuse: what the operator reads, the details it carries, and the correction it asks for. */
export function reuseRefusal(
	agentId: string,
	action: string,
	skipReason: string | undefined,
	writePathsGiven: boolean,
) {
	const widened = writePathsGiven
		? " A reused worker keeps the write scope it was created with and cannot be widened: start a new worker with `writePaths`."
		: "";
	return {
		message: `delegate start could not apply those options to worker ${agentId}: ${skipReason ?? "not_started"}. They describe different work; start without agentId to run it as its own worker.${widened}`,
		details: {
			started: false as const,
			action,
			agentId,
			skipReason: skipReason ?? "worker_reuse_overrides_incompatible",
		},
		flags: { c: "E_STATE" as const, f: "agentId", h: "RETRY_OMIT" as const },
	};
}

/** The placed-worker line, which says so when the harness moved the task off an incompatible worker. */
export function reuseAcceptedMessage(input: {
	agentId: string;
	record?: { agentId?: string; laneId?: string };
	waiting?: string;
	routedFrom?: string;
}): string {
	const lane = `(lane ${input.record?.laneId ?? "queued"}${input.waiting ? `; ${input.waiting}` : ""})`;
	const reroute = input.routedFrom
		? `; the harness rerouted it from worker ${input.routedFrom}, which could not take those options`
		: "";
	return `worker ${input.record?.agentId ?? input.agentId} accepted this task with its own admitted binding ${lane}${reroute}`;
}

/** True when the refusal only says the named worker's options did not fit, so the work is still startable. */
export function isIncompatibleReuse(skipReason: string | undefined): boolean {
	return (skipReason ?? REUSE_INCOMPATIBLE) === REUSE_INCOMPATIBLE;
}

/**
 * Runs an incompatible reuse start as its own compatible worker. The caller supplies how to build a
 * start request, because that builder owns the request's shape; this owns only the retry policy.
 */
export async function startCompatibleFallback<
	TValidated extends { started: boolean; skipReason?: string },
	TFields,
	TRequest,
>(
	validated: TValidated,
	input: TFields & { instructions: string; toolInput: Record<string, unknown>; requirementIds: readonly string[] },
	build: (fields: TFields) => TRequest,
	deps: {
		startWorkerDelegation?: (
			request: TRequest,
			signal?: AbortSignal,
		) => { started: boolean } | Promise<{ started: boolean }>;
		runWorkerDelegation: (request: TRequest) => Promise<{ started: boolean }>;
	},
	signal?: AbortSignal,
): Promise<{ validated: TValidated; rerouted: boolean }> {
	if (validated.started || !isIncompatibleReuse(validated.skipReason)) return { validated, rerouted: false };
	const request = build(input);
	const fallback = deps.startWorkerDelegation
		? await deps.startWorkerDelegation(request, signal)
		: await deps.runWorkerDelegation(request);
	return fallback.started
		? { validated: fallback as unknown as TValidated, rerouted: true }
		: { validated, rerouted: false };
}
