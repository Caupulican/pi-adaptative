/** Mounts the human Workbench or the deliberately unattended transcript, and owns the Workbench state; owns no session lifecycle. */
import path from "node:path";
import type { AssistantMessage } from "@caupulican/pi-ai";
import type { Container, EditorComponent, TUI } from "@caupulican/pi-tui";
import { APP_NAME } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { readCiStatusView } from "../../core/ci-status-view.ts";
import { expandMessageTextForDisplay } from "../../core/context/path-alias-display.ts";
import type { ReadonlyFooterDataProvider } from "../../core/footer-data-contract.ts";
import { subscribeHumanInputActivity } from "../../core/human-input-activity.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { FlowTrace } from "../../core/operator-projection/flow-trace.ts";
import type { WorkbenchSettings } from "../../core/settings/settings-schema.ts";
import type { TaskStepStatus } from "../../core/tasks/task-state.ts";
import type { AgentMessage } from "../../kernel/index.ts";
import type { SessionManager } from "../../kernel/node.ts";
import { copyToClipboard, readClipboardText } from "../../utils/clipboard.ts";
import { type ActivityLaneComponent, isBackgroundToolActivityItem } from "./components/activity-lane.ts";
import {
	buildDecisionGraphModel,
	type DecisionGraphInput,
	type DecisionGraphModel,
	type DecisionPlanStepStatus,
} from "./components/decision-graph-model.ts";
import { type FooterComponent, formatCwdForFooter } from "./components/footer.ts";
import { OperatorPovBarComponent } from "./components/operator-pov-bar.ts";
import { isConversationMessage } from "./components/question-conversation.ts";
import { WorkbenchComponent } from "./components/workbench.ts";
import type { ExtensionUiHost } from "./extension-ui-host.ts";
import { WorkbenchController } from "./workbench-controller.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface InteractiveLayoutSettingsSource {
	getWorkbenchSettings(): Required<WorkbenchSettings>;
	setWorkbenchSetting<K extends keyof WorkbenchSettings>(key: K, value: Required<WorkbenchSettings>[K]): void;
	setWorkbenchSettings(values: Partial<Required<WorkbenchSettings>>): void;
}

/** What the layout needs from the interactive host; everything else it owns itself. */
export interface InteractiveLayoutPort {
	readonly hasHumanAudience: boolean;
	readonly ui: TUI;
	readonly headerContainer: Container;
	readonly chatContainer: Container;
	readonly editorContainer: Container;
	readonly pendingMessagesContainer: Container;
	readonly statusContainer: Container;
	readonly widgetContainerAbove: Container;
	readonly widgetContainerBelow: Container;
	readonly footer: FooterComponent;
	/** Branch and location for the title strip; the footer reads the same provider. */
	readonly footerDataProvider: ReadonlyFooterDataProvider;
	readonly activityLane: ActivityLaneComponent | undefined;
	readonly keybindings: KeybindingsManager;
	readonly extensionUiHost: Pick<ExtensionUiHost, "renderWidgets">;
	readonly activeToolCalls: { readonly size: number; hasActive(toolCallId: string): boolean };
	getSession(): AgentSession;
	getSessionManager(): SessionManager;
	getEditor(): EditorComponent;
	getSettings(): InteractiveLayoutSettingsSource;
	getStreamingMessage(): AssistantMessage | undefined;
}

/** Active obligations are unresolved open work, not a failed requirement branch. */
export function graphChecksFromVerificationObligations(
	obligations: ReadonlyArray<{ id: string; command?: string }>,
): DecisionGraphInput["checks"] {
	return obligations.map((obligation) => ({
		text: obligation.command ?? obligation.id,
		status: "pending",
	}));
}

const PLAN_STEP_STATUS: Readonly<Record<TaskStepStatus, DecisionPlanStepStatus>> = {
	pending: "pending",
	in_progress: "active",
	completed: "done",
	blocked: "blocked",
	cancelled: "cancelled",
};

/** Questions asked in the current objective, as the graph's YOU node counts them. */
export interface HumanInputTally {
	objectiveId?: string;
	question?: string;
	askedAt?: number;
	asked: number;
	answered: number;
}

/**
 * Owns the mounted Workbench and everything that follows it: its input listener, the session listeners
 * that feed the Decision graph, the flow trace and the question tally. Only this class writes them; the
 * interactive host reads the workbench through `workbench` and tears the rest down through `dispose`.
 */
