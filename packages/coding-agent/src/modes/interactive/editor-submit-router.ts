/**
 * Routes each editor submission to its handler. The branches run in a fixed order and the first match decides: empty input,
 * quit, the operator and goal commands, the queue while a turn is live, the built-in commands, bash, and finally a plain
 * prompt. The mode builds the EditorSubmitHost port; the order is part of the contract.
 */
import type { ImageContent } from "@caupulican/pi-ai";
import { formatSessionAutonomyStatus } from "../../core/autonomy-status/format.ts";
import { type OwnerTextRange, trimOwnerWords } from "../../core/learning/owner-evidence-ledger.ts";
import { namedPlanViews } from "../../core/plan/plan-views-named.ts";
import { latestProofSheet } from "../../core/proof/review-gauge.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import { keyText } from "../../presentation/keybinding-hints.ts";
import type { AuthDialogsController } from "./auth-dialogs-controller.ts";
import type { BotTeamChatController } from "./bot-team-chat-controller.ts";
import { handleEdgeCommand } from "./edge-commands.ts";
import { handleFastModeCommand } from "./fast-mode-command.ts";
import { handleKnowledgeCommand } from "./knowledge-commands.ts";
import { handleLeadCommand } from "./leader-commands.ts";
import { handleEstopCommand, handleLoadCommand } from "./load-commands.ts";
import { handleMemoryCommand } from "./memory-commands.ts";
import { handlePlanCommand } from "./plan-commands.ts";
import * as proactivityCommands from "./proactivity-commands.ts";
import type { QueuedMessageController, QueuedMessageHost, UserInputSubmission } from "./queued-message-controller.ts";
import { handleQuizCommand } from "./quiz-commands.ts";
import * as reportCommands from "./report-commands.ts";
import * as sessionFlows from "./session-flow-commands.ts";
import type { SlashCommandController, SlashCommandHost } from "./slash-command-controller.ts";
import { handleVerificationCommand } from "./verification-commands.ts";
import { handleVerifyCommand } from "./verify-commands.ts";

export interface EditorSubmitHost extends SlashCommandHost, QueuedMessageHost {
	readonly authDialogs: AuthDialogsController;
	readonly botTeamChat: BotTeamChatController;
	isBashMode: boolean;
	handleAutonomyCommand(text: string): void;
	handleAutoLearnCommand(text: string): void;
	handleModelsCommand(argsText: string): Promise<void>;
	showFitnessModelSelector(): void;
	showSettingsSelector(initialItemId?: string): void;
	showUserMessageSelector(newSessionName?: string): void;
	showTreeSelector(initialSelectedId?: string): void;
	showTrustSelector(): void;
	showSessionSelector(): void;
	shutdown(options?: { fromSignal?: boolean }): Promise<void>;
	takeClipboardImagesForText(text: string): ImageContent[] | undefined;
	updateEditorBorderColor(): void;
	buildUserInputSubmission(text: string): UserInputSubmission;
	deliverUserInput(submission: UserInputSubmission): void;
}

export class EditorSubmitRouter {
	private readonly host: EditorSubmitHost;
	private readonly slashCommands: SlashCommandController;
	private readonly queue: QueuedMessageController;

	constructor(host: EditorSubmitHost, slashCommands: SlashCommandController, queue: QueuedMessageController) {
		this.host = host;
		this.slashCommands = slashCommands;
		this.queue = queue;
	}

