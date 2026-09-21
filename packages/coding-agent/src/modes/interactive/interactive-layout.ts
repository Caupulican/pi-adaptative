/** Mounts the human Workbench or the deliberately unattended transcript; owns no session lifecycle. */
import path from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";
import type { Container, EditorComponent, TUI } from "@caupulican/pi-tui";
import { APP_NAME } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { expandMessageTextForDisplay } from "../../core/context/path-alias-display.ts";
import type { ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { subscribeHumanInputActivity } from "../../core/human-input-activity.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { TaskStepStatus } from "../../core/tasks/task-state.ts";
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

export interface InteractiveLayoutHost {
	hasHumanAudience: boolean;
	ui: TUI;
	session: AgentSession;
	headerContainer: Container;
	chatContainer: Container;
	editorContainer: Container;
	editor: EditorComponent;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	widgetContainerAbove: Container;
	widgetContainerBelow: Container;
	footer: FooterComponent;
	/** Branch and location for the title strip; the footer reads the same provider. */
	footerDataProvider: ReadonlyFooterDataProvider;
	activityLane?: ActivityLaneComponent;
	keybindings: KeybindingsManager;
	settingsManager: Pick<SettingsManager, "getWorkbenchSettings" | "setWorkbenchSetting" | "setWorkbenchSettings">;
	extensionUiHost: Pick<ExtensionUiHost, "renderWidgets">;
	streamingMessage?: AssistantMessage;
	workbench?: WorkbenchController;
	workbenchInputCleanup?: () => void;
	activeToolCalls: { readonly size: number; hasActive(toolCallId: string): boolean };
	/** Unsubscribes every session listener the layout holds; set when the layout mounts or rebinds. */
	disposeOperatorProjection?: () => void;
	/** Questions asked in the current objective; survives a session rebind so the graph's YOU node keeps its counts. */
	humanInputTally?: HumanInputTally;
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
 * The Decision graph's model, composed per frame from the session's own live state: the operator
 * projection and its stage log, the Jev ledger, the router's foreground snapshot, lane records, the
 * task's steps and the goal's requirements (what it needs), verification obligations (what it must
 * pass), the cycle's receipts and the lane's background tools. Nothing here is a second state machine.
 */
function composeDecisionGraph(host: InteractiveLayoutHost, humanInput: HumanInputTally): DecisionGraphModel {
	const session = host.session;
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
					requirement.status === "satisfied" ? "done" : requirement.status === "blocked" ? "blocked" : "pending",
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
	return buildDecisionGraphModel({
		projection,
		stageLog: session.operatorProjection.getStageLog(now),
		health: session.getSemanticPlaneHealth(),
		evaluations: session.getSemanticEvaluations(),
		route: session.getForegroundRouteSnapshot(),
		lanes: session.getLaneRecords(),
		plan,
		checks,
		receipts: host.workbench?.evidenceCounts() ?? { actions: 0, fileEffects: 0, failures: 0 },
		humanInput: {
			...(humanInput.question ? { question: humanInput.question } : {}),
			...(humanInput.askedAt !== undefined ? { askedAt: humanInput.askedAt } : {}),
			asked: humanInput.asked,
			answered: humanInput.answered,
		},
		events: session.operatorProjection.getVisibleEvents(),
		backgroundTools: (host.activityLane?.getItems() ?? []).flatMap((item) =>
			isBackgroundToolActivityItem(item) && item.status !== "success" && item.status !== "failure"
				? [{ name: item.label, ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}) }]
				: [],
		),
		nowMs: now,
	});
}

/**
 * The layout's session listeners: projection publishes, stage-log transitions, settled Jev
 * evaluations and questions to the operator. Bound to `host.session` as it is now, so the mode
 * calls this again after it swaps the session (resume, new session) and disposes the previous set
 * first; `mountInteractiveLayout` calls it once at mount.
 */
export function subscribeInteractiveLayout(host: InteractiveLayoutHost): HumanInputTally {
	host.disposeOperatorProjection?.();
	const session = host.session;
	const unsubscribeOperatorProjection = session.operatorProjection.subscribe(() => host.ui.requestRender());
	// The stage log fires on every transition; the graph pane's timers and lit stage follow it.
	const unsubscribeStageChange = session.operatorProjection.onStageChange(() => host.ui.requestRender());
	// Every settled Jev evaluation is Execution evidence and changes the Decider row and the graph.
	const unsubscribeSemantic = session.onSemanticEvaluation((record) => {
		host.workbench?.recordJevEvaluation(record);
		host.ui.requestRender();
	});
	const humanInput: HumanInputTally = host.humanInputTally ?? { asked: 0, answered: 0 };
	host.humanInputTally = humanInput;
	const unsubscribeHumanInput = subscribeHumanInputActivity(session.sessionManager, (activity) => {
		if (activity.phase === "waiting") {
			humanInput.asked++;
			humanInput.question = activity.request.questions[0]?.question;
			humanInput.askedAt = Date.parse(activity.request.createdAt) || Date.now();
		} else {
			humanInput.answered++;
			humanInput.question = undefined;
			humanInput.askedAt = undefined;
		}
		host.ui.requestRender();
	});
	host.disposeOperatorProjection = () => {
		unsubscribeOperatorProjection();
		unsubscribeStageChange();
		unsubscribeSemantic();
		unsubscribeHumanInput();
		host.activityLane?.setExternalClock("decision-graph", false);
		host.disposeOperatorProjection = undefined;
	};
	return humanInput;
}