export class InteractiveLayout {
	private readonly port: InteractiveLayoutPort;
	/** What actually happened in the session, recorded where it happens; the graph views draw from it. */
	private readonly flowTrace = new FlowTrace();
	/** Questions asked in the current objective; survives a session rebind so the graph's YOU node keeps its counts. */
	private readonly humanInputTally: HumanInputTally = { asked: 0, answered: 0 };
	private workbenchController: WorkbenchController | undefined;
	private workbenchInputCleanup: (() => void) | undefined;
	/** Unsubscribes every session listener the layout holds; set when the layout mounts or rebinds. */
	private disposeOperatorProjection: (() => void) | undefined;

	constructor(port: InteractiveLayoutPort) {
		this.port = port;
	}

	get workbench(): WorkbenchController | undefined {
		return this.workbenchController;
	}

	/**
	 * The Decision graph's model, composed per frame from the session's own live state: the operator
	 * projection and its stage log, the System One ledger, the router's foreground snapshot, lane records, the
	 * task's steps and the goal's requirements (what it needs), verification obligations (what it must
	 * pass), the cycle's receipts and the lane's background tools. Nothing here is a second state machine.
	 */
	private composeDecisionGraph(): DecisionGraphModel {
		const session = this.port.getSession();
		const humanInput = this.humanInputTally;
		const now = Date.now();
		const projection = session.operatorProjection.getProjection();
		if (humanInput.objectiveId !== projection.objective_id) {
			humanInput.objectiveId = projection.objective_id;
			humanInput.asked = 0;
			humanInput.answered = 0;
		}
		const task = session.getTaskStepsStateSnapshot();
		const goal = session.getGoalStateSnapshot();
		const plan: DecisionGraphInput["plan"] = task
			? task.steps.map((step) => ({ title: step.content, status: PLAN_STEP_STATUS[step.status] }))
			: (goal?.requirements ?? []).map((requirement) => ({
					title: requirement.text,
					status:
						requirement.status === "satisfied"
							? "done"
							: requirement.status === "blocked"
								? "blocked"
								: "pending",
				}));
		const checks: DecisionGraphInput["checks"] = [
			...(task && goal
				? goal.requirements.map((requirement) => ({
						text: requirement.text,
						status:
							requirement.status === "satisfied"
								? ("satisfied" as const)
								: requirement.status === "blocked"
									? ("failed" as const)
									: ("pending" as const),
					}))
				: []),
			...graphChecksFromVerificationObligations(session.getVerificationObligations()),
		];
		const peerFindings: NonNullable<DecisionGraphInput["peerFindings"]> = session
			.getSemanticVerificationObligations()
			.map(({ id, reason, scope }) => ({ id, reason, scope }));
		const idlePreparation = session.getIdlePreparationView();
		return buildDecisionGraphModel({
			projection,
			stageLog: session.operatorProjection.getStageLog(now),
			health: session.getSemanticPlaneHealth(),
			evaluations: session.getSemanticEvaluations(),
			route: session.getForegroundRouteSnapshot(),
			lanes: session.getLaneRecords(),
			plan,
			checks,
			peerFindings,
			receipts: this.workbenchController?.evidenceCounts() ?? { actions: 0, fileEffects: 0, failures: 0 },
			humanInput: {
				...(humanInput.question ? { question: humanInput.question } : {}),
				...(humanInput.askedAt !== undefined ? { askedAt: humanInput.askedAt } : {}),
				asked: humanInput.asked,
				answered: humanInput.answered,
			},
			events: session.operatorProjection.getVisibleEvents(),
			flow: this.flowTrace.snapshot(),
			...(idlePreparation ? { idlePreparation } : {}),
			backgroundTools: (this.port.activityLane?.getItems() ?? []).flatMap((item) =>
				isBackgroundToolActivityItem(item) && item.status !== "success" && item.status !== "failure"
					? [{ name: item.label, ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}) }]
					: [],
			),
			nowMs: now,
		});
	}

	private restoreSemanticViews(): void {
		if (!this.workbenchController) return;
		for (const record of this.port.getSession().getSemanticEvaluations()) {
			this.workbenchController.recordSystemOneEvaluation(record);
			this.flowTrace.observeEvaluation(record);
		}
	}

	/**
	 * The layout's session listeners: projection publishes, stage-log transitions, settled System One
	 * evaluations and questions to the operator. Bound to the host's session as it is now, so the host
	 * calls `rebindSession` after it swaps the session (resume, new session), which disposes the previous
	 * set first; `mount` calls this once.
	 */
	private subscribe(): void {
		this.disposeOperatorProjection?.();
		const port = this.port;
		const session = port.getSession();
		const unsubscribeOperatorProjection = session.operatorProjection.subscribe(() => port.ui.requestRender());
		// The stage log fires on every transition; the graph pane's timers and lit stage follow it.
		const unsubscribeStageChange = session.operatorProjection.onStageChange(() => port.ui.requestRender());
		// The flow trace belongs to the session it records: a swapped session starts its own.
		const flow = this.flowTrace;
		flow.reset();
		const unsubscribeFlow = session.subscribe((event) => flow.observe(event));
		flow.observeLanes(session.getLaneRecords());
		const unsubscribeLanes = session.onLaneRecordsChanged((records) => {
			flow.observeLanes(records);
			port.ui.requestRender();
		});
		// Every settled System One evaluation is Execution evidence and changes the Decider row and the graph.
		const unsubscribeSemantic = session.onSemanticEvaluation((record) => {
			this.workbenchController?.recordSystemOneEvaluation(record);
			flow.observeEvaluation(record);
			port.ui.requestRender();
		});
		this.restoreSemanticViews();
		const humanInput = this.humanInputTally;
		const unsubscribeHumanInput = subscribeHumanInputActivity(port.getSessionManager(), (activity) => {
			flow.observeQuestion(activity);
			if (activity.phase === "waiting") {
				humanInput.asked++;
				humanInput.question = activity.request.questions[0]?.question;
				humanInput.askedAt = Date.parse(activity.request.createdAt) || Date.now();
			} else {
				humanInput.answered++;
				humanInput.question = undefined;
				humanInput.askedAt = undefined;
			}
			port.ui.requestRender();
		});
		this.disposeOperatorProjection = () => {
			unsubscribeOperatorProjection();
			unsubscribeStageChange();
			unsubscribeSemantic();
			unsubscribeHumanInput();
			unsubscribeFlow();
			unsubscribeLanes();
			port.activityLane?.setExternalClock("decision-graph", false);
			this.disposeOperatorProjection = undefined;
		};
	}

	/** Rebinds the layout's session listeners to the host's current session; a layout that never mounted has none. */
	rebindSession(): void {
		if (this.workbenchController) this.subscribe();
	}

	/** Releases the session listeners, the input listener and the workbench. */
	dispose(): void {
		this.disposeOperatorProjection?.();
		this.workbenchInputCleanup?.();
		this.workbenchInputCleanup = undefined;
		this.workbenchController?.dispose();
	}

	mount(): void {
		const port = this.port;
		if (!port.hasHumanAudience) {
			for (const child of [port.headerContainer, port.chatContainer, port.editorContainer]) port.ui.addChild(child);
			return;
		}
		port.extensionUiHost.renderWidgets();
		// One status row when the width allows; the status band should use the width, not stack.
		port.footer.setCompact(true);
		port.footer.setOperatorFooter(true);
		// The POV bar reads the session's own live state on every render: the projection, the router's
		// foreground snapshot, the semantic plane's observed health and the cost summary. Its idle state
		// is that state with no objective, not a literal written here.
		const operatorStatus = new OperatorPovBarComponent({
			getProjection: () => port.getSession().operatorProjection.getProjection(),
			getRouteSnapshot: () => port.getSession().getForegroundRouteSnapshot(),
			getSemanticPlaneHealth: () => port.getSession().getSemanticPlaneHealth(),
			getCostSummary: () => port.getSession().getCostSummary(),
			getSessionWorkState: () => port.getSession().getSessionWorkState(),
			getSelfCompactionView: () => port.getSession().getSelfCompactionView(),
			getCiStatus: () => readCiStatusView(port.getSessionManager().getCwd()),
			getPeerFindingCount: () => port.getSession().getSemanticVerificationObligations().length,
		});
		this.subscribe();
		const view = new WorkbenchComponent({
			conversation: port.chatContainer,
			editor: port.editorContainer,
			header: port.headerContainer,
			activity: port.activityLane,
			operatorStatus,
			brand: APP_NAME,
			title: () => port.getSessionManager().getSessionName() || path.basename(port.getSessionManager().getCwd()),
			cwd: () => {
				const location = formatCwdForFooter(
					port.getSessionManager().getCwd(),
					process.env.HOME || process.env.USERPROFILE,
				);
				const branch = port.footerDataProvider.getGitBranch();
				return branch ? `${location} (${branch})` : location;
			},
			dock: [port.pendingMessagesContainer, port.statusContainer, port.widgetContainerAbove, port.footer],
			dockBelow: [port.widgetContainerBelow],
			viewportRows: () => port.ui.terminal.rows,
		});
		this.workbenchController = new WorkbenchController(view, {
			keybindings: port.keybindings,
			isInteractive: () => !port.ui.hasOverlay() && port.editorContainer.children[0] === port.getEditor(),
			requestRender: () => port.ui.requestRender(),
			messages: function* (): IterableIterator<AgentMessage> {
				let sawStreaming = false;
				const session = port.getSession();
				const aliases = session.peekPathAliasTable();
				for (const entry of port.getSessionManager().getBranch()) {
					if (entry.type !== "message" || !isConversationMessage(entry.message)) continue;
					const message = entry.message;
					if (
						message === port.getStreamingMessage() ||
						(message.role === "assistant" && message.timestamp === port.getStreamingMessage()?.timestamp)
					)
						sawStreaming = true;
					yield expandMessageTextForDisplay(aliases, message);
				}
				const streamingMessage = port.getStreamingMessage();
				if (streamingMessage && !sawStreaming) yield expandMessageTextForDisplay(aliases, streamingMessage);
			},
			copy: copyToClipboard,
			notice: (text, error) => port.activityLane?.announce(text, error ? "failure" : "neutral"),
			previewLimit: () => port.getSettings().getWorkbenchSettings().previews,
			semanticEvaluations: () => port.getSession().getSemanticEvaluations(),
			activeForegroundCount: () => {
				const handedOff = new Set(
					port.activityLane
						?.getItems()
						.flatMap((item) =>
							isBackgroundToolActivityItem(item) &&
							item.toolCallId &&
							port.activeToolCalls.hasActive(item.toolCallId)
								? [item.toolCallId]
								: [],
						),
				);
				return port.activeToolCalls.size - handedOff.size;
			},
			activeBackgroundCount: () => port.activityLane?.getItems().filter(isBackgroundToolActivityItem).length ?? 0,
			// The terminal owns the mouse unless the operator hands it over; the choice persists.
			mouse: {
				enabled: () => port.getSettings().getWorkbenchSettings().mouse === "on",
				set: (enabled) => {
					port.getSettings().setWorkbenchSetting("mouse", enabled ? "on" : "off");
					port.ui.terminal.setMouseTracking?.(enabled);
				},
			},
			// Only the operator changes the work area; what they chose last time is where it starts.
			geometry: { save: (geometry) => port.getSettings().setWorkbenchSettings(geometry) },
			graph: () => this.composeDecisionGraph(),
			// A foreground receipt is the root's, on the model actually answering; the running worker
			// (which may be `active_actors[0]`) never produces foreground receipts.
			attribution: () => {
				const route = port.getSession().getForegroundRouteSnapshot();
				return { kind: "root", label: "root", modelRef: route.activeModel ?? route.rootModel ?? undefined };
			},
			team: () => ({
				projection: port.getSession().operatorProjection.getProjection(),
				health: port.getSession().getSemanticPlaneHealth(),
				last: port.getSession().getSemanticEvaluations().at(-1),
				route: port.getSession().getForegroundRouteSnapshot(),
				lanes: port.getSession().getLaneRecords(),
			}),
			clock: (running) => port.activityLane?.setExternalClock("decision-graph", running),
			paste: async () => {
				const text = await readClipboardText();
				if (!text) {
					port.activityLane?.announce("Clipboard has no text to paste", "neutral");
					return;
				}
				if (typeof port.ui.pasteText === "function" && port.ui.pasteText(text)) return;
				const editor = port.getEditor();
				if (!editor.insertTextAtCursor) {
					port.activityLane?.announce("This editor cannot take a pasted selection", "failure");
					return;
				}
				editor.insertTextAtCursor(text);
				port.ui.requestRender();
			},
		});
		this.restoreSemanticViews();
		const stored = port.getSettings().getWorkbenchSettings();
		view.setMouseMode(stored.mouse === "on");
		view.applyGeometry(stored);
		this.workbenchInputCleanup = port.ui.addInputListener((data) => this.workbenchController?.handleInput(data));
		port.ui.addChild(view);
	}
}
