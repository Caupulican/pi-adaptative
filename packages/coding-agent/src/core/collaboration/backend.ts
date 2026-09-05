/** Provider-neutral collaboration handles. The durable coordinator, not an adapter, owns turns. */
export type CollaborationAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface CollaborationPane {
	paneId: string;
	terminalId: string;
	workspaceId: string;
	tabId: string;
}

export interface CollaborationAgent extends CollaborationPane {
	name?: string;
	kind?: string;
	status: CollaborationAgentStatus;
	interactiveReady: boolean;
	launchPending: boolean;
	stateChangeSequence: number;
	/** Native agent metadata revision; only comparable to observations of this same agent. */
	revision: number;
	/** Bounded native blocked-question label, available independently of pane rendering. */
	question?: string;
}

export interface CollaborationWorkspace {
	workspaceId: string;
	tabId: string;
	rootPane: CollaborationPane;
}

export interface CollaborationLocation {
	cwd: string;
	env?: Readonly<Record<string, string>>;
}

export interface CollaborationStart {
	name: string;
	kind: string;
	paneId: string;
	args?: readonly string[];
	timeoutMs?: number;
	/** Explicit host-trusted wrapper command; caller must probe that same executable/environment. */
	command?: string;
	/** Structured wrapper launch; quoting belongs to the backend's managed shell adapter. */
	executable?: string;
}

export interface CollaborationPrompt {
	target: string;
	text: string;
	timeoutMs: number;
	/** Reject stale handoffs before writing to a replacement pane occupant. */
	terminalId?: string;
}

export interface CollaborationRead {
	paneId: string;
	text: string;
	truncated: boolean;
	/** Backend snapshot metadata, possibly an unversioned placeholder; not an agent revision. */
	revision: number;
}

export interface CollaborationQuestionAnswer {
	target: string;
	terminalId: string;
	text?: string;
	keys?: readonly string[];
	timeoutMs: number;
}

export interface CollaborationBackend {
	readonly id: string;
	readonly session: string;
	createWorkspace(input: CollaborationLocation & { label: string }): Promise<CollaborationWorkspace>;
	splitPane(
		input: CollaborationLocation & { paneId: string; direction?: "right" | "down" },
	): Promise<CollaborationPane>;
	startAgent(input: CollaborationStart): Promise<CollaborationAgent>;
	getAgent(target: string): Promise<CollaborationAgent>;
	listAgents(): Promise<CollaborationAgent[]>;
	prompt(input: CollaborationPrompt, signal?: AbortSignal): Promise<CollaborationAgent>;
	answerQuestion(input: CollaborationQuestionAnswer, signal?: AbortSignal): Promise<CollaborationAgent>;
	readAgent(target: string, lines?: number): Promise<CollaborationRead>;
	closePane(paneId: string): Promise<void>;
	closeWorkspace(workspaceId: string): Promise<void>;
	stopSession(): Promise<void>;
	notify(title: string, body: string): Promise<void>;
	reportMetadata(
		workspaceId: string,
		tokens: Readonly<Record<string, string | null>>,
		sequence: number,
	): Promise<void>;
}

export class CollaborationBackendError extends Error {
	readonly code: string;
	readonly delivery: "not-submitted" | "unknown";

	constructor(code: string, message: string, delivery: "not-submitted" | "unknown" = "unknown") {
		super(message);
		this.name = "CollaborationBackendError";
		this.code = code;
		this.delivery = delivery;
	}
}
