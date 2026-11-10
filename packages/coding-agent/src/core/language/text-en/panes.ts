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
	/** What the workbench's workspace pane says about what it observed, and when it could not observe. */
	workspace: {
		preview: "Workspace preview",
		unavailable:
			"Workspace observation unavailable or over budget; edit/write evidence remains visible. Requires a Git worktree.",
		limitedPaths: (count: number) => `Observation limited to ${count} dirty paths`,
		overlapped: "Initial snapshot overlapped execution; displayed workspace changes may predate this task",
		diffUnavailable: "Changes observed; diff unavailable or exceeds preview budget",
		failed: "Workspace observation failed; no claim of a clean workspace",
		cancelled: "Observation cancelled",
	},
	/** The marker a reloaded transcript row carries when only its tail fits the reload budget. */
	history: {
		omittedLines: (count: number) =>
			`[Earlier ${count} line${count === 1 ? "" : "s"} omitted from TUI reload history; full session remains available to the model.]`,
		omittedCharacters: (count: number) =>
			`[Earlier ${count} character${count === 1 ? "" : "s"} omitted from TUI reload history; full session remains available to the model.]`,
	},
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
	/** The execution preview's own words: what it says about the turn it draws, and what the copy keys report. */
	executionPane: {
		more: (count: number) => `  +${count} more`,
		currentDiff: "Current diff; may include earlier or concurrent edits",
		fileChanges: "file changes",
		files: (count: number) => `${count} ${count === 1 ? "file" : "files"}`,
		byWorkers: (count: number) => `+ ${count} ${count === 1 ? "worker" : "workers"}`,
		filesAndDiff: "files and diff",
		previousTurn: "Previous turn",
		failed: (count: number) => `${count} failed`,
		unknownEffects: (count: number) => `${count} with unknown effects`,
		unclassified: (count: number) => `${count} unclassified`,
		postprocessingFaults: (count: number) => `${count} postprocessing faults`,
		conflictingReceipts: (count: number) => `${count} conflicting receipts`,
		earlierErrorResults: (count: number) => `${count} earlier error results kept`,
		mouseUnavailable: "This terminal has no mouse to hand over",
		mouseWorkbench:
			"Workbench owns the mouse: wheel scrolls, drag copies on release, drag edges to resize, click titles to hide or maximize, right click pastes",
		mouseTerminal: "Terminal owns the mouse: native selection and paste; no wheel scrolling",
		copyNoConversation: "No conversation to copy yet",
		copySelectFirst: "Select conversation text first",
		copyConversation: "Copied full conversation",
		copySelection: "Copied selection",
	},
	/** The words the python tool draws for its own run. */
	python: {
		codeLabel: "code",
		running: "python running",
		done: "python done",
		ok: "python ok",
		exit: (code: number | null | undefined) => `python exit ${code ?? "unknown"}`,
		fullOutput: (path: string) => `full output: ${path}`,
	},
};
