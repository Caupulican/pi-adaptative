/**
 * The words of the workbench panes: every pane title, the title buttons and chips, the section names the inspector
 * heads, the empty states, the status line under the input, and the Chats & Teams roster's names, badges and counts.
 */

import type { WorkbenchGraphView } from "../../../core/settings/settings-schema.ts";

/** The owner's name for each way of drawing the Decision graph. */
const GRAPH_VIEW: Readonly<Record<WorkbenchGraphView, string>> = {
	list: "List",
	diagram: "Diagram",
	lanes: "Lanes",
};

/** The pull request's state as a word; a state this build does not name is drawn as the data spells it. */
const PULL_REQUEST_STATE: Readonly<Record<string, string>> = {
	open: "open",
	merged: "merged",
	closed: "closed",
};

export const PANES = {
	conversation: "Conversation",
	/** Shown beside the conversation's name once the reader has scrolled away from the latest turn. */
	reading: "Reading",
	execution: "Execution",
	graphTitle: "Decision graph",
	chats: "Chats",
	graphView: (view: WorkbenchGraphView) => GRAPH_VIEW[view],
	graphChip: (view: string) => `Graph (${view})`,
	/** The inspector's section names, by the section's identity. */
	sections: {
		plan: "Work plan",
		orchestration: "Orchestration",
		checks: "Checks",
		peerFindings: "Peer findings",
	},
	hide: "Hide",
	showPlan: "Show plan",
	maximize: "Maximize",
	restore: "Restore",
	followCurrent: "Follow current",
	showChats: "Show chats",
	showGraph: "Show graph",
	stacked: "Stacked",
	latest: "Latest ↓",
	expand: "expand",
	modal: "Modal",
	/** Newer rows wait below a pane the operator pinned: the meta says so. */
	newRows: "new",
	noAgents: "No agents",
	noOpenSteps: "No open steps",
	/** Why a wheel does nothing in the workbench: the terminal owns the mouse. */
	terminalMouse: "terminal mouse",
	pullRequestState: (state: string) => PULL_REQUEST_STATE[state] ?? state,
	roster: {
		/** The root chat's name in the roster; the Orchestration panel's business is its model and state. */
		root: "Brain",
		/** A group header says how many it holds, or offers the command that fills it while it is empty. */
		teams: (count: number) => (count === 0 ? " TEAMS · /team create" : ` TEAMS (${count})`),
		bots: (count: number) => (count === 0 ? " BOTS · /bot new <id>" : ` BOTS (${count})`),
		leader: "leader",
		remote: "remote",
		workers: (running: number, waiting: number, total: number) =>
			` WORKERS · ${running} running${waiting > 0 ? ` · ${waiting} waiting` : ""}${total > running + waiting ? ` · ${total} in all` : ""}`,
		hint: "Click row to resume · @id to msg",
		/** The pane's meta: how many bots and teams the roster lists. */
		meta: (bots: number, teams: number) =>
			`${bots} bot${bots === 1 ? "" : "s"}${teams > 0 ? ` · ${teams} team${teams === 1 ? "" : "s"}` : ""}`,
	},
};
