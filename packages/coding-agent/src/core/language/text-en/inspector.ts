/**
 * The words of the workbench's inspector: the plan and team blocks it builds, the headings a group of rows sits under,
 * the state words, counts and hints of those rows, and the group names of the team hierarchy.
 */

import type { FixedSectionId } from "../../tools/orchestration-panel.ts";
import { PANES } from "./panes.ts";

export const INSPECTOR = {
	/** The words of a heading, by the identity rows are grouped and compared by. */
	heading: {
		requirements: "Requirements",
		evidence: "Evidence",
		taskSteps: "Task steps",
		peerFindings: "Peer findings",
		workers: "Workers",
		backgroundTools: "Background tools",
	} satisfies Record<FixedSectionId, string>,
	/** The team hierarchy's group names, top down. */
	group: {
		brain: "Brain",
		decider: "Decider",
		workers: "Workers",
		leaders: "Leaders",
		routing: "Routing",
	},
	systemOne: "System One",
	judging: (label: string, elapsed: string) => `judging ${label} ${elapsed}`,
	lastJudgment: (label: string) => `last: ${label}`,
	ready: "ready",
	decidesNext: "decides next",
	waitingForYou: "waiting for you",
	/** The root executor's row: who answers. */
	root: "brain",
	forRoot: "for root",
	forActor: (name: string) => `for ${name}`,
	requirements: (satisfied: number, total: number) => `${satisfied} / ${total} requirements`,
	workComplete: (steps: number) => `Work complete · ${steps} steps`,
	noOpenSteps: PANES.noOpenSteps,
	activeTime: (duration: string) => `${duration} active`,
	rounds: (count: number) => `${count} ${count === 1 ? "round" : "rounds"}`,
	more: (count: number) => `+${count} more`,
	failing: (count: number) => `${count} failing`,
	checkHint: "rerun the same check, or /verify dismiss",
	activeFindings: (count: number) => `${count} active`,
	findingHint: "answer with evidence, or /verification waive <id|all> <reason>",
	executorsRunning: (count: number) => `${count} running`,
	executorsIdle: "idle",
	noWorkersRunning: "No workers running",
};