	/** Routes one submitted editor text; the first matching branch below decides. */
	async route(text: string, pasted?: readonly OwnerTextRange[]): Promise<void> {
		// `pasted` follows `text` through every transform below: the owner evidence records which words were pasted.
		({ text, pasted } = trimOwnerWords({ text, pasted }));
		if (!text) {
			// Enter on an empty editor while a message waits behind the running turn: the second
			// Enter means "stop and take it now", the one gesture Escape-then-retype used to be.
			const workState = this.host.session.getSessionWorkState();
			if (
				(workState.busy || this.host.session.isStreaming || this.host.session.isRetrying) &&
				this.queue.hasQueuedMessages()
			)
				await this.queue.sendQueuedMessagesNow();
			return;
		}

		if (text === "/quit" || text === "/exit") {
			this.host.editor.setText("");
			await this.host.shutdown();
			return;
		}

		// A ">>" prefix queues the message as a follow-up (delivered after the
		// current work finishes, starting the next round) instead of steering.
		// This is the chord-free alternative to app.message.followUp, which many
		// terminals swallow (e.g. Windows Terminal claims alt+enter).
		const queueAsFollowUp = text.startsWith(">>");
		if (queueAsFollowUp) {
			({ text, pasted } = trimOwnerWords({ text, pasted }, 2));
			if (!text) return;
		}

		if (
			await sessionFlows.tryHandleGoalEditorSubmit(text, queueAsFollowUp, {
				session: this.host.session,
				editor: this.host.editor,
				handleGoalCommand: (input) => this.slashCommands.handleGoalCommand(input),
				showError: (message) => this.host.showError(message),
			})
		)
			return;

		// Operator-only commands act on the host, never on the model: they run locally even while
		// the model is working, instead of being queued as steering text for it to read.
		if (text === "/verify" || text.startsWith("/verify ")) {
			this.host.editor.setText("");
			await handleVerifyCommand(this.slashCommands.verifyHost(), text);
			return;
		}
		if (text === "/plan" || text.startsWith("/plan ")) {
			this.host.editor.setText("");
			const ledger = this.host.session.backgroundLanes.getTaskRuntimeSnapshot();
			handlePlanCommand(
				{
					listPlans: () => namedPlanViews(ledger, this.host.runtimeHost.services.agentDir),
					getGoalStateSnapshot: () => this.host.session.getGoalStateSnapshot(),
					...this.slashCommands.operatorCommandOutput(),
				},
				text,
			);
			return;
		}
		if (text === "/quiz" || text.startsWith("/quiz ")) {
			this.host.editor.setText("");
			await handleQuizCommand(
				{
					latestProofSheet: () => latestProofSheet(this.host.sessionManager.getBranch()),
					...(this.host.hasHumanAudience
						? {
								askQuestions: (request) =>
									this.host.extensionUiHost.createExtensionUIContext().askQuestions(request),
							}
						: {}),
					...this.slashCommands.operatorCommandOutput(),
				},
				text,
			);
			return;
		}
		if (text === "/memory" || text.startsWith("/memory ")) {
			this.host.editor.setText("");
			await handleMemoryCommand(this.slashCommands.memoryCommandHost(), text);
			return;
		}
		if (text === "/knowledge" || text.startsWith("/knowledge ")) {
			this.host.editor.setText("");
			await handleKnowledgeCommand(
				{ session: this.host.session, ...this.slashCommands.operatorCommandOutput() },
				text,
			);
			return;
		}
		if (text === "/edge" || text.startsWith("/edge ")) {
			this.host.editor.setText("");
			await handleEdgeCommand(this.slashCommands.edgeHost(), text);
			return;
		}
		if (text === "/load" || text.startsWith("/load ")) {
			this.host.editor.setText("");
			await handleLoadCommand(this.slashCommands.loadHost(), text);
			return;
		}
		if (text === "/verification" || text.startsWith("/verification ")) {
			this.host.editor.setText("");
			await handleVerificationCommand(this.slashCommands.verificationHost(), text);
			return;
		}
		if (text === "/estop" || text.startsWith("/estop ")) {
			this.host.editor.setText("");
			await handleEstopCommand(this.slashCommands.loadHost(), text);
			return;
		}
		if (text === "/chat" || text.startsWith("/chat ")) {
			this.host.editor.addToHistory?.(text);
			this.host.editor.setText("");
			await this.host.botTeamChat.handleChatCommand(text);
			return;
		}
		if (text === "/remote" || text.startsWith("/remote ")) {
			this.host.editor.addToHistory?.(text);
			this.host.editor.setText("");
			await this.host.botTeamChat.handleRemoteCommand(text);
			return;
		}
		if (text === "/bot" || text.startsWith("/bot ") || text === "/bots" || text.startsWith("/bots ")) {
			this.host.editor.addToHistory?.(text);
			this.host.editor.setText("");
			await this.host.botTeamChat.handleBotCommand(text);
			return;
		}
		if (text === "/team" || text.startsWith("/team ") || text === "/teams" || text.startsWith("/teams ")) {
			this.host.editor.addToHistory?.(text);
			this.host.editor.setText("");
			await this.host.botTeamChat.handleTeamCommand(text);
			return;
		}
		if (!text.startsWith("/") && !text.startsWith("!")) {
			const intercepted = await this.host.botTeamChat.tryInterceptSubmission(text);
			if (intercepted) {
				this.host.editor.addToHistory?.(text);
				this.host.editor.setText("");
				return;
			}
			({ text, pasted } = trimOwnerWords({ text, pasted }, this.host.botTeamChat.rootAddressBodyStart(text)));
		}

		// Other input submitted during work is steering. Slash/bang text must not execute
		// commands that would interrupt the current stream or compaction, so it steers only while a
		// foreground turn is live; background work (a worker, a backgrounded tool, System One
		// checking an answer, an armed continuation) is nothing a command interrupts.
		const workState = this.host.session.getSessionWorkState();
		const isCommandText = text.startsWith("/") || text.startsWith("!");
		const foregroundTurnLive =
			this.host.session.isStreaming ||
			this.host.session.isCompacting ||
			this.host.session.isRetrying ||
			this.host.session.getForegroundActivity().epoch !== undefined;
		const builtin = queueAsFollowUp
			? undefined
			: BUILTIN_SLASH_COMMANDS.find(
					(command) => text === `/${command.name}` || text.startsWith(`/${command.name} `),
				);
		if (builtin && foregroundTurnLive && builtin.duringWork !== "local") {
			this.host.editor.setText(text, pasted);
			this.host.showWarning(
				`/${builtin.name} requires the foreground to be idle. ${keyText("app.interrupt")} interrupts it; your command stays in the editor.`,
			);
			return;
		}
		if (!builtin && workState.busy && (!isCommandText || foregroundTurnLive)) {
			const images = this.host.takeClipboardImagesForText(text);
			this.host.editor.addToHistory?.(text, pasted);
			this.host.editor.setText("");
			if (this.host.session.isCompacting) {
				this.queue.queueCompactionMessage(text, queueAsFollowUp ? "followUp" : "steer", images, pasted);
				this.queue.updatePendingMessagesDisplay();
				this.host.ui.requestRender();
				return;
			}
			try {
				await this.host.session.prompt(text, {
					streamingBehavior: queueAsFollowUp ? "followUp" : "steer",
					images,
					pasted,
					processSlashCommands: false,
				});
			} finally {
				this.host.refreshAutonomyFooterStatus();
			}
			this.queue.updatePendingMessagesDisplay();
			this.host.ui.requestRender();
			return;
		}

		// Handle commands
		if (text === "/settings") {
			this.host.showSettingsSelector();
			this.host.editor.setText("");
			return;
		}
		if (text === "/secrets") {
			this.host.editor.setText("");
			await this.slashCommands.handleSecretsCommand();
			return;
		}
		if (text === "/auto-learn" || text.startsWith("/auto-learn ")) {
			this.host.handleAutoLearnCommand(text);
			this.host.editor.setText("");
			return;
		}
		if (text === "/autonomy" || text.startsWith("/autonomy ")) {
			this.host.handleAutonomyCommand(text);
			this.host.editor.setText("");
			return;
		}
		if (text === "/lead" || text.startsWith("/lead ")) {
			this.host.editor.setText("");
			await handleLeadCommand(
				{
					session: this.host.session,
					showStatus: (message) => this.host.showStatus(message),
					showError: (message) => this.host.showError(message),
				},
				text,
			);
			return;
		}
		if (text === "/proactivity" || text.startsWith("/proactivity ")) {
			proactivityCommands.handleProactivityCommand(
				{
					session: this.host.session,
					settingsManager: this.host.settingsManager,
					showStatus: (message) => this.host.showStatus(message),
				},
				text,
			);
			this.host.editor.setText("");
			return;
		}

		if (text === "/fitness" || text.startsWith("/fitness ")) {
			const fitnessArgs = text.slice("/fitness".length).trim();
			this.host.editor.setText("");
			if (fitnessArgs.length === 0) {
				// No args: open the model picker, probe the selection, then offer role assignment.
				this.host.showFitnessModelSelector();
			} else {
				// Explicit ref: same handler as /autonomy fitness.
				this.host.handleAutonomyCommand(`/autonomy fitness ${fitnessArgs}`);
			}
			return;
		}
		if (text === "/models" || text.startsWith("/models ")) {
			void this.host.handleModelsCommand(text.slice("/models".length).trim());
			this.host.editor.setText("");
			return;
		}
		if (text === "/context") {
			this.host.showStatus(this.host.session.formatContextCompositionDashboard());
			this.host.editor.setText("");
			return;
		}
		if (text === "/status") {
			this.host.editor.setText("");
			this.host.showStatus(formatSessionAutonomyStatus(await this.host.session.autonomyStatus()));
			return;
		}
		if (text === "/sysprompt" || text.startsWith("/sysprompt ")) {
			this.host.editor.setText("");
			await this.slashCommands.handleSystemPromptCommand(text);
			return;
		}
		if (text === "/soul" || text.startsWith("/soul ")) {
			this.host.editor.setText("");
			await this.slashCommands.handleSoulCommand(text);
			return;
		}
		if (text === "/toolhealth") {
			this.host.showStatus(this.host.session.formatToolRepairHealthReport());
			this.host.editor.setText("");
			return;
		}
		if (text === "/toolprobe" || text.startsWith("/toolprobe ")) {
			const target = text.slice("/toolprobe".length).trim();
			this.host.editor.setText("");
			this.host.showStatus("Running tool probe...");
			try {
				const report = await this.host.session.probeToolCalling(target || undefined);
				this.host.showStatus(report.table);
			} catch (error: unknown) {
				this.host.showWarning(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (text.startsWith("/toolrule-remove")) {
			const [model, mode] = text.slice("/toolrule-remove".length).trim().split(/\s+/, 2);
			const message =
				model && mode
					? this.host.session.removeToolRepairRule(model, mode)
						? `Removed tool repair rule ${mode} for ${model}.`
						: `No tool repair rule ${mode} found for ${model}.`
					: "Usage: /toolrule-remove <provider/model> <mode>";
			this.host.showStatus(message);
			this.host.editor.setText("");
			return;
		}
		if (text.startsWith("/toolprotocol-reset")) {
			const model = text.slice("/toolprotocol-reset".length).trim();
			const message = model
				? this.host.session.resetToolProtocolCalibration(model)
					? `Reset text tool protocol calibration for ${model}.`
					: `No text tool protocol calibration found for ${model}.`
				: "Usage: /toolprotocol-reset <provider/model>";
			this.host.showStatus(message);
			this.host.editor.setText("");
			return;
		}
		if (text === "/scoped-models") {
			this.host.editor.setText("");
			await this.slashCommands.showModelsSelector();
			return;
		}
		if (text === "/fast" || text.startsWith("/fast ") || text === "/ultrafast" || text.startsWith("/ultrafast ")) {
			handleFastModeCommand(
				{
					session: {
						model: this.host.session.model,
						settingsManager: this.host.settingsManager,
						getFastModeCatalog: (model) => this.host.session.getFastModeCatalog(model),
					},
					showStatus: (message) => this.host.showStatus(message),
				},
				text,
			);
			this.host.editor.setText("");
			this.host.footer.invalidate();
			return;
		}
		if (text === "/model" || text.startsWith("/model ")) {
			const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
			this.host.editor.setText("");
			await this.slashCommands.handleModelCommand(searchTerm);
			return;
		}
		if (text === "/thinking" || text.startsWith("/thinking ")) {
			const levelArg = text.startsWith("/thinking ") ? text.slice(10).trim() : undefined;
			this.host.editor.setText("");
			await this.slashCommands.handleThinkingCommand(levelArg);
			return;
		}
		if (text === "/profiles" || text.startsWith("/profiles ")) {
			const rawProfileName = text.startsWith("/profiles ") ? text.slice(10).trim() : undefined;
			this.host.editor.setText("");
			await this.slashCommands.handleProfilesCommand(rawProfileName?.length ? rawProfileName : undefined);
			return;
		}
		if (text === "/export" || text.startsWith("/export ")) {
			await this.slashCommands.handleExportCommand(text);
			this.host.editor.setText("");
			return;
		}
		if (text === "/import" || text.startsWith("/import ")) {
			await this.slashCommands.handleImportCommand(text);
			this.host.editor.setText("");
			return;
		}
		if (text === "/share") {
			await this.slashCommands.handleShareCommand();
			this.host.editor.setText("");
			return;
		}
		if (text === "/copy") {
			await this.slashCommands.handleCopyCommand();
			this.host.editor.setText("");
			return;
		}
		if (text === "/name" || text.startsWith("/name ")) {
			this.slashCommands.handleNameCommand(text);
			this.host.editor.setText("");
			return;
		}
		if (text === "/session") {
			this.slashCommands.handleSessionCommand();
			this.host.editor.setText("");
			return;
		}
		if (text === "/usage" || text.startsWith("/usage ")) {
			this.slashCommands.handleUsageMenuCommand(text);
			this.host.editor.setText("");
			return;
		}
		if (text === "/cost") {
			this.slashCommands.handleUsageCommand();
			this.host.editor.setText("");
			return;
		}
		if (text === "/task" || text.startsWith("/task ") || text === "/steps" || text.startsWith("/steps ")) {
			this.slashCommands.handleTaskCommand(text);
			this.host.editor.setText("");
			return;
		}
		if (text === "/goal-continue" || text.startsWith("/goal-continue ")) {
			await this.slashCommands.handleGoalContinueCommand(text);
			this.host.editor.setText("");
			return;
		}
		if (text === "/changelog") {
			this.slashCommands.handleChangelogCommand();
			this.host.editor.setText("");
			return;
		}
		if (text === "/hotkeys") {
			this.slashCommands.handleHotkeysCommand();
			this.host.editor.setText("");
			return;
		}
		if (text === "/fork" || text.startsWith("/fork ")) {
			this.host.showUserMessageSelector(text.slice("/fork".length).trim() || undefined);
			this.host.editor.setText("");
			return;
		}
		if (text === "/clone" || text.startsWith("/clone ")) {
			this.host.editor.setText("");
			await this.slashCommands.handleCloneCommand(text.slice("/clone".length).trim() || undefined);
			return;
		}
		if (text === "/tree") {
			this.host.showTreeSelector();
			this.host.editor.setText("");
			return;
		}
		if (text === "/trust") {
			this.host.showTrustSelector();
			this.host.editor.setText("");
			return;
		}
		if (text === "/login" || text.startsWith("/login ")) {
			await this.host.authDialogs.showOAuthSelector("login", text.slice("/login".length).trim() || undefined);
			this.host.editor.setText("");
			return;
		}
		if (text === "/logout" || text.startsWith("/logout ")) {
			await this.host.authDialogs.showOAuthSelector("logout", text.slice("/logout".length).trim() || undefined);
			this.host.editor.setText("");
			return;
		}
		if (text === "/new" || text.startsWith("/new ")) {
			this.host.editor.setText("");
			await this.slashCommands.handleClearCommand(text.slice("/new".length).trim() || undefined);
			return;
		}
		if (text === "/self-compact-info") {
			this.host.editor.setText("");
			reportCommands.handleSelfCompactInfoCommand({
				session: this.host.session,
				chatContainer: this.host.chatContainer,
				ui: this.host.ui,
			});
			return;
		}
		if (text === "/self-compact-now") {
			this.host.editor.setText("");
			await this.slashCommands.handleSelfCompactNowCommand();
			return;
		}
		if (text === "/compact" || text.startsWith("/compact ")) {
			const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
			this.host.editor.setText("");
			await this.slashCommands.handleCompactCommand(customInstructions);
			return;
		}
		if (text === "/reload") {
			this.host.editor.setText("");
			await this.slashCommands.handleReloadCommand();
			return;
		}
		if (text === "/curate" || text.startsWith("/curate ")) {
			const args = text.slice("/curate".length).trim();
			this.host.editor.setText("");
			this.slashCommands.handleCurateCommand(args);
			return;
		}
		if (text === "/install-resources" || text.startsWith("/install-resources ")) {
			const args = text.slice("/install-resources".length).trim();
			this.host.editor.setText("");
			await this.slashCommands.handleInstallResourcesCommand(args);
			return;
		}
		if (text === "/config-backup" || text.startsWith("/config-backup ")) {
			const file = text.slice("/config-backup".length).trim() || undefined;
			this.host.editor.setText("");
			await this.slashCommands.handleConfigBackupCommand(file);
			return;
		}
		if (text === "/config-restore" || text.startsWith("/config-restore ")) {
			const file = text.slice("/config-restore".length).trim();
			this.host.editor.setText("");
			await this.slashCommands.handleConfigRestoreCommand(file);
			return;
		}
		if (text === "/debug") {
			this.slashCommands.handleDebugCommand();
			this.host.editor.setText("");
			return;
		}
		if (text === "/arminsayshi") {
			this.slashCommands.handleArminSaysHi();
			this.host.editor.setText("");
			return;
		}
		if (text === "/dementedelves") {
			this.slashCommands.handleDementedDelves();
			this.host.editor.setText("");
			return;
		}
		if (text === "/resume") {
			this.host.showSessionSelector();
			this.host.editor.setText("");
			return;
		}
		// Handle bash command (! for normal, !! for excluded from context)
		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (this.host.session.isBashRunning) {
					this.host.showWarning("A bash command is already running. Press Esc to cancel it first.");
					this.host.editor.setText(text, pasted);
					return;
				}
				this.host.editor.addToHistory?.(text, pasted);
				await this.slashCommands.handleBashCommand(command, isExcluded);
				this.host.isBashMode = false;
				this.host.updateEditorBorderColor();
				return;
			}
		}

		// Normal message submission
		// First, move any pending bash components to chat
		this.queue.flushPendingBashComponents();

		const submission = { ...this.host.buildUserInputSubmission(text), pasted };
		this.host.deliverUserInput(submission);
		this.host.editor.addToHistory?.(text, pasted);
	}
}