export function mountInteractiveLayout(host: InteractiveLayoutHost): void {
	if (!host.hasHumanAudience) {
		for (const child of [host.headerContainer, host.chatContainer, host.editorContainer]) host.ui.addChild(child);
		return;
	}
	host.extensionUiHost.renderWidgets();
	// One status row when the width allows; the status band should use the width, not stack.
	host.footer.setCompact(true);
	host.footer.setOperatorFooter(true);
	// The POV bar reads the session's own live state on every render: the projection, the router's
	// foreground snapshot, the semantic plane's observed health and the cost summary. Its idle state
	// is that state with no objective, not a literal written here.
	const operatorStatus = new OperatorPovBarComponent({
		getProjection: () => host.session.operatorProjection.getProjection(),
		getRouteSnapshot: () => host.session.getForegroundRouteSnapshot(),
		getSemanticPlaneHealth: () => host.session.getSemanticPlaneHealth(),
		getCostSummary: () => host.session.getCostSummary(),
	});
	const humanInput = subscribeInteractiveLayout(host);
	const view = new WorkbenchComponent({
		conversation: host.chatContainer,
		editor: host.editorContainer,
		header: host.headerContainer,
		activity: host.activityLane,
		operatorStatus,
		brand: APP_NAME,
		title: () => host.session.sessionManager.getSessionName() || path.basename(host.session.sessionManager.getCwd()),
		cwd: () => {
			const location = formatCwdForFooter(
				host.session.sessionManager.getCwd(),
				process.env.HOME || process.env.USERPROFILE,
			);
			const branch = host.footerDataProvider.getGitBranch();
			return branch ? `${location} (${branch})` : location;
		},
		dock: [host.pendingMessagesContainer, host.statusContainer, host.widgetContainerAbove, host.footer],
		dockBelow: [host.widgetContainerBelow],
		viewportRows: () => host.ui.terminal.rows,
	});
	host.workbench = new WorkbenchController(view, {
		keybindings: host.keybindings,
		isInteractive: () => !host.ui.hasOverlay() && host.editorContainer.children[0] === host.editor,
		requestRender: () => host.ui.requestRender(),
		messages: function* (): IterableIterator<AgentMessage> {
			let sawStreaming = false;
			const aliases = host.session.peekPathAliasTable();
			for (const entry of host.session.sessionManager.getBranch()) {
				if (entry.type !== "message" || !isConversationMessage(entry.message)) continue;
				const message = entry.message;
				if (
					message === host.streamingMessage ||
					(message.role === "assistant" && message.timestamp === host.streamingMessage?.timestamp)
				)
					sawStreaming = true;
				yield expandMessageTextForDisplay(aliases, message);
			}
			if (host.streamingMessage && !sawStreaming) yield expandMessageTextForDisplay(aliases, host.streamingMessage);
		},
		copy: copyToClipboard,
		notice: (text, error) => host.activityLane?.announce(text, error ? "failure" : "neutral"),
		previewLimit: () => host.session.settingsManager.getWorkbenchSettings().previews,
		activeForegroundCount: () => {
			const handedOff = new Set(
				host.activityLane
					?.getItems()
					.flatMap((item) =>
						isBackgroundToolActivityItem(item) &&
						item.toolCallId &&
						host.activeToolCalls.hasActive(item.toolCallId)
							? [item.toolCallId]
							: [],
					),
			);
			return host.activeToolCalls.size - handedOff.size;
		},
		activeBackgroundCount: () => host.activityLane?.getItems().filter(isBackgroundToolActivityItem).length ?? 0,
		// The terminal owns the mouse unless the operator hands it over; the choice persists.
		mouse: {
			enabled: () => host.settingsManager.getWorkbenchSettings().mouse === "on",
			set: (enabled) => {
				host.settingsManager.setWorkbenchSetting("mouse", enabled ? "on" : "off");
				host.ui.terminal.setMouseTracking?.(enabled);
			},
		},
		// Only the operator changes the work area; what they chose last time is where it starts.
		geometry: { save: (geometry) => host.settingsManager.setWorkbenchSettings(geometry) },
		graph: () => composeDecisionGraph(host, host.humanInputTally ?? humanInput),
		// A foreground receipt is the root's, on the model actually answering; the running worker
		// (which may be `active_actors[0]`) never produces foreground receipts.
		attribution: () => {
			const route = host.session.getForegroundRouteSnapshot();
			return { kind: "root", label: "root", modelRef: route.activeModel ?? route.rootModel ?? undefined };
		},
		team: () => ({
			projection: host.session.operatorProjection.getProjection(),
			health: host.session.getSemanticPlaneHealth(),
			last: host.session.getSemanticEvaluations().at(-1),
			route: host.session.getForegroundRouteSnapshot(),
			lanes: host.session.getLaneRecords(),
		}),
		clock: (running) => host.activityLane?.setExternalClock("decision-graph", running),
		paste: async () => {
			const text = await readClipboardText();
			if (!text) {
				host.activityLane?.announce("Clipboard has no text to paste", "neutral");
				return;
			}
			if (typeof host.ui.pasteText === "function" && host.ui.pasteText(text)) return;
			if (!host.editor.insertTextAtCursor) {
				host.activityLane?.announce("This editor cannot take a pasted selection", "failure");
				return;
			}
			host.editor.insertTextAtCursor(text);
			host.ui.requestRender();
		},
	});
	const stored = host.settingsManager.getWorkbenchSettings();
	view.setMouseMode(stored.mouse === "on");
	view.applyGeometry(stored);
	host.workbenchInputCleanup = host.ui.addInputListener((data) => host.workbench?.handleInput(data));
	host.ui.addChild(view);
}
