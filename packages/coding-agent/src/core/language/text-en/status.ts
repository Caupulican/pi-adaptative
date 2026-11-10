/**
 * The English lines of the operator's status: what the session is doing, why, and what comes next, as the host writes
 * them when no worker or goal text says it better. The operator bar and the work panel show them.
 */

export const STATUS = {
	/** No goal and nothing running. */
	ready: "Ready for operator instructions",
	/** A goal that exists and is not executing; `status` is the goal's own status word. */
	dormantGoal: (status: string) => `Objective ${status.replace("_", " ")}`,
	framing: (goal: string) => `Framing ${goal}`,
	decomposing: (goal: string | undefined) => `Decomposing ${goal ?? "the objective"}`,
	implementing: "Implementing",
	operatorTurn: "Working the operator's turn",
	adapting: "Adapting the runtime",
	fastIteration: "fast iteration · targeted validation",
	runningProof: "Running acceptance proof",
	delivering: "Delivering authorized changes",
	completed: (goal: string | undefined) => `Completed ${goal ?? "the objective"}`,
	working: "Working",
	/** Why the session is idle. */
	standingBy: "Standing by for user directives",
	criteriaSatisfied: (satisfied: number, total: number) => `${satisfied}/${total} acceptance criteria satisfied`,
	deliveredWith: (satisfied: number, total: number) => `Delivered with ${satisfied}/${total} criteria satisfied`,
	advancing: "Advancing the objective",
	/** What comes after the current phase. */
	nextVerify: (pending: number) => (pending > 0 ? `verify ${pending} open criteria` : "verify"),
	nextDeliver: "deliver",
	rootActor: "Root orchestrator",
	workerActor: (shortId: string) => `Worker ${shortId}`,
};
