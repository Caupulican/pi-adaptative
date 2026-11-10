/**
 * The English words of the work inspector behind the activity lane: its panel labels, the sections its rows sit under,
 * the counts in its summary line and its footer keys. The status word of a row is an identifier the panel decides on, so
 * it is not translated here; the words around it are.
 */

export const AGENTS_OVERLAY = {
	/** The work inspector's own panel. */
	agents: "Agents",
	work: "Work",
	/** The slim preview the workbench draws in place of the full inspector. */
	compact: "Work / Team",
	emptyAgents: "No agents or background work right now",
	emptyWork: "No goal, plan, agents, or background work right now",
	unnamedTask: "Unnamed task",
	kindManaged: "managed",
	kindAgent: "agent",
	reason: (reason: string) => `reason: ${reason}`,
	started: (time: string) => `started: ${time}`,
	completed: (time: string) => `completed: ${time}`,
	running: (count: number) => `${count} running`,
	queued: (count: number) => `${count} queued`,
	idle: (count: number) => `${count} idle`,
	backgroundToolCount: (count: number) => `${count} background tool${count === 1 ? "" : "s"}`,
	goal: (status: string) => `goal ${status}`,
	requirements: (satisfied: number, total: number) => `${satisfied}/${total} requirements`,
	plans: (count: number) => `${count} plan${count === 1 ? "" : "s"}`,
	taskStepCount: (count: number) => `${count} task steps`,
	peerFindingCount: (count: number) => `${count} peer finding${count === 1 ? "" : "s"}`,
	more: (count: number) => `+${count} more`,
	total: (count: number) => `${count} total`,
	scope: (scope: string) => `scope: ${scope}`,
	aboutOutcome: "about: an outcome",
	aboutRepository: "about: the repository",
	finished: (count: number) => `${count} finished`,
	scrollHint: "scroll",
	pageHint: "page",
	jumpHint: "jump",
	switchChatHint: "switch chat",
	closeHint: "close",
};
